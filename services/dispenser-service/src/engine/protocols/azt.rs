use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use site_config::{FuelingPositionConfig, SiteConfig};
use sqlx::SqlitePool;
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing::{debug, info, warn};
use types::{
    preset_label, FpStatus, Preset, PumpNozzleTotals, StopSource, Transaction, TxStatus, WsEvent,
};

use super::shared::{
    active_positions_by_byte, broadcast_status, exchange_serial, preset_metadata, SerialBackend,
};
use crate::engine::poll_loop::DispatchCommand;
use crate::engine::state::{CurrentTx, PreAuthContext, RuntimeFp};
use crate::shifts::ShiftCoordinator;

const AZT_REACTIVE_AUTHORIZE_START_TIMEOUT_MS: i64 = 15_000;

// ── AZT 2.0 (ОАО АЗТ) poll loop ──────────────────────────────────────────────
//
// SU-driven protocol: the control system sets price + dose, authorizes, polls
// live volume, reads final data, and confirms the totals write. One hose per
// network address (`address_byte & 0x0F`, 1..=15).
//
// Reached only when `cfg.connection.protocol` is `Protocol::Azt20` (exhaustive
// match in `run_poll_loop`), so it cannot affect the Wayne or Gilbarco paths.
//
// Transaction cycle (спец. разд. 7.20 примечание / разд. 8):
//   status '0'/'1' → set price 'Q' → set dose 'T'/'S' → authorize '2'
//   → status '2' (armed) → '3' dispensing (live volume via '4')
//   → status '4'+reason → full data '5' → persist + sync + shift
//   → confirm totals '8' → status '0'/'1'.
//
// Stops are terminal (site policy): Stop sends reset '3', the pump lands in
// '4', and the close path records the partial sale.

/// Maximum dose on the wire: 990.00 L (§7.13), in 0.01 L units.
const AZT_MAX_DOSE_CL: u64 = 99_000;
/// Regional wire-unit convention (same as Gilbarco's `LIVE_AMOUNT_SCALE_SOUM`):
/// 1 wire "kopeck" = 10 soum. Real sites print the integer part of the wire's
/// two-decimal money format — 100 000 soum rides as `10000` and prints as
/// "100"; a price of 11 300 soum/L rides the 4-digit §7.10 field as `1130`.
const AZT_WIRE_UNIT: u64 = 10;
/// §7.10 price field is 4 wire digits → 9 999 × 10 = 99 990 soum/L max.
const AZT_MAX_PRICE: u32 = 9_999 * AZT_WIRE_UNIT as u32;
/// §7.12 dose-by-amount field is 6 wire digits → 9 999 990 soum max.
const AZT_MAX_AMOUNT: u64 = 999_999 * AZT_WIRE_UNIT;
const AZT_RESET_CLOSE_RETRIES: usize = 5;
const AZT_RESET_CLOSE_RETRY_DELAY_MS: u64 = 750;

pub(in crate::engine) async fn run(
    mut cfg: Arc<SiteConfig>,
    backend: SerialBackend,
    runtimes: Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    mut disp_by_byte: HashMap<u8, FuelingPositionConfig>,
    events: broadcast::Sender<WsEvent>,
    mut commands: mpsc::Receiver<DispatchCommand>,
    pool: SqlitePool,
    shifts: Arc<ShiftCoordinator>,
) {
    let mut addrs: Vec<u8> = cfg.active_addresses();
    let mut interval = tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Per-address digit widths for the '5' full-data frame, learned via the '7'
    // type query (§7.7). Queried lazily and cached; a close cannot run without it.
    let mut trk_types: HashMap<u8, azt::TrkType> = HashMap::new();
    let mut pending_startup_totals: HashMap<u8, u8> = addrs.iter().map(|&a| (a, 2)).collect();

    info!(?addrs, "AZT 2.0 poll loop started");

    'poll_loop: loop {
        while let Ok(cmd) = commands.try_recv() {
            if let DispatchCommand::ReloadConfig { cfg: next_cfg } = cmd {
                info!("AZT poll loop reloaded site config");
                cfg = next_cfg;
                disp_by_byte = active_positions_by_byte(&cfg);
                addrs = cfg.active_addresses();
                pending_startup_totals = addrs.iter().map(|&a| (a, 2)).collect();
                interval = tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                continue 'poll_loop;
            }
            azt_apply_command(
                &cfg,
                &runtimes,
                &events,
                &backend,
                cmd,
                &pool,
                &shifts,
                &mut trk_types,
            )
            .await;
        }

        for byte in addrs.clone() {
            interval.tick().await;
            while let Ok(cmd) = commands.try_recv() {
                if let DispatchCommand::ReloadConfig { cfg: next_cfg } = cmd {
                    info!("AZT poll loop reloaded site config");
                    cfg = next_cfg;
                    disp_by_byte = active_positions_by_byte(&cfg);
                    addrs = cfg.active_addresses();
                    pending_startup_totals = addrs.iter().map(|&a| (a, 2)).collect();
                    interval =
                        tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    continue 'poll_loop;
                }
                azt_apply_command(
                    &cfg,
                    &runtimes,
                    &events,
                    &backend,
                    cmd,
                    &pool,
                    &shifts,
                    &mut trk_types,
                )
                .await;
            }

            azt_poll_card(
                byte,
                &cfg,
                &backend,
                &runtimes,
                &disp_by_byte,
                &events,
                &pool,
                &shifts,
                &mut trk_types,
                &mut pending_startup_totals,
            )
            .await;

            // A lane with a sale in flight must not wait a full rotation while
            // idle cards sweep all their hose addresses: service every other
            // busy card between slots so its live counter keeps moving. Each
            // busy card is polled at most once per slot, so with every card
            // busy this decays to plain round-robin (no extra bus traffic).
            let busy: Vec<u8> = {
                let map = runtimes.read().await;
                addrs
                    .iter()
                    .copied()
                    .filter(|&b| b != byte)
                    .filter(|b| {
                        map.get(b)
                            .map(|rt| {
                                matches!(
                                    rt.state.status,
                                    FpStatus::Authorizing
                                        | FpStatus::Delivering
                                        | FpStatus::PreAuthorized
                                        | FpStatus::Stopped { .. }
                                ) || rt.current_tx.is_some()
                            })
                            .unwrap_or(false)
                    })
                    .collect()
            };
            for b in busy {
                azt_poll_card(
                    b,
                    &cfg,
                    &backend,
                    &runtimes,
                    &disp_by_byte,
                    &events,
                    &pool,
                    &shifts,
                    &mut trk_types,
                    &mut pending_startup_totals,
                )
                .await;
            }
        }
    }
}

