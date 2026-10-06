use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use site_config::{FuelingPositionConfig, SiteConfig};
use sqlx::SqlitePool;
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing::{debug, info, warn};
use types::{preset_label, FpStatus, Preset, PumpNozzleTotals, Transaction, TxStatus, WsEvent};

use super::shared::{
    active_positions_by_byte, broadcast_status, exchange_serial, mark_missed, preset_metadata,
    SerialBackend,
};
use crate::engine::poll_loop::DispatchCommand;
use crate::engine::state::{CurrentTx, PreAuthContext, RuntimeFp};
use crate::shifts::ShiftCoordinator;

#[path = "azt_journal.rs"]
mod journal;

const AZT_REACTIVE_AUTHORIZE_START_TIMEOUT_MS: i64 = 15_000;

// ── AZT 2.0 (ОАО АЗТ) poll loop ──────────────────────────────────────────────
//
// SU-driven protocol: the control system sets price + dose, authorizes, polls
// live volume, reads final data, and confirms the totals write. One hose per
// network address (1..=225, including address offsets).
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
const AZT_STOP_RETRY_INTERVAL: Duration = Duration::from_millis(500);
const AZT_STATUS_UNAVAILABLE: &str =
    "Pump status unavailable; displayed status and meters may be stale.";

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
                trk_types.clear();
                cfg = next_cfg;
                disp_by_byte = active_positions_by_byte(&cfg);
                addrs = cfg.active_addresses();
                pending_startup_totals = addrs.iter().map(|&a| (a, 2)).collect();
                interval = tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                continue 'poll_loop;
            }
            azt_apply_command(&cfg, &runtimes, &events, &backend, &pool, &shifts, cmd).await;
        }

        for byte in addrs.clone() {
            interval.tick().await;
            while let Ok(cmd) = commands.try_recv() {
                if let DispatchCommand::ReloadConfig { cfg: next_cfg } = cmd {
                    info!("AZT poll loop reloaded site config");
                    trk_types.clear();
                    cfg = next_cfg;
                    disp_by_byte = active_positions_by_byte(&cfg);
                    addrs = cfg.active_addresses();
                    pending_startup_totals = addrs.iter().map(|&a| (a, 2)).collect();
                    interval =
                        tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    continue 'poll_loop;
                }
                azt_apply_command(&cfg, &runtimes, &events, &backend, &pool, &shifts, cmd).await;
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
                                        | FpStatus::Finalizing
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
    if !azt_restore(byte, cfg, runtimes, pool).await {
        broadcast_status(byte, runtimes, events).await;
        return;
    }
    azt_poll_card_inner(
        byte,
        cfg,
        backend,
        runtimes,
        disp_by_byte,
        events,
        pool,
        shifts,
        trk_types,
        pending_startup_totals,
    )
    .await;
    azt_checkpoint(byte, cfg, runtimes, pool).await;
    broadcast_status(byte, runtimes, events).await;
}

#[allow(clippy::too_many_arguments)]
async fn azt_poll_card_inner(
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

    azt_send_pending_stops(byte, backend, runtimes).await;

    // Resolve which hose of this pump card is active and poll it. `net`
    // is that hose's RS-485 address; `active_nozzle` its 1-based index.
    let Some((net, active_nozzle, status)) =
        azt_resolve_active(byte, fp_cfg, &backend, &runtimes).await
    else {
        azt_error(byte, runtimes, AZT_STATUS_UNAVAILABLE).await;
        mark_missed(
            byte,
            fp_cfg,
            cfg.polling.offline_threshold_polls,
            runtimes,
            events,
        )
        .await;
        broadcast_status(byte, runtimes, events).await;
        return;
    };

    {
        let mut map = runtimes.write().await;
        if let Some(rt) = map.get_mut(&byte) {
            if !matches!(status, AztStatus::Unknown | AztStatus::Dispensing) {
                rt.on_poll_success();
                if rt.state.protocol_error.as_deref() == Some(AZT_STATUS_UNAVAILABLE) {
                    rt.state.protocol_error = None;
                }
            }
        }
    }

    match status {
        AztStatus::Unknown => {
            azt_error(byte, runtimes, AZT_STATUS_UNAVAILABLE).await;
            mark_missed(
                byte,
                fp_cfg,
                cfg.polling.offline_threshold_polls,
                runtimes,
                events,
            )
            .await;
        }

        AztStatus::OffHolstered | AztStatus::OffLifted => {
            let lifted = status == AztStatus::OffLifted;

            // Pump idle while we believed a sale was running: the pump was
            // reset/cleared out-of-band. Try to salvage the sale data ('5'
            // is answered in every status), then idle the lane.
            let was_active = {
                let mut map = runtimes.write().await;
                let Some(rt) = map.get_mut(&byte) else { return };
                rt.azt.stop_addresses.remove(&net);
                if rt.azt.pending_confirmation {
                    // The confirmation reached the pump but its ACK was lost.
                    rt.azt.pending_confirmation = false;
                    rt.azt.stop_requested = false;
                    if rt.current_tx.is_some() {
                        rt.cancel_pre_auth();
                        let _ = events.send(WsEvent::PreAuthCancelled {
                            fp_id: fp_cfg.id.clone(),
                        });
                    }
                    rt.azt.cancel_requested = false;
                    rt.azt.order_price = None;
                    rt.state.protocol_error = None;
                }
                if rt.current_tx.is_none() && rt.pre_auth.is_none() {
                    if rt.azt.stop_requested && rt.azt.stop_addresses.is_empty() {
                        rt.state.protocol_error = None;
                    }
                    rt.azt.stop_requested = false;
                    rt.azt.cancel_requested = false;
                }
                rt.current_tx.is_some() || rt.pre_auth.is_some()
            };
            if was_active {
                // Even a preauthorization may have dispensed while polls were
                // missed. Read its final registers before releasing ownership.
                azt_close_transaction(
                    byte, fp_cfg, backend, cfg, runtimes, events, pool, shifts, trk_types, false,
                )
                .await;
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
            let orphan = runtimes.read().await.get(&byte).is_some_and(|rt| {
                rt.current_tx.is_none() && !rt.azt.pending_confirmation && !rt.azt.stop_requested
            });
            if orphan {
                // An arm left by another controller has no durable order to run.
                azt_request_stop(byte, fp_cfg, false, true, cfg, pool, backend, runtimes).await;
                azt_error(
                    byte,
                    runtimes,
                    "Pump was armed without an order; stop requested.",
                )
                .await;
                return;
            }
            if let Some(rt) = runtimes.write().await.get_mut(&byte) {
                rt.azt.authorize_uncertain = false;
                if !rt.azt.stop_requested {
                    rt.state.protocol_error = None;
                }
            }
            let (expired, reactive_timeout) = {
                let map = runtimes.read().await;
                let Some(rt) = map.get(&byte) else { return };
                let now = Utc::now().timestamp_millis();
                let expired = !rt.azt.stop_requested
                    && cfg.ui.preauth_timeout_seconds > 0
                    && rt.pre_auth.is_some()
                    && rt.pre_auth_started_at.is_some_and(|started| {
                        now.saturating_sub(started).max(0) as u64
                            >= cfg.ui.preauth_timeout_seconds.saturating_mul(1000)
                    });
                let reactive_timeout = !rt.azt.stop_requested
                    && rt.pre_auth.is_none()
                    && rt.auth_session_started_at.is_some_and(|started| {
                        now.saturating_sub(started) >= AZT_REACTIVE_AUTHORIZE_START_TIMEOUT_MS
                    });
                (expired, reactive_timeout)
            };
            if expired || reactive_timeout {
                if expired {
                    let _ = events.send(WsEvent::PreAuthTimeout {
                        fp_id: fp_cfg.id.clone(),
                    });
                }
                azt_request_stop(byte, fp_cfg, false, true, cfg, pool, backend, runtimes).await;
            } else {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.state.nozzle_index = Some(active_nozzle);
                    if rt.azt.stop_requested {
                        rt.state.status = FpStatus::Finalizing;
                    } else if rt.pre_auth.is_some() {
                        rt.state.status = FpStatus::PreAuthorized;
                    } else {
                        rt.state.status = FpStatus::Authorizing;
                    }
                }
            }
        }

        AztStatus::Dispensing => {
            // Live volume via '4' (0.01 L); amount derived from JIT price.
            let live = azt_query_data(net, &azt::current_data(net), &backend)
                .and_then(|d| azt::parse_current_data(&d));
            if live.is_none() {
                azt_error(
                    byte,
                    runtimes,
                    "Live meter reading unavailable; displayed volume may be stale.",
                )
                .await;
                mark_missed(
                    byte,
                    fp_cfg,
                    cfg.polling.offline_threshold_polls,
                    runtimes,
                    events,
                )
                .await;
                return;
            }
            let (shift_id, operator_name) = shifts.active_info().await;
            let mut map = runtimes.write().await;
            if let Some(rt) = map.get_mut(&byte) {
                rt.on_poll_success();
                rt.azt.authorize_uncertain = false;
                if !rt.azt.stop_requested {
                    rt.state.protocol_error = None;
                }
                let (pid, pname) = azt_nozzle_product(fp_cfg, &cfg, active_nozzle);
                let price = rt.azt.order_price.unwrap_or_else(|| {
                    rt.nozzle_prices
                        .get(&active_nozzle)
                        .copied()
                        .or_else(|| {
                            fp_cfg
                                .nozzles
                                .iter()
                                .find(|n| n.index == active_nozzle)
                                .map(|n| n.price)
                        })
                        .unwrap_or(rt.state.price)
                });
                rt.azt.stop_requested |= rt.azt.stop_addresses.contains(&net);
                rt.state.status = if rt.azt.stop_requested {
                    FpStatus::Finalizing
                } else {
                    FpStatus::Delivering
                };
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
                    rt.azt.shift_id = shift_id;
                    rt.azt.operator_name = operator_name;
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
            {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.state.nozzle_index = Some(active_nozzle);
                    if !rt.azt.pending_confirmation {
                        rt.state.status = FpStatus::Finalizing;
                    }
                }
            }
            // Finished is authoritative even after restart or a missed '3'.
            azt_close_transaction(
                byte, fp_cfg, backend, cfg, runtimes, events, pool, shifts, trk_types, true,
            )
            .await;
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

async fn azt_error(byte: u8, runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>, message: &str) {
    if let Some(rt) = runtimes.write().await.get_mut(&byte) {
        rt.state.protocol_error = Some(message.to_owned());
    }
}

async fn azt_restore(
    byte: u8,
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    pool: &SqlitePool,
) -> bool {
    if let Err(e) = journal::restore(byte, cfg, runtimes, pool).await {
        warn!(byte, %e, "AZT recovery failed");
        azt_error(
            byte,
            runtimes,
            "Recovery journal unavailable or configuration changed; new orders blocked.",
        )
        .await;
        return false;
    }
    true
}

async fn azt_checkpoint(
    byte: u8,
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    pool: &SqlitePool,
) -> bool {
    if let Err(e) = journal::save(byte, cfg, runtimes, pool).await {
        warn!(byte, %e, "AZT recovery journal write failed");
        azt_error(
            byte,
            runtimes,
            "Recovery journal could not be saved; new orders blocked.",
        )
        .await;
        return false;
    }
    true
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

fn azt_status_priority(st: azt::AztStatus) -> u8 {
    match st {
        azt::AztStatus::Finished(_) => 6,
        azt::AztStatus::Dispensing => 5,
        azt::AztStatus::Authorized => 4,
        azt::AztStatus::LocalPreset => 3,
        azt::AztStatus::OffLifted => 2,
        azt::AztStatus::OffHolstered => 1,
        azt::AztStatus::Unknown => 0,
    }
}

/// Resolve the active hose for a pump card and poll its status.
///
/// Returns `(net, nozzle_index, status)`. While a sale/arm is in progress the
/// card stays on the nozzle it started (from `rt.state.nozzle_index`); otherwise
/// every hose is polled, prioritizing finished and dispensing over lifted hoses. `None` means no hose answered → the card is offline.
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
                    | FpStatus::Finalizing
                    | FpStatus::Stopped { .. }
            ) || rt.current_tx.is_some()
                || rt.azt.pending_confirmation;
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

    // Sweep all hoses so an earlier lifted/invalid reply cannot hide a finished sale.
    let mut idle_fallback: Option<(u8, u8, azt::AztStatus)> = None;
    for (addr, nidx) in nozzles {
        if let Some(st) = azt_query_status(addr, backend) {
            if idle_fallback
                .as_ref()
                .is_none_or(|(_, _, best)| azt_status_priority(st) > azt_status_priority(*best))
            {
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

/// Validate before any wire command. AZT must never truncate operator values.
pub(crate) fn validate_order(preset: &Preset, price: u32) -> Result<(), &'static str> {
    validate_price(price)?;
    match preset {
        Preset::Str(s) if s.eq_ignore_ascii_case("full") => Ok(()),
        Preset::Volume(litres) if litres.is_finite() && *litres > 0.0 => {
            let cl = litres * 100.0;
            if cl > AZT_MAX_DOSE_CL as f64 || cl < 1.0 {
                Err("AZT volume must be between 0.01 and 990.00 L")
            } else if (cl - cl.round()).abs() > 0.000001 {
                Err("AZT volume must be a multiple of 0.01 L")
            } else {
                Ok(())
            }
        }
        Preset::Amount(amount) if *amount >= AZT_WIRE_UNIT && *amount <= AZT_MAX_AMOUNT => {
            if amount % AZT_WIRE_UNIT != 0 {
                Err("AZT amount must be a multiple of 10 soum")
            } else if amount * 100 > AZT_MAX_DOSE_CL * price as u64 {
                Err("AZT amount exceeds the maximum volume at this price")
            } else {
                Ok(())
            }
        }
        _ => Err("Invalid AZT preset or amount exceeds 9,999,990 soum"),
    }
}

pub(crate) fn validate_price(price: u32) -> Result<(), &'static str> {
    if price == 0 || price > AZT_MAX_PRICE || price % AZT_WIRE_UNIT as u32 != 0 {
        Err("AZT price must be 10–99,990 soum/L, in multiples of 10")
    } else {
        Ok(())
    }
}

fn azt_dose_frame(
    net: u8,
    preset: &Preset,
    price: u32,
    trk: azt::TrkType,
    full_tank_supported: bool,
) -> Result<Vec<u8>, &'static str> {
    validate_order(preset, price)?;
    let wire_price = price as u64 / AZT_WIRE_UNIT;
    let cost_max = 10_u64.pow(trk.cost_digits as u32) - 1;
    // Leave room for half-up rounding in the pump's cost register.
    let max_cl = AZT_MAX_DOSE_CL
        .min(10_u64.pow(trk.volume_digits as u32) - 1)
        .min((cost_max * 100 - 50) / wire_price);
    match preset {
        Preset::Str(_) if full_tank_supported => {
            Ok(azt::set_dose_litres_full_tank(net, max_cl as u32))
        }
        // Version 1 has no full-tank flag. A bounded ordinary dose provides
        // the same operator flow, ending on holster or the safe ceiling.
        Preset::Str(_) => Ok(azt::set_dose_litres(net, max_cl as u32)),
        Preset::Volume(litres) => {
            let cl = (litres * 100.0).round() as u64;
            if cl > max_cl {
                Err("AZT volume exceeds this pump's cost register at the selected price")
            } else {
                Ok(azt::set_dose_litres(net, cl as u32))
            }
        }
        Preset::Amount(amount) => {
            let wire = amount / AZT_WIRE_UNIT;
            if wire > cost_max || wire * 100 > max_cl * wire_price {
                Err("AZT amount exceeds this pump's cost or volume register")
            } else {
                Ok(azt::set_dose_rubles(net, wire as u32))
            }
        }
    }
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

/// Request a terminal stop without discarding the owned sale or claiming the
/// pump has stopped. Every targeted hose remains pending until a status proves it.
async fn azt_request_stop(
    byte: u8,
    fp: &FuelingPositionConfig,
    all_hoses: bool,
    cancel: bool,
    cfg: &SiteConfig,
    pool: &SqlitePool,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
) {
    // Never withhold a physical stop because storage is unavailable.
    let _ = tokio::time::timeout(
        Duration::from_millis(200),
        azt_restore(byte, cfg, runtimes, pool),
    )
    .await;
    let targets = {
        let mut map = runtimes.write().await;
        let Some(rt) = map.get_mut(&byte) else { return };
        let targets: Vec<u8> = if all_hoses {
            azt_fp_nozzles(fp).into_iter().map(|(net, _)| net).collect()
        } else {
            vec![azt_active_net(fp, rt.state.nozzle_index)]
        };
        rt.azt.stop_addresses.extend(targets.iter().copied());
        rt.azt.stop_requested = true;
        rt.azt.next_stop_attempt = Some(Instant::now() + AZT_STOP_RETRY_INTERVAL);
        rt.azt.cancel_requested |= cancel;
        rt.pre_auth_started_at = None;
        rt.auth_session_started_at = None;
        if rt.current_tx.is_some()
            || rt.pre_auth.is_some()
            || matches!(
                rt.state.status,
                FpStatus::Authorizing | FpStatus::Delivering | FpStatus::PreAuthorized
            )
        {
            rt.azt.stop_requested = true;
            rt.state.status = FpStatus::Finalizing;
        }
        targets
    };
    let saved = tokio::time::timeout(
        Duration::from_millis(200),
        azt_checkpoint(byte, cfg, runtimes, pool),
    )
    .await
    .unwrap_or(false);
    if !saved {
        azt_error(byte, runtimes, "Stop requested but recovery journal unavailable; keep service running until pump stops.").await;
    }
    let mut acknowledged = true;
    for net in targets {
        // ACK alone is not a final meter reading; polling owns finalization.
        acknowledged &= azt_expect_ack(net, &azt::reset(net), backend, "stop_reset");
    }
    if saved && !acknowledged {
        azt_error(
            byte,
            runtimes,
            "Stop not confirmed; retrying. Delivery may still be active.",
        )
        .await;
    }
}

async fn azt_send_pending_stops(
    byte: u8,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
) {
    let targets = {
        let mut map = runtimes.write().await;
        let Some(rt) = map.get_mut(&byte) else { return };
        if rt.azt.stop_addresses.is_empty()
            || rt
                .azt
                .next_stop_attempt
                .is_some_and(|next| Instant::now() < next)
        {
            return;
        }
        rt.azt.next_stop_attempt = Some(Instant::now() + AZT_STOP_RETRY_INTERVAL);
        rt.azt.stop_addresses.iter().copied().collect::<Vec<_>>()
    };
    for net in targets {
        match azt_query_status(net, backend) {
            Some(
                azt::AztStatus::OffHolstered
                | azt::AztStatus::OffLifted
                | azt::AztStatus::Finished(_),
            ) => {
                if let Some(rt) = runtimes.write().await.get_mut(&byte) {
                    rt.azt.stop_addresses.remove(&net);
                }
            }
            _ => {
                azt_expect_ack(net, &azt::reset(net), backend, "retry_stop");
            }
        }
    }
}

async fn azt_dismiss(
    byte: u8,
    fp: &FuelingPositionConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
) {
    if let Some(rt) = runtimes.write().await.get_mut(&byte) {
        if rt.current_tx.is_none()
            && rt.pre_auth.is_none()
            && !rt.azt.pending_confirmation
            && rt.azt.stop_addresses.is_empty()
            && matches!(
                rt.state.status,
                FpStatus::Idle | FpStatus::Done | FpStatus::Offline
            )
        {
            rt.reset_for_operator(fp);
            rt.state.protocol_error = None;
            let loaded = rt.azt.journal_loaded;
            let json = rt.azt.journal_json.take();
            rt.azt = Default::default();
            rt.azt.journal_loaded = loaded;
            rt.azt.journal_json = json;
        }
    }
}

/// A pump transaction number survives service restarts. Use it to recognize a
/// sale saved before an ACK was lost. Older devices rejecting 'Y' can instead
/// identify the sale by their lifetime counters. A timeout is retried, never
/// treated as permission to clear an unidentified sale.
fn azt_sale_id(
    net: u8,
    cfg: &SiteConfig,
    full: azt::FullData,
    backend: &SerialBackend,
) -> Option<String> {
    let identity = match azt_exchange(net, &azt::transaction_number(net), backend)? {
        azt::Response::Data(data) => {
            format!("transaction:{}", azt::parse_transaction_number(&data)?)
        }
        azt::Response::Short(azt::NAK) => {
            let (volume, amount) = azt_query_data(net, &azt::totals(net), backend)
                .and_then(|d| azt::parse_totals(&d))?;
            format!("totals:{volume}:{amount}")
        }
        _ => return None,
    };
    let key = format!(
        "azt:{}:{net}:{identity}:{}:{}:{}",
        cfg.site.id, full.volume_centilitres, full.cost_kopecks, full.price_kopecks
    );
    Some(uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, key.as_bytes()).to_string())
}

async fn azt_confirm_sale(
    byte: u8,
    net: u8,
    fp: &FuelingPositionConfig,
    needs_confirmation: bool,
    cfg: &SiteConfig,
    pool: &SqlitePool,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
) -> bool {
    if !azt_checkpoint(byte, cfg, runtimes, pool).await {
        return false;
    }
    if needs_confirmation
        && !azt_expect_ack(net, &azt::confirm_totals(net), backend, "confirm_totals")
    {
        azt_error(byte, runtimes, "Sale saved; waiting for pump confirmation.").await;
        return false;
    }
    if let Some(rt) = runtimes.write().await.get_mut(&byte) {
        rt.state.protocol_error = None;
        rt.azt.pending_confirmation = false;
        rt.azt.stop_requested = false;
        rt.azt.stop_addresses.remove(&net);
        // Empty cancellations retain ownership until physical confirmation.
        if rt.current_tx.is_some()
            || rt.pre_auth.is_some()
            || rt.state.status == FpStatus::Finalizing
        {
            rt.cancel_pre_auth();
            let _ = events.send(WsEvent::PreAuthCancelled {
                fp_id: fp.id.clone(),
            });
        }
        rt.azt.cancel_requested = false;
        rt.azt.order_price = None;
    }
    let saved = azt_checkpoint(byte, cfg, runtimes, pool).await;
    let _ = azt_sync_totals(byte, fp, backend, runtimes).await;
    saved
}

/// Read every finished sale, including one recovered at startup. Save before
/// confirming, and look up the stable identity before crediting it again.
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
    needs_confirmation: bool,
) -> bool {
    let (net, pending, ctx, state_price, nozzle_index, preset, cancel) = {
        let map = runtimes.read().await;
        let Some(rt) = map.get(&byte) else {
            return false;
        };
        (
            azt_active_net(fp_cfg, rt.state.nozzle_index),
            rt.azt.pending_confirmation,
            rt.current_tx.clone(),
            rt.state.price,
            rt.state.nozzle_index.unwrap_or(1),
            rt.last_preset.clone(),
            rt.azt.cancel_requested,
        )
    };
    if pending {
        return azt_confirm_sale(
            byte,
            net,
            fp_cfg,
            needs_confirmation,
            cfg,
            pool,
            backend,
            runtimes,
            events,
        )
        .await;
    }
    let Some(trk) = azt_trk_type(net, backend, trk_types) else {
        azt_error(
            byte,
            runtimes,
            "Cannot read pump type; final sale retained.",
        )
        .await;
        return false;
    };
    let full = azt_query_data(net, &azt::full_data(net), backend)
        .and_then(|d| azt::parse_full_data(&d, trk))
        .or_else(|| {
            azt_query_data(net, &azt::full_data(net), backend)
                .and_then(|d| azt::parse_full_data(&d, trk))
        });
    let Some(full) = full else {
        warn!(net, "AZT: retaining sale until final data can be read");
        azt_error(
            byte,
            runtimes,
            "Final meter readings unavailable; retrying.",
        )
        .await;
        return false;
    };
    if full.volume_centilitres == 0 && full.cost_kopecks == 0 && (cancel || ctx.is_none()) {
        if let Some(rt) = runtimes.write().await.get_mut(&byte) {
            rt.azt.pending_confirmation = true;
        }
        return azt_confirm_sale(
            byte,
            net,
            fp_cfg,
            needs_confirmation,
            cfg,
            pool,
            backend,
            runtimes,
            events,
        )
        .await;
    }
    let Some(id) = azt_sale_id(net, cfg, full, backend) else {
        warn!(
            net,
            "AZT: retaining final data until sale identity can be read"
        );
        azt_error(
            byte,
            runtimes,
            "Sale identity unavailable; final readings retained.",
        )
        .await;
        return false;
    };
    let unchanged = {
        let map = runtimes.read().await;
        map[&byte].azt.authorize_uncertain && map[&byte].azt.before_sale_id.as_ref() == Some(&id)
    };
    if unchanged && !needs_confirmation {
        if let Some(rt) = runtimes.write().await.get_mut(&byte) {
            rt.cancel_pre_auth();
            rt.azt.order_price = None;
            rt.azt.authorize_uncertain = false;
            rt.state.protocol_error =
                Some("Authorization was not accepted; order cancelled.".into());
        }
        return azt_checkpoint(byte, cfg, runtimes, pool).await;
    }
    let existing = match crate::db::queries::get_transaction(pool, &id).await {
        Ok(tx) => tx,
        Err(e) => {
            warn!(net, %e, "AZT: cannot check recovered sale");
            return false;
        }
    };
    let tx = if let Some(tx) = existing {
        // Already durable: do not enqueue, credit the shift, or publish Done twice.
        tx
    } else {
        let (product_id, product_name) = ctx
            .as_ref()
            .map(|c| (c.product_id, c.product_name.clone()))
            .unwrap_or_else(|| azt_nozzle_product(fp_cfg, cfg, nozzle_index));
        let (shift_id, operator_name) = if ctx.is_some() {
            let map = runtimes.read().await;
            (
                map[&byte].azt.shift_id.clone(),
                map[&byte].azt.operator_name.clone(),
            )
        } else {
            shifts.active_info().await
        };
        let owned_order = runtimes
            .read()
            .await
            .get(&byte)
            .is_some_and(|rt| rt.azt.order_price.is_some());
        let (preset_type, preset_value, preset_label) = if ctx.is_some() && owned_order {
            preset_metadata(&preset)
        } else {
            (None, None, None)
        };
        let volume = full.volume_centilitres as f64 / 100.0;
        let tx = Transaction {
            id,
            fp_id: fp_cfg.id.clone(),
            label: fp_cfg.label.clone(),
            address_byte: byte,
            started_at: ctx
                .as_ref()
                .map(|c| c.started_at)
                .unwrap_or_else(|| Utc::now().timestamp_millis()),
            completed_at: Some(Utc::now().timestamp_millis()),
            volume,
            amount: full.cost_kopecks * AZT_WIRE_UNIT,
            price: u32::try_from(full.price_kopecks * AZT_WIRE_UNIT)
                .ok()
                .filter(|p| *p > 0)
                .unwrap_or(state_price),
            nozzle_index,
            product_id,
            product_name,
            preset_type,
            preset_value,
            preset_label,
            status: TxStatus::resolve(volume, true),
            shift_id,
            operator_name,
            parent_tx_id: None,
            combined_volume: volume,
            combined_amount: full.cost_kopecks * AZT_WIRE_UNIT,
        };
        if let Err(e) = shifts.commit_azt_sale(&tx).await {
            warn!(net, %e, "AZT: atomic sale commit failed");
            azt_error(
                byte,
                runtimes,
                "Sale could not be saved; final readings retained for retry.",
            )
            .await;
            return false;
        }
        let _ = events.send(WsEvent::Done(tx.clone()));
        tx
    };
    if let Some(rt) = runtimes.write().await.get_mut(&byte) {
        rt.state.status = FpStatus::Done;
        rt.state.volume = tx.volume;
        rt.state.amount = tx.amount;
        rt.state.price = tx.price;
        rt.state.product_id = Some(tx.product_id);
        rt.state.product_name = Some(tx.product_name.clone());
        rt.current_tx = None;
        rt.pre_auth = None;
        rt.pre_auth_started_at = None;
        rt.auth_session_started_at = None;
        rt.state.pre_auth_preset = None;
        rt.azt.pending_confirmation = true;
    }
    azt_confirm_sale(
        byte,
        net,
        fp_cfg,
        needs_confirmation,
        cfg,
        pool,
        backend,
        runtimes,
        events,
    )
    .await
}

async fn azt_apply_command(
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    backend: &SerialBackend,
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
    cmd: DispatchCommand,
) {
    let bytes: Vec<u8> = match &cmd {
        DispatchCommand::Authorize { byte, .. }
        | DispatchCommand::Preauthorize { byte, .. }
        | DispatchCommand::Stop { byte }
        | DispatchCommand::CancelPreauth { byte }
        | DispatchCommand::ResetLane { byte } => vec![*byte],
        _ => cfg.active_addresses(),
    };
    let stopping = matches!(
        &cmd,
        DispatchCommand::Stop { .. }
            | DispatchCommand::CancelPreauth { .. }
            | DispatchCommand::EStop
    );
    let mut ready = true;
    for &byte in bytes.iter().filter(|_| !stopping) {
        ready &= azt_restore(byte, cfg, runtimes, pool).await;
        if ready {
            ready &= azt_checkpoint(byte, cfg, runtimes, pool).await;
        }
    }
    if ready || stopping {
        azt_apply_command_inner(cfg, runtimes, events, backend, pool, shifts, cmd).await;
    }
    for byte in bytes {
        azt_checkpoint(byte, cfg, runtimes, pool).await;
        broadcast_status(byte, runtimes, events).await;
    }
}

async fn azt_apply_command_inner(
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    backend: &SerialBackend,
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
    cmd: DispatchCommand,
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
            azt_do_authorize(
                cfg, runtimes, events, backend, pool, shifts, byte, price, preset, None,
            )
            .await;
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
                pool,
                shifts,
                byte,
                price,
                preset,
                Some(nozzle_index),
            )
            .await;
        }

        DispatchCommand::Stop { byte } => {
            if let Some(fp) = cfg.position_by_address(byte) {
                azt_request_stop(byte, fp, false, false, cfg, pool, backend, runtimes).await;
                broadcast_status(byte, runtimes, events).await;
            }
        }
        DispatchCommand::EStop => {
            for fp in cfg.active_positions() {
                azt_request_stop(
                    fp.address_byte,
                    fp,
                    true,
                    false,
                    cfg,
                    pool,
                    backend,
                    runtimes,
                )
                .await;
                broadcast_status(fp.address_byte, runtimes, events).await;
            }
        }
        DispatchCommand::ResetLane { byte } => {
            if let Some(fp) = cfg.position_by_address(byte) {
                azt_dismiss(byte, fp, runtimes).await;
                broadcast_status(byte, runtimes, events).await;
            }
        }
        DispatchCommand::ResetAll => {
            for fp in cfg.active_positions() {
                azt_dismiss(fp.address_byte, fp, runtimes).await;
                broadcast_status(fp.address_byte, runtimes, events).await;
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
                if let Err(reason) = validate_price(u.price) {
                    if let Some(rt) = map.get_mut(&fp.address_byte) {
                        rt.state.protocol_error = Some(reason.into());
                    }
                    continue;
                }
                let product_name = fp
                    .nozzles
                    .iter()
                    .find(|n| n.index == u.nozzle_index)
                    .and_then(|n| cfg.product(n.product_id).map(|p| p.name.clone()))
                    .unwrap_or_default();
                if let Some(rt) = map.get_mut(&fp.address_byte) {
                    let old = rt.set_nozzle_price(u.nozzle_index, u.price);
                    if let Some(price) = rt.azt.order_price.filter(|_| rt.current_tx.is_some()) {
                        rt.state.price = price;
                    }
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
            if let Some(fp) = cfg.position_by_address(byte) {
                // It may already be dispensing by the time this command runs.
                // Stop the same hose and let polling read and persist its final data.
                azt_request_stop(byte, fp, false, true, cfg, pool, backend, runtimes).await;
                broadcast_status(byte, runtimes, events).await;
            }
        }

        DispatchCommand::RefreshTotals => {
            for fp in cfg.active_positions() {
                let byte = fp.address_byte;
                let busy = {
                    let map = runtimes.read().await;
                    map.get(&byte)
                        .map(|rt| {
                            matches!(
                                rt.state.status,
                                FpStatus::Delivering | FpStatus::Authorizing | FpStatus::Finalizing
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
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
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

    if !fp_cfg.active_nozzles().iter().any(|n| n.index == nozzle) {
        azt_error(byte, runtimes, "Selected nozzle is not active.").await;
        return;
    }
    if let Err(reason) = validate_order(&preset, price) {
        azt_error(byte, runtimes, reason).await;
        return;
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
                        | FpStatus::Finalizing
                        | FpStatus::Authorizing
                        | FpStatus::PreAuthorized
                        | FpStatus::Stopped { .. }
                ) || rt.current_tx.is_some()
                    || rt.azt.pending_confirmation
                    || !rt.azt.stop_addresses.is_empty()
            })
            .unwrap_or(false)
    };
    if lane_busy {
        warn!(net, "AZT: authorize refused — lane busy");
        broadcast_status(byte, runtimes, events).await;
        return;
    }

    {
        // Fresh status is required even if the UI still shows idle.
        match azt_query_status(net, backend) {
            Some(azt::AztStatus::OffLifted) if direct_start => {}
            Some(azt::AztStatus::OffHolstered) if !direct_start => {}
            other => {
                warn!(
                    net,
                    nozzle,
                    ?other,
                    "AZT: direct authorize refused — live nozzle status is not lifted"
                );
                azt_error(
                    byte,
                    runtimes,
                    "Pump is not ready for this order; check nozzle and status.",
                )
                .await;
                broadcast_status(byte, runtimes, events).await;
                return;
            }
        }
    }

    let Some(trk) = azt_trk_type(net, backend, &mut HashMap::new()) else {
        azt_error(byte, runtimes, "Cannot read pump limits; order not sent.").await;
        return;
    };
    let full_tank_supported = if preset.is_full() {
        match azt_exchange(net, &azt::protocol_version(net), backend) {
            Some(azt::Response::Data(data)) => match azt::parse_protocol_version(&data) {
                Some(version) => version >= 2,
                None => {
                    azt_error(
                        byte,
                        runtimes,
                        "Invalid pump protocol version; full-tank order not sent.",
                    )
                    .await;
                    return;
                }
            },
            Some(azt::Response::Short(azt::NAK)) => false,
            _ => {
                azt_error(
                    byte,
                    runtimes,
                    "Cannot read pump protocol version; full-tank order not sent.",
                )
                .await;
                return;
            }
        }
    } else {
        false
    };
    let dose = match azt_dose_frame(net, &preset, price, trk, full_tank_supported) {
        Ok(dose) => dose,
        Err(reason) => {
            azt_error(byte, runtimes, reason).await;
            return;
        }
    };
    if !azt_expect_ack(
        net,
        &azt::set_price(net, price / AZT_WIRE_UNIT as u32),
        backend,
        "set_price",
    ) || !azt_expect_ack(net, &dose, backend, "set_dose")
    {
        azt_error(
            byte,
            runtimes,
            "Pump did not accept price or preset; order not authorized.",
        )
        .await;
        return;
    }
    // Price setting can advance Y too, so snapshot after Q/T and before '2'.
    let before = azt_query_data(net, &azt::full_data(net), backend)
        .and_then(|d| azt::parse_full_data(&d, trk))
        .and_then(|full| azt_sale_id(net, cfg, full, backend));
    let Some(before_sale_id) = before else {
        azt_error(
            byte,
            runtimes,
            "Cannot establish sale identity; order not authorized.",
        )
        .await;
        return;
    };
    let (shift_id, operator_name) = shifts.active_info().await;
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
            let loaded = rt.azt.journal_loaded;
            let json = rt.azt.journal_json.take();
            rt.azt = Default::default();
            rt.azt.journal_loaded = loaded;
            rt.azt.journal_json = json;
            rt.azt.order_price = Some(price);
            rt.azt.shift_id = shift_id;
            rt.azt.operator_name = operator_name;
            rt.azt.authorize_uncertain = true;
            rt.azt.before_sale_id = Some(before_sale_id);
            rt.state.protocol_error = None;
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
    // Ownership exists durably before authorize can reach the pump.
    if !azt_checkpoint(byte, cfg, runtimes, pool).await {
        if let Some(rt) = runtimes.write().await.get_mut(&byte) {
            rt.cancel_pre_auth();
            rt.azt.authorize_uncertain = false;
            rt.azt.order_price = None;
        }
        return;
    }
    match azt_exchange(net, &azt::authorize(net), backend) {
        Some(azt::Response::Short(azt::ACK)) => {
            if let Some(rt) = runtimes.write().await.get_mut(&byte) {
                rt.azt.authorize_uncertain = false;
            }
        }
        Some(azt::Response::Short(azt::CAN | azt::NAK)) => {
            if let Some(rt) = runtimes.write().await.get_mut(&byte) {
                rt.cancel_pre_auth();
                rt.azt.authorize_uncertain = false;
                rt.azt.order_price = None;
            }
            azt_error(
                byte,
                runtimes,
                "Pump refused authorization; order cancelled.",
            )
            .await;
            return;
        }
        _ => {
            if let Some(rt) = runtimes.write().await.get_mut(&byte) {
                rt.state.status = FpStatus::Authorizing;
            }
            azt_error(
                byte,
                runtimes,
                "Authorization acknowledgement missing; checking pump before another order.",
            )
            .await;
            return;
        }
    }
    if direct_start
        && !azt_expect_ack(
            net,
            &azt::unconditional_start(net),
            backend,
            "unconditional_start",
        )
    {
        azt_error(
            byte,
            runtimes,
            "Start not confirmed; checking pump. Order will stop if it does not start.",
        )
        .await;
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

#[cfg(test)]
#[path = "azt_tests.rs"]
mod tests;