/// Poll one pump card once: resolve its active hose, dispatch on the reported
/// status and broadcast the resulting lane state. Called from the poll
/// rotation for every card, and again between slots for cards with a sale in
/// flight, so a live counter never waits out the idle cards' hose sweeps.
#[allow(clippy::too_many_arguments)]
async fn azt_poll_card(
    byte: u8,
    cfg: &SiteConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    disp_by_byte: &HashMap<u8, FuelingPositionConfig>,
    events: &broadcast::Sender<WsEvent>,
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
    trk_types: &mut HashMap<u8, azt::TrkType>,
    pending_startup_totals: &mut HashMap<u8, u8>,
) {
    use azt::AztStatus;

    let fp_cfg = match disp_by_byte.get(&byte) {
        Some(x) => x,
        None => return,
    };

    // Resolve which hose of this pump card is active and poll it. `net`
    // is that hose's RS-485 address; `active_nozzle` its 1-based index.
    let Some((net, active_nozzle, status)) =
        azt_resolve_active(byte, fp_cfg, &backend, &runtimes).await
    else {
        let went_offline = {
            let mut map = runtimes.write().await;
            map.get_mut(&byte)
                .map(|rt| rt.on_poll_missed(cfg.polling.offline_threshold_polls))
                .unwrap_or(false)
        };
        if went_offline {
            let _ = events.send(WsEvent::Offline {
                fp_id: fp_cfg.id.clone(),
                label: fp_cfg.label.clone(),
            });
        }
        broadcast_status(byte, runtimes, events).await;
        return;
    };

    {
        let mut map = runtimes.write().await;
        if let Some(rt) = map.get_mut(&byte) {
            rt.on_poll_success();
        }
    }

    match status {
        AztStatus::Unknown => {
            let went_offline = {
                let mut map = runtimes.write().await;
                map.get_mut(&byte)
                    .map(|rt| rt.on_poll_missed(cfg.polling.offline_threshold_polls))
                    .unwrap_or(false)
            };
            if went_offline {
                let _ = events.send(WsEvent::Offline {
                    fp_id: fp_cfg.id.clone(),
                    label: fp_cfg.label.clone(),
                });
            }
        }

        AztStatus::OffHolstered | AztStatus::OffLifted => {
            let lifted = status == AztStatus::OffLifted;

            // Pump idle while we believed a sale was running: the pump was
            // reset/cleared out-of-band. Try to salvage the sale data ('5'
            // is answered in every status), then idle the lane.
            let was_active = {
                let map = runtimes.read().await;
                map.get(&byte)
                    .map(|rt| {
                        matches!(
                            rt.state.status,
                            FpStatus::Delivering | FpStatus::Authorizing
                        )
                    })
                    .unwrap_or(false)
            };
            if was_active {
                warn!(
                    net,
                    "AZT: pump idle during active sale — closing out-of-band"
                );
                azt_close_transaction(
                    byte, fp_cfg, backend, cfg, runtimes, events, pool, shifts, trk_types,
                )
                .await;
                return;
            }

            // Armed pre-auth but the pump no longer reports '2': arming was
            // lost (external reset / power cycle) — surface the cancel.
            let preauth_lost = {
                let map = runtimes.read().await;
                map.get(&byte)
                    .map(|rt| rt.state.status == FpStatus::PreAuthorized)
                    .unwrap_or(false)
            };
            if preauth_lost {
                warn!(net, "AZT: armed pre-auth lost on pump — cancelling");
                {
                    let mut map = runtimes.write().await;
                    if let Some(rt) = map.get_mut(&byte) {
                        rt.cancel_pre_auth();
                    }
                }
                let _ = events.send(WsEvent::PreAuthCancelled {
                    fp_id: fp_cfg.id.clone(),
                });
                broadcast_status(byte, runtimes, events).await;
                return;
            }

            if let Some(remaining) = pending_startup_totals.get_mut(&byte) {
                if *remaining > 0 {
                    let synced = azt_sync_totals(byte, fp_cfg, &backend, &runtimes).await;
                    if synced {
                        *remaining = 0;
                    } else {
                        *remaining -= 1;
                    }
                    // Learn the TRK type while the lane is quiet.
                    azt_trk_type(net, backend, trk_types);
                }
            }

            if lifted {
                // Nozzle up with no pending authorization → notify UI.
                // `active_nozzle` is the hose that reported lifted.
                let nozzle = active_nozzle;
                let (product_id, product_name) = azt_nozzle_product(fp_cfg, &cfg, nozzle);
                let price = {
                    let map = runtimes.read().await;
                    map.get(&byte)
                        .map(|rt| {
                            rt.nozzle_prices
                                .get(&nozzle)
                                .copied()
                                .unwrap_or(rt.state.price)
                        })
                        .unwrap_or_else(|| fp_cfg.default_price().unwrap_or(0))
                };
                let product_color = cfg
                    .product(product_id)
                    .map(|p| p.color.clone())
                    .unwrap_or_default();
                let should_emit = {
                    let mut map = runtimes.write().await;
                    if let Some(rt) = map.get_mut(&byte) {
                        let can_transition = matches!(
                            rt.state.status,
                            FpStatus::Idle | FpStatus::NozzleUp | FpStatus::Offline
                        );
                        let changed = can_transition
                            && (rt.state.status != FpStatus::NozzleUp
                                || rt.state.nozzle_index != Some(nozzle));
                        rt.state.nozzle_index = Some(nozzle);
                        rt.state.product_id = Some(product_id);
                        rt.state.product_name = Some(product_name.clone());
                        rt.state.price = price;
                        if can_transition {
                            rt.state.status = FpStatus::NozzleUp;
                        }
                        changed
                    } else {
                        false
                    }
                };
                if should_emit {
                    let _ = events.send(WsEvent::NozzleUp {
                        fp_id: fp_cfg.id.clone(),
                        nozzle_index: nozzle,
                        product_id,
                        product_name,
                        product_color,
                        price,
                    });
                }
            } else {
                // Genuinely idle — clear lane state (Stopped stays until
                // the operator acts, mirroring the Gilbarco path).
                let became_idle = {
                    let mut map = runtimes.write().await;
                    if let Some(rt) = map.get_mut(&byte) {
                        let was = rt.state.status.clone();
                        if !matches!(rt.state.status, FpStatus::Stopped { .. }) {
                            rt.state.status = FpStatus::Idle;
                            rt.state.volume = 0.0;
                            rt.state.amount = 0;
                            rt.state.nozzle_index = None;
                            rt.state.pre_auth_preset = None;
                            rt.current_tx = None;
                            rt.pre_auth = None;
                        }
                        rt.note_dispenser_poll(true);
                        was != FpStatus::Idle && rt.state.status == FpStatus::Idle
                    } else {
                        false
                    }
                };
                if became_idle {
                    broadcast_status(byte, &runtimes, &events).await;
                }
            }
        }

        AztStatus::Authorized => {
            // Pump armed. Keep PreAuthorized lanes as-is (operator armed a
            // holstered pump: the customer has not lifted yet); everything
            // else shows Authorizing until fuel flows.
            let stale_reactive_auth = {
                let map = runtimes.read().await;
                map.get(&byte).and_then(|rt| {
                    let started = rt.auth_session_started_at?;
                    let elapsed = Utc::now().timestamp_millis().saturating_sub(started);
                    let stale = rt.state.status == FpStatus::Authorizing
                        && rt.pre_auth.is_none()
                        && rt.state.volume <= 0.0
                        && elapsed >= AZT_REACTIVE_AUTHORIZE_START_TIMEOUT_MS;
                    stale.then_some((elapsed, rt.state.nozzle_index))
                })
            };
            if let Some((elapsed_ms, nozzle_index)) = stale_reactive_auth {
                warn!(
                    net,
                    ?nozzle_index,
                    elapsed_ms,
                    "AZT: reactive authorize stayed in status 2 with no flow — resetting"
                );
                if azt_expect_ack(
                    net,
                    &azt::reset(net),
                    &backend,
                    "reactive_auth_timeout_reset",
                ) {
                    azt_expect_ack(
                        net,
                        &azt::confirm_totals(net),
                        &backend,
                        "reactive_auth_timeout_confirm",
                    );
                }
                {
                    let mut map = runtimes.write().await;
                    if let Some(rt) = map.get_mut(&byte) {
                        rt.state.status = FpStatus::Idle;
                        rt.state.volume = 0.0;
                        rt.state.amount = 0;
                        rt.state.pre_auth_preset = None;
                        rt.current_tx = None;
                        rt.pre_auth = None;
                        rt.pre_auth_started_at = None;
                        rt.auth_session_started_at = None;
                    }
                }
                broadcast_status(byte, runtimes, events).await;
                return;
            } else {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    if !matches!(
                        rt.state.status,
                        FpStatus::PreAuthorized | FpStatus::Authorizing
                    ) {
                        rt.state.status = FpStatus::Authorizing;
                    }
                }
            }
        }

        AztStatus::Dispensing => {
            // Live volume via '4' (0.01 L); amount derived from JIT price.
            let live = azt_query_data(net, &azt::current_data(net), &backend)
                .and_then(|d| azt::parse_current_data(&d));
            let mut map = runtimes.write().await;
            if let Some(rt) = map.get_mut(&byte) {
                let (pid, pname) = azt_nozzle_product(fp_cfg, &cfg, active_nozzle);
                let price = rt
                    .nozzle_prices
                    .get(&active_nozzle)
                    .copied()
                    .or_else(|| {
                        fp_cfg
                            .nozzles
                            .iter()
                            .find(|n| n.index == active_nozzle)
                            .map(|n| n.price)
                    })
                    .unwrap_or(rt.state.price);
                rt.state.status = FpStatus::Delivering;
                // Lock the card to the dispensing hose so later polls
                // stay on this nozzle's address.
                rt.state.nozzle_index = Some(active_nozzle);
                rt.state.product_id = Some(pid);
                rt.state.product_name = Some(pname.clone());
                rt.state.price = price;
                rt.auth_session_started_at = None;
                if let Some(cd) = live {
                    rt.state.volume = cd.volume_centilitres as f64 / 100.0;
                    rt.state.amount = (cd.volume_centilitres * rt.state.price as u64 + 50) / 100;
                }
                if rt.current_tx.is_none() {
                    rt.current_tx = Some(CurrentTx {
                        id: uuid::Uuid::new_v4().to_string(),
                        started_at: Utc::now().timestamp_millis(),
                        product_id: pid,
                        product_name: pname,
                        nozzle_index: active_nozzle,
                    });
                }
            }
        }

        AztStatus::Finished(reason) => {
            if reason == azt::FinishReason::Overfill {
                warn!(net, "AZT: pump reports overfill / unauthorized dispense");
            }
            let closeable = {
                let map = runtimes.read().await;
                map.get(&byte)
                    .map(|rt| {
                        matches!(
                            rt.state.status,
                            FpStatus::Delivering | FpStatus::Authorizing | FpStatus::Stopped { .. }
                        )
                    })
                    .unwrap_or(false)
            };
            if closeable {
                azt_close_transaction(
                    byte, fp_cfg, backend, cfg, runtimes, events, pool, shifts, trk_types,
                )
                .await;
            } else {
                // No sale of ours (cancelled arming, rejected local dose,
                // service restart after the fact): acknowledge so the pump
                // returns to idle, then clear the lane. If the ACK is
                // missed, keep the lane as-is and retry on the next poll;
                // otherwise the pump can remain stuck in '4' while the UI
                // has already moved on.
                let confirmed =
                    azt_expect_ack(net, &azt::confirm_totals(net), &backend, "confirm_totals");
                if !confirmed {
                    warn!(net, "AZT: confirm totals failed — retrying next poll");
                    return;
                }
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    if !matches!(rt.state.status, FpStatus::Stopped { .. }) {
                        rt.state.status = FpStatus::Idle;
                        rt.state.volume = 0.0;
                        rt.state.amount = 0;
                        rt.current_tx = None;
                        rt.pre_auth = None;
                    }
                }
            }
        }

        AztStatus::LocalPreset => {
            // Dose entered on the pump's local keypad (БМУ). This site is
            // app-controlled: reject it so the lane cannot start a sale the
            // backend never priced (§7.3: reset from '8' → '0'/'1').
            info!(net, "AZT: local (БМУ) dose rejected — app-controlled site");
            azt_expect_ack(net, &azt::reset(net), backend, "reset_local_dose");
        }
    }

    broadcast_status(byte, runtimes, events).await;
}

// ── AZT wire helpers ─────────────────────────────────────────────────────────

fn azt_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Send a request and decode the reply frame.
fn azt_exchange(net: u8, frame: &[u8], backend: &SerialBackend) -> Option<azt::Response> {
    let resp = exchange_serial(backend, frame).ok()?;
    if resp.is_empty() {
        return None;
    }
    let decoded = azt::decode_response(&resp);
    if decoded.is_none() {
        debug!(net, rx = %azt_hex(&resp), "AZT: undecodable response");
    }
    decoded
}

/// Send a status poll ('1') and decode. `None` = no/garbled response (offline).
fn azt_query_status(net: u8, backend: &SerialBackend) -> Option<azt::AztStatus> {
    match azt_exchange(net, &azt::status(net), backend)? {
        azt::Response::Data(d) => azt::parse_status(&d),
        // Short replies are never valid for a status poll.
        azt::Response::Short(_) => Some(azt::AztStatus::Unknown),
    }
}

/// The AZT hoses of one pump card as `(network address, nozzle index)`.
///
/// AZT puts each hose on its own RS-485 address, so a pump card groups several
/// nozzles at different addresses (`nozzle.azt_address`). A nozzle with no
/// explicit address (single-hose pumps) falls back to the position's
/// `address_byte`.
fn azt_fp_nozzles(fp_cfg: &FuelingPositionConfig) -> Vec<(u8, u8)> {
    let fallback = fp_cfg.address_byte;
    fp_cfg
        .active_nozzles()
        .iter()
        .map(|n| {
            let addr = if n.azt_address != 0 {
                n.azt_address
            } else {
                fallback
            };
            (addr, n.index)
        })
        .collect()
}

/// Whether a status means the hose is doing something the card should display.
fn azt_status_active(st: azt::AztStatus) -> bool {
    matches!(
        st,
        azt::AztStatus::OffLifted
            | azt::AztStatus::Authorized
            | azt::AztStatus::Dispensing
            | azt::AztStatus::Finished(_)
            | azt::AztStatus::LocalPreset
    )
}

/// Resolve the active hose for a pump card and poll its status.
///
/// Returns `(net, nozzle_index, status)`. While a sale/arm is in progress the
/// card stays on the nozzle it started (from `rt.state.nozzle_index`); otherwise
/// every hose address is polled and the first non-idle one wins (one nozzle
/// dispenses at a time). `None` means no hose answered → the card is offline.
async fn azt_resolve_active(
    byte: u8,
    fp_cfg: &FuelingPositionConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
) -> Option<(u8, u8, azt::AztStatus)> {
    let nozzles = azt_fp_nozzles(fp_cfg);
    if nozzles.is_empty() {
        return None;
    }

    // Mid-transaction: keep polling the nozzle the sale started on.
    let active_idx = {
        let map = runtimes.read().await;
        map.get(&byte).and_then(|rt| {
            let busy = matches!(
                rt.state.status,
                FpStatus::Authorizing
                    | FpStatus::Delivering
                    | FpStatus::PreAuthorized
                    | FpStatus::Stopped { .. }
            ) || rt.current_tx.is_some();
            if busy {
                rt.state.nozzle_index
            } else {
                None
            }
        })
    };
    if let Some(nidx) = active_idx {
        if let Some(&(addr, _)) = nozzles.iter().find(|(_, i)| *i == nidx) {
            let st = azt_query_status(addr, backend).unwrap_or(azt::AztStatus::Unknown);
            return Some((addr, nidx, st));
        }
    }

    // Idle: sweep every hose; first active wins, else first that responds at all.
    let mut idle_fallback: Option<(u8, u8, azt::AztStatus)> = None;
    for (addr, nidx) in nozzles {
        if let Some(st) = azt_query_status(addr, backend) {
            if azt_status_active(st) {
                return Some((addr, nidx, st));
            }
            if idle_fallback.is_none() {
                idle_fallback = Some((addr, nidx, st));
            }
        }
    }
    idle_fallback
}

/// Network address of a pump card's currently-selected nozzle (from runtime
/// `nozzle_index`), used by the close/stop paths.
fn azt_active_net(fp_cfg: &FuelingPositionConfig, nozzle_index: Option<u8>) -> u8 {
    let nozzles = azt_fp_nozzles(fp_cfg);
    nozzle_index
        .and_then(|nidx| nozzles.iter().find(|(_, i)| *i == nidx).map(|(a, _)| *a))
        .or_else(|| nozzles.first().map(|(a, _)| *a))
        .unwrap_or(fp_cfg.address_byte)
}

/// Send a data-query command and return the frame payload.
fn azt_query_data(net: u8, frame: &[u8], backend: &SerialBackend) -> Option<Vec<u8>> {
    match azt_exchange(net, frame, backend)? {
        azt::Response::Data(d) => Some(d),
        azt::Response::Short(c) => {
            debug!(
                net,
                code = format_args!("{c:02X}"),
                "AZT: short reply to data query"
            );
            None
        }
    }
}

/// Send a command and require an ACK. CAN/NAK/no-reply are logged and fail.
fn azt_expect_ack(net: u8, frame: &[u8], backend: &SerialBackend, action: &'static str) -> bool {
    match azt_exchange(net, frame, backend) {
        Some(azt::Response::Short(azt::ACK)) => true,
        Some(azt::Response::Short(code)) => {
            warn!(
                net,
                action,
                code = format_args!("{code:02X}"),
                "AZT: command refused"
            );
            false
        }
        Some(azt::Response::Data(d)) => {
            warn!(net, action, rx = %azt_hex(&d), "AZT: unexpected data reply");
            false
        }
        None => {
            warn!(net, action, "AZT: command got no response");
            false
        }
    }
}

/// Fetch (and cache) the TRK type for full-data digit widths (§7.7).
fn azt_trk_type(
    net: u8,
    backend: &SerialBackend,
    cache: &mut HashMap<u8, azt::TrkType>,
) -> Option<azt::TrkType> {
    if let Some(t) = cache.get(&net) {
        return Some(*t);
    }
    let t =
        azt_query_data(net, &azt::trk_type(net), backend).and_then(|d| azt::parse_trk_type(&d))?;
    info!(
        net,
        identifier = format_args!("{:02X}", t.identifier),
        volume_digits = t.volume_digits,
        price_digits = t.price_digits,
        cost_digits = t.cost_digits,
        "AZT: TRK type learned"
    );
    cache.insert(net, t);
    Some(t)
}

fn azt_nozzle_product(
    fp: &FuelingPositionConfig,
    cfg: &SiteConfig,
    nozzle_index: u8,
) -> (u8, String) {
    let product_id = fp
        .nozzles
        .iter()
        .find(|n| n.index == nozzle_index)
        .map(|n| n.product_id)
        .unwrap_or(0);
    let product_name = cfg
        .product(product_id)
        .map(|p| p.name.clone())
        .unwrap_or_default();
    (product_id, product_name)
}

/// Build the dose frame for an operator preset. Errors are human-readable
/// refusal reasons (logged, sale not started — mirrors the Gilbarco refusals).
fn azt_dose_frame(net: u8, preset: &Preset, price: u32) -> Result<Vec<u8>, &'static str> {
    match preset {
        Preset::Str(s) if s.eq_ignore_ascii_case("full") => {
            Ok(azt::set_dose_litres_full_tank(net, AZT_MAX_DOSE_CL as u32))
        }
        Preset::Volume(litres) if *litres > 0.0 => {
            let cl = (*litres * 100.0).round() as u64;
            if cl == 0 || cl > AZT_MAX_DOSE_CL {
                Err("volume preset outside 0.01–990.00 L")
            } else {
                Ok(azt::set_dose_litres(net, cl as u32))
            }
        }
        Preset::Amount(amount) if *amount > 0 => {
            if *amount > AZT_MAX_AMOUNT {
                Err("amount preset exceeds the 6-digit protocol field")
            } else if price == 0 {
                Err("amount preset with zero price")
            } else {
                // Soum → wire units (10-soum resolution; sub-unit soum dropped).
                Ok(azt::set_dose_rubles(net, (*amount / AZT_WIRE_UNIT) as u32))
            }
        }
        _ => Err("invalid preset"),
    }
}

/// Arm the pump: set price ('Q'), set dose ('T'/'S'), authorize ('2').
/// Every step requires an ACK; the price (÷10 → wire units) must fit the
/// 4-digit field (§7.10).
fn azt_arm(
    net: u8,
    price: u32,
    preset: &Preset,
    backend: &SerialBackend,
) -> Result<(), &'static str> {
    if price == 0 {
        return Err("zero price");
    }
    if price > AZT_MAX_PRICE {
        return Err("price exceeds the 4-digit protocol field (§7.10, wire = soum/10)");
    }
    if price % AZT_WIRE_UNIT as u32 != 0 {
        // 10-soum wire resolution: 11 305 soum/L would silently sell at 11 300.
        warn!(
            net,
            price, "AZT: price not a multiple of 10 soum — wire truncates"
        );
    }
    let dose = azt_dose_frame(net, preset, price)?;
    let wire_price = price / AZT_WIRE_UNIT as u32;
    if !azt_expect_ack(net, &azt::set_price(net, wire_price), backend, "set_price") {
        return Err("set_price refused");
    }
    if !azt_expect_ack(net, &dose, backend, "set_dose") {
        return Err("set_dose refused");
    }
    if !azt_expect_ack(net, &azt::authorize(net), backend, "authorize") {
        return Err("authorize refused");
    }
    Ok(())
}

/// Read the lifetime totalizer ('6') into the lane's pump-totals view.
async fn azt_sync_totals(
    byte: u8,
    fp_cfg: &FuelingPositionConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
) -> bool {
    // One totalizer read per hose on this pump card (each has its own address).
    let mut totals: Vec<PumpNozzleTotals> = Vec::new();
    for (addr, nozzle_index) in azt_fp_nozzles(fp_cfg) {
        if let Some((litres_cl, amount_wire)) =
            azt_query_data(addr, &azt::totals(addr), backend).and_then(|d| azt::parse_totals(&d))
        {
            let price = fp_cfg
                .active_nozzles()
                .iter()
                .find(|n| n.index == nozzle_index)
                .map(|n| n.price)
                .unwrap_or(0);
            totals.push(PumpNozzleTotals {
                nozzle_index,
                volume: litres_cl as f64 / 100.0,
                amount: amount_wire * AZT_WIRE_UNIT,
                price,
            });
        }
    }
    if totals.is_empty() {
        return false;
    }
    let mut map = runtimes.write().await;
    if let Some(rt) = map.get_mut(&byte) {
        let pick = totals
            .iter()
            .find(|t| Some(t.nozzle_index) == rt.state.nozzle_index)
            .or_else(|| totals.first());
        if let Some(t) = pick {
            rt.state.pump_total_nozzle_index = Some(t.nozzle_index);
            rt.state.pump_total_volume = Some(t.volume);
            rt.state.pump_total_amount = Some(t.amount);
            rt.state.pump_total_price = Some(t.price);
        }
        rt.state.pump_totals = totals;
    }
    true
}

/// Close a finished sale: read '5' full data, persist (+sync queue, +shift
/// totals), emit Done, acknowledge with '8', refresh the totalizer.
#[allow(clippy::too_many_arguments)]
async fn azt_close_transaction(
    byte: u8,
    fp_cfg: &FuelingPositionConfig,
    backend: &SerialBackend,
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
    trk_types: &mut HashMap<u8, azt::TrkType>,
) -> bool {
    // Close on the hose the sale ran on (its own RS-485 address), not the card.
    let net = {
        let map = runtimes.read().await;
        azt_active_net(fp_cfg, map.get(&byte).and_then(|rt| rt.state.nozzle_index))
    };
    let should_close = {
        let map = runtimes.read().await;
        map.get(&byte)
            .map(|rt| {
                matches!(
                    rt.state.status,
                    FpStatus::Delivering | FpStatus::Authorizing | FpStatus::Stopped { .. }
                )
            })
            .unwrap_or(false)
    };
    if !should_close {
        return false;
    }

    // Digit widths are mandatory for parsing '5' — retry next poll if unknown.
    let Some(trk) = azt_trk_type(net, backend, trk_types) else {
        warn!(net, "AZT: TRK type unknown — close retried next poll");
        return false;
    };

    let full = azt_query_data(net, &azt::full_data(net), backend)
        .and_then(|d| azt::parse_full_data(&d, trk))
        .or_else(|| {
            azt_query_data(net, &azt::full_data(net), backend)
                .and_then(|d| azt::parse_full_data(&d, trk))
        });

    let (ctx, state_price, nozzle_index, preset) = {
        let map = runtimes.read().await;
        let Some(rt) = map.get(&byte) else {
            return false;
        };
        (
            rt.current_tx.clone(),
            rt.state.price,
            rt.state.nozzle_index.unwrap_or(1),
            rt.last_preset.clone(),
        )
    };

    let Some(full) = full else {
        warn!(net, "AZT: refusing to save transaction without full data");
        return false;
    };

    let ctx = match ctx {
        Some(c) => c,
        None => {
            if full.volume_centilitres == 0 {
                // Nothing dispensed and no sale of ours: just acknowledge.
                azt_expect_ack(net, &azt::confirm_totals(net), backend, "confirm_totals");
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.state.status = FpStatus::Idle;
                }
                return false;
            }
            let (product_id, product_name) = azt_nozzle_product(fp_cfg, cfg, nozzle_index);
            CurrentTx {
                id: uuid::Uuid::new_v4().to_string(),
                started_at: Utc::now().timestamp_millis(),
                product_id,
                product_name,
                nozzle_index,
            }
        }
    };

    let volume = full.volume_centilitres as f64 / 100.0;
    // Wire money units → soum (×10, see AZT_WIRE_UNIT).
    let amount = full.cost_kopecks * AZT_WIRE_UNIT;
    let price = u32::try_from(full.price_kopecks * AZT_WIRE_UNIT)
        .ok()
        .filter(|p| *p > 0)
        .unwrap_or(state_price);

    // UINTR is the pump's own audit counter — record it in the logs so paper
    // journals can be reconciled against our transaction ids.
    if let Some(uintr) = azt_query_data(net, &azt::transaction_number(net), backend)
        .and_then(|d| azt::parse_transaction_number(&d))
    {
        info!(net, uintr, tx_id = %ctx.id, "AZT: pump transaction number");
    }

    let (shift_id, operator_name) = shifts.active_info().await;
    let now_ms = Utc::now().timestamp_millis();
    let (preset_type, preset_value, preset_label) = preset_metadata(&preset);
    let tx = Transaction {
        id: ctx.id.clone(),
        fp_id: fp_cfg.id.clone(),
        label: fp_cfg.label.clone(),
        address_byte: byte,
        started_at: ctx.started_at,
        completed_at: Some(now_ms),
        volume,
        amount,
        price,
        nozzle_index: ctx.nozzle_index,
        product_id: ctx.product_id,
        product_name: ctx.product_name.clone(),
        preset_type,
        preset_value,
        preset_label,
        status: TxStatus::resolve(volume, true),
        shift_id,
        operator_name,
        parent_tx_id: None,
        combined_volume: volume,
        combined_amount: amount,
    };

    if let Err(e) = crate::db::queries::persist_closed_transaction(pool, &tx).await {
        warn!(?e, byte, "AZT: DB persist failed for transaction");
        return false;
    }
    if let Err(e) = shifts.on_transaction_recorded(&tx).await {
        warn!(?e, byte, "AZT: shift totals update failed");
    }
    let _ = events.send(WsEvent::Done(tx));
    {
        let mut map = runtimes.write().await;
        if let Some(rt) = map.get_mut(&byte) {
            rt.state.status = FpStatus::Done;
            rt.state.volume = volume;
            rt.state.amount = amount;
            rt.current_tx = None;
            rt.pre_auth = None;
        }
    }

    // §7.8: acknowledge the totals write; the pump returns to '0'/'1'. If the
    // ACK is missed, keep the app-side transaction saved and retry confirmation
    // from the next Finished poll instead of pretending the pump cleared.
    if azt_expect_ack(net, &azt::confirm_totals(net), backend, "confirm_totals") {
        let _ = azt_sync_totals(byte, fp_cfg, backend, runtimes).await;
    } else {
        warn!(
            net,
            tx_id = %ctx.id,
            "AZT: transaction saved but confirm totals failed — retrying next poll"
        );
    }

    info!(
        net,
        volume, amount, "AZT: transaction complete, Done emitted"
    );
    true
}

#[allow(clippy::too_many_arguments)]
async fn azt_apply_command(
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    backend: &SerialBackend,
    cmd: DispatchCommand,
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
    trk_types: &mut HashMap<u8, azt::TrkType>,
) {
    match cmd {
        DispatchCommand::ReloadConfig { .. } => {}

        // AZT arms the pump directly even with the nozzle holstered (§7.2), so
        // Authorize and Preauthorize share the wire sequence and differ only in
        // the UI state they leave behind.
        DispatchCommand::Authorize {
            byte,
            price,
            preset,
        } => {
            azt_do_authorize(cfg, runtimes, events, backend, byte, price, preset, None).await;
        }
        DispatchCommand::Preauthorize {
            byte,
            price,
            preset,
            nozzle_index,
        } => {
            azt_do_authorize(
                cfg,
                runtimes,
                events,
                backend,
                byte,
                price,
                preset,
                Some(nozzle_index),
            )
            .await;
        }

        DispatchCommand::Stop { byte } => {
            let fp_cfg = match cfg.position_by_address(byte) {
                Some(p) => p.clone(),
                None => return,
            };
            // Reset the hose the sale is running on.
            let net = {
                let map = runtimes.read().await;
                azt_active_net(&fp_cfg, map.get(&byte).and_then(|rt| rt.state.nozzle_index))
            };
            // §7.3: reset switches the pump off; it lands in '4' and the poll
            // loop closes the partial sale from the Stopped state.
            azt_expect_ack(net, &azt::reset(net), backend, "stop_reset");
            let newly_stopped = {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    if !rt.state.status.is_stopped() {
                        let vol = rt.state.volume;
                        let amt = rt.state.amount;
                        let tx_id = rt
                            .current_tx
                            .as_ref()
                            .map(|t| t.id.clone())
                            .unwrap_or_default();
                        rt.state.status = FpStatus::Stopped {
                            stopped_volume: vol,
                            stopped_amount: amt,
                            stopped_tx_id: tx_id.clone(),
                            stop_source: StopSource::AppFinal,
                        };
                        rt.pre_auth = None;
                        Some((vol, amt, tx_id))
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            if let Some((vol, amt, tx_id)) = newly_stopped {
                let _ = events.send(WsEvent::Paused {
                    fp_id: fp_cfg.id.clone(),
                    stopped_volume: vol,
                    stopped_amount: amt,
                    stopped_tx_id: tx_id,
                    stop_source: "APP_FINAL".to_string(),
                });
            }
            broadcast_status(byte, runtimes, events).await;
        }

        DispatchCommand::EStop => {
            // Reset every hose on every pump — any nozzle could be dispensing.
            for fp in cfg.active_positions() {
                for (net, _) in azt_fp_nozzles(fp) {
                    azt_expect_ack(net, &azt::reset(net), backend, "estop_reset");
                }
            }
            let mut map = runtimes.write().await;
            for fp in cfg.active_positions() {
                if let Some(rt) = map.get_mut(&fp.address_byte) {
                    let vol = rt.state.volume;
                    let amt = rt.state.amount;
                    let tx_id = rt
                        .current_tx
                        .as_ref()
                        .map(|t| t.id.clone())
                        .unwrap_or_default();
                    rt.state.status = FpStatus::Stopped {
                        stopped_volume: vol,
                        stopped_amount: amt,
                        stopped_tx_id: tx_id,
                        stop_source: StopSource::AppFinal,
                    };
                    rt.pre_auth = None;
                    let _ = events.send(WsEvent::Status(rt.snapshot_state()));
                }
            }
        }

        DispatchCommand::ResetAll => {
            let mut map = runtimes.write().await;
            for fp in cfg.active_positions() {
                if let Some(rt) = map.get_mut(&fp.address_byte) {
                    if matches!(
                        rt.state.status,
                        FpStatus::Delivering | FpStatus::Authorizing | FpStatus::PreAuthorized
                    ) {
                        warn!(byte = fp.address_byte, "AZT: reset all skipped active lane");
                        continue;
                    }
                    if let FpStatus::Stopped { stopped_amount, .. } = rt.state.status {
                        if stopped_amount > 0 {
                            warn!(
                                byte = fp.address_byte,
                                "AZT: reset all skipped non-zero stopped sale"
                            );
                            continue;
                        }
                    }
                    rt.reset_for_operator(fp);
                    let _ = events.send(WsEvent::Status(rt.snapshot_state()));
                }
            }
        }

        DispatchCommand::ResetLane { byte } => {
            let fp_cfg = match cfg.position_by_address(byte) {
                Some(p) => p.clone(),
                None => return,
            };
            let stopped_amount = {
                let map = runtimes.read().await;
                map.get(&byte).and_then(|rt| {
                    if let FpStatus::Stopped { stopped_amount, .. } = rt.state.status {
                        Some(stopped_amount)
                    } else {
                        None
                    }
                })
            };
            if let Some(amount) = stopped_amount {
                let mut closed = false;
                for attempt in 1..=AZT_RESET_CLOSE_RETRIES {
                    if azt_close_transaction(
                        byte, &fp_cfg, backend, cfg, runtimes, events, pool, shifts, trk_types,
                    )
                    .await
                    {
                        closed = true;
                        break;
                    }
                    if amount == 0 || attempt == AZT_RESET_CLOSE_RETRIES {
                        break;
                    }
                    warn!(
                        byte,
                        attempt,
                        max_attempts = AZT_RESET_CLOSE_RETRIES,
                        "AZT: reset lane close retry failed"
                    );
                    tokio::time::sleep(Duration::from_millis(AZT_RESET_CLOSE_RETRY_DELAY_MS)).await;
                }

                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    if closed || rt.state.status == FpStatus::Done {
                        let _ = events.send(WsEvent::Status(rt.snapshot_state()));
                    } else if amount == 0 {
                        rt.reset_for_operator(&fp_cfg);
                        let _ = events.send(WsEvent::Status(rt.snapshot_state()));
                    } else {
                        warn!(
                            byte,
                            attempts = AZT_RESET_CLOSE_RETRIES,
                            "AZT: reset lane refused while stopped sale has non-zero amount"
                        );
                    }
                }
                return;
            }
            let mut map = runtimes.write().await;
            if let Some(rt) = map.get_mut(&byte) {
                match rt.operator_dismiss_display(&fp_cfg) {
                    Ok(()) => {
                        let _ = events.send(WsEvent::Status(rt.snapshot_state()));
                    }
                    Err(e) => warn!(byte, %e, "AZT: dismiss lane"),
                }
            }
        }

        DispatchCommand::UpdatePrices {
            updates,
            changed_by,
        } => {
            // JIT pricing: prices land on the wire during the next authorize.
            let mut map = runtimes.write().await;
            for u in updates {
                let Some(fp) = cfg.position_by_id(&u.fp_id) else {
                    continue;
                };
                let product_name = fp
                    .nozzles
                    .iter()
                    .find(|n| n.index == u.nozzle_index)
                    .and_then(|n| cfg.product(n.product_id).map(|p| p.name.clone()))
                    .unwrap_or_default();
                if let Some(rt) = map.get_mut(&fp.address_byte) {
                    let old = rt.set_nozzle_price(u.nozzle_index, u.price);
                    let _ = events.send(WsEvent::PriceUpdated {
                        fp_id: u.fp_id.clone(),
                        nozzle_index: u.nozzle_index,
                        product_name,
                        old_price: old,
                        new_price: u.price,
                        changed_by: changed_by.clone(),
                    });
                }
            }
        }

        DispatchCommand::CancelPreauth { byte } => {
            let fp_cfg = match cfg.position_by_address(byte) {
                Some(p) => p.clone(),
                None => return,
            };
            // De-arm the hose that was armed (the card's selected nozzle).
            let net = {
                let map = runtimes.read().await;
                azt_active_net(&fp_cfg, map.get(&byte).and_then(|rt| rt.state.nozzle_index))
            };
            // De-arm on the wire: reset drops '2' → '4' with zero data, and the
            // immediate confirm returns the pump to '0'/'1' (§7.3, §7.8).
            if azt_expect_ack(net, &azt::reset(net), backend, "cancel_preauth_reset") {
                azt_expect_ack(
                    net,
                    &azt::confirm_totals(net),
                    backend,
                    "cancel_preauth_confirm",
                );
            }
            {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.cancel_pre_auth();
                    rt.current_tx = None;
                }
            }
            let _ = events.send(WsEvent::PreAuthCancelled {
                fp_id: fp_cfg.id.clone(),
            });
            broadcast_status(byte, runtimes, events).await;
        }

        // Stops are terminal on this site (no resume) — same policy as Gilbarco.
        DispatchCommand::ContinueFill { .. } | DispatchCommand::ResumeFill { .. } => {}

        DispatchCommand::RefreshTotals => {
            for fp in cfg.active_positions() {
                let byte = fp.address_byte;
                let busy = {
                    let map = runtimes.read().await;
                    map.get(&byte)
                        .map(|rt| {
                            matches!(
                                rt.state.status,
                                FpStatus::Delivering | FpStatus::Authorizing
                            )
                        })
                        .unwrap_or(false)
                };
                if busy {
                    continue;
                }
                if azt_sync_totals(byte, fp, backend, runtimes).await {
                    broadcast_status(byte, runtimes, events).await;
                }
            }
        }
    }
}

/// Shared arming path for Authorize and Preauthorize.
///
/// `preauth_nozzle`: `Some(n)` leaves the lane in PreAuthorized (armed, waiting
/// for the customer to lift); `None` is a direct authorize → Authorizing.
#[allow(clippy::too_many_arguments)]
async fn azt_do_authorize(
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    backend: &SerialBackend,
    byte: u8,
    price: u32,
    preset: Preset,
    preauth_nozzle: Option<u8>,
) {
    let fp_cfg = match cfg.position_by_address(byte) {
        Some(p) => p.clone(),
        None => return,
    };
    // Target the selected hose. For direct authorize, prefer the nozzle already
    // observed as lifted; otherwise multi-product AZT pumps can briefly show the
    // first nozzle's product while the customer is using a different hose.
    let lifted_nozzle = if preauth_nozzle.is_none() {
        let map = runtimes.read().await;
        map.get(&byte).and_then(|rt| {
            if rt.state.status == FpStatus::NozzleUp {
                rt.state.nozzle_index
            } else {
                None
            }
        })
    } else {
        None
    };
    let nozzle = preauth_nozzle
        .filter(|n| *n > 0)
        .or(lifted_nozzle)
        .unwrap_or_else(|| {
            fp_cfg
                .active_nozzles()
                .first()
                .map(|n| n.index)
                .unwrap_or(1)
        });
    let direct_start = preauth_nozzle.is_none() && lifted_nozzle.is_some();
    let net = azt_active_net(&fp_cfg, Some(nozzle));

    if direct_start {
        match azt_query_status(net, backend) {
            Some(azt::AztStatus::OffLifted) => {}
            other => {
                warn!(
                    net,
                    nozzle,
                    ?other,
                    "AZT: direct authorize refused — live nozzle status is not lifted"
                );
                broadcast_status(byte, runtimes, events).await;
                return;
            }
        }
    }

    // Refuse from non-idle lanes: the wire would CAN anyway (§7.10/§7.13 require
    // status '0'/'1'), this just fails earlier with a clearer message.
    let lane_busy = {
        let map = runtimes.read().await;
        map.get(&byte)
            .map(|rt| {
                matches!(
                    rt.state.status,
                    FpStatus::Delivering
                        | FpStatus::Authorizing
                        | FpStatus::PreAuthorized
                        | FpStatus::Stopped { .. }
                )
            })
            .unwrap_or(false)
    };
    if lane_busy {
        warn!(net, "AZT: authorize refused — lane busy");
        broadcast_status(byte, runtimes, events).await;
        return;
    }

    if let Err(reason) = azt_arm(net, price, &preset, backend) {
        warn!(net, reason, "AZT: authorize failed");
        broadcast_status(byte, runtimes, events).await;
        return;
    }
    if direct_start {
        if azt_expect_ack(
            net,
            &azt::unconditional_start(net),
            backend,
            "unconditional_start",
        ) {
            info!(
                net,
                nozzle, "AZT: direct authorize start command ACKed after status 2"
            );
        } else {
            warn!(
                net,
                nozzle,
                "AZT: direct authorize start command failed; status-2 timeout guard will recover"
            );
        }
    }

    let (product_id, product_name) = azt_nozzle_product(&fp_cfg, cfg, nozzle);
    let preset_label_str = preset_label(&preset);
    let tx = CurrentTx {
        id: uuid::Uuid::new_v4().to_string(),
        started_at: Utc::now().timestamp_millis(),
        product_id,
        product_name: product_name.clone(),
        nozzle_index: nozzle,
    };
    {
        let mut map = runtimes.write().await;
        if let Some(rt) = map.get_mut(&byte) {
            rt.current_tx = Some(tx);
            rt.state.price = price;
            rt.state.nozzle_index = Some(nozzle);
            rt.state.product_id = Some(product_id);
            rt.state.product_name = Some(product_name);
            rt.state.volume = 0.0;
            rt.state.amount = 0;
            rt.set_last_preset(preset);
            if preauth_nozzle.is_some() {
                rt.pre_auth = Some(PreAuthContext {
                    nozzle_index: nozzle,
                    product_id,
                });
                rt.state.status = FpStatus::PreAuthorized;
                rt.state.pre_auth_preset = Some(preset_label_str.clone());
                rt.pre_auth_started_at = Some(Utc::now().timestamp_millis());
                rt.auth_session_started_at = None;
            } else {
                rt.state.status = FpStatus::Authorizing;
                rt.state.pre_auth_preset = Some(preset_label_str.clone());
                rt.pre_auth = None;
                rt.pre_auth_started_at = None;
                rt.auth_session_started_at = Some(Utc::now().timestamp_millis());
            }
        }
    }
    if preauth_nozzle.is_some() {
        let _ = events.send(WsEvent::PreAuthorized {
            fp_id: fp_cfg.id.clone(),
            price,
            preset: preset_label_str,
            nozzle_index: nozzle,
        });
    }
    info!(
        net,
        nozzle, price, "AZT: pump armed (price+dose+authorize ACKed)"
    );
    broadcast_status(byte, runtimes, events).await;
}
