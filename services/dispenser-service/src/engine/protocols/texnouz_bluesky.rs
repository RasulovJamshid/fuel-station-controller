//! TexnoUz "Дополненный протокол BlueSky" runtime (controller TU_WB_KEY).
//!
//! Reached only when `cfg.connection.protocol` is `Protocol::TexnoUzBlueSky`
//! (exhaustive match in `run_poll_loop`), so it cannot affect Wayne, Gilbarco or
//! AZT.
//!
//! Master–slave over RS-485 at 9600 8E1: the service initiates every exchange
//! and the pump never speaks unprompted. Each hose owns a bus address
//! (`ADDR = base + hose number`, разд. 3), so one fueling position spans several
//! addresses — the same shape as AZT.
//!
//! Sale cycle (разд. 9):
//!   poll `0xD5` → write price `0xB2` → set dose `0xB5`/`0xB9` → wait for lift
//!   (bit 7 clears) → start `0xC3` → poll live data `0xD9` while bit 5 is set
//!   → confirmed end (holster, Stop, or reached preset) → stable final `0xD9`
//!   → persist + shift + Done. A start ACK is not evidence of fuel flowing.
//!
//! Stops are terminal (site policy, all protocols): Stop sends `0xCA`
//! and the close path records the partial sale. The protocol's pause/resume
//! (`0xBA`/`0xB3`) is deliberately left unwired.
//!
//! The pump drops the link after 5 s without a request (разд. 2), so every
//! configured hose must be visited more often than that.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use site_config::{FuelingPositionConfig, SiteConfig};
use sqlx::SqlitePool;
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing::{debug, info, warn};
use types::{preset_label, FpStatus, Preset, PumpNozzleTotals, Transaction, TxStatus, WsEvent};

use super::shared::{
    active_positions_by_byte, broadcast_status, commit_sale, exchange_serial, mark_missed,
    preset_metadata, SerialBackend,
};
use crate::engine::poll_loop::DispatchCommand;
use crate::engine::state::{CurrentTx, PreAuthContext, RuntimeFp};
use crate::shifts::ShiftCoordinator;

/// Wire money unit in soum — see `texnouz_bluesky::WIRE_MONEY_UNIT` for why this
/// is 1:1 and what still needs confirming against real hardware.
const WIRE_MONEY_UNIT: u64 = texnouz_bluesky::WIRE_MONEY_UNIT;
/// Largest price the 3-byte BCD field accepts (разд. 5).
const MAX_PRICE: u64 = texnouz_bluesky::MAX_PRICE;
/// Largest dose either 4-byte BCD field accepts.
const MAX_DOSE: u64 = texnouz_bluesky::MAX_DOSE;
/// Full-tank preset: the largest dose the pump will take, letting the nozzle's
/// own shut-off end the sale.
const FULL_TANK_CENTILITRES: u64 = MAX_DOSE;
/// A reply must arrive well inside the pump's own 5 s link timeout; silence
/// means the frame was dropped and the request is retried (разд. 9).
const EXCHANGE_RETRIES: usize = 2;

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

    // Hoses that still owe us a startup totalizer read.
    let mut pending_startup_totals: HashMap<u8, u8> = addrs.iter().map(|&a| (a, 2)).collect();
    // Remember selections made for operator commands. Idle polling addresses
    // every hose directly and must not use A1 because A1 changes the dispenser
    // display to that hose's previous transaction.
    let mut selected_hoses: HashMap<u8, u8> = HashMap::new();

    info!(?addrs, "TexnoUz BlueSky poll loop started");

    'poll_loop: loop {
        while let Ok(cmd) = commands.try_recv() {
            if let DispatchCommand::ReloadConfig { cfg: next_cfg } = cmd {
                info!("TexnoUz BlueSky poll loop reloaded site config");
                cfg = next_cfg;
                disp_by_byte = active_positions_by_byte(&cfg);
                addrs = cfg.active_addresses();
                pending_startup_totals = addrs.iter().map(|&a| (a, 2)).collect();
                selected_hoses.clear();
                interval = tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                continue 'poll_loop;
            }
            apply_command(&cfg, &runtimes, &events, &backend, &mut selected_hoses, cmd).await;
        }

        for byte in addrs.clone() {
            interval.tick().await;
            while let Ok(cmd) = commands.try_recv() {
                if let DispatchCommand::ReloadConfig { cfg: next_cfg } = cmd {
                    info!("TexnoUz BlueSky poll loop reloaded site config");
                    cfg = next_cfg;
                    disp_by_byte = active_positions_by_byte(&cfg);
                    addrs = cfg.active_addresses();
                    pending_startup_totals = addrs.iter().map(|&a| (a, 2)).collect();
                    selected_hoses.clear();
                    interval =
                        tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    continue 'poll_loop;
                }
                apply_command(&cfg, &runtimes, &events, &backend, &mut selected_hoses, cmd).await;
            }

            poll_position(
                byte,
                &cfg,
                &backend,
                &runtimes,
                &disp_by_byte,
                &events,
                &pool,
                &shifts,
                &mut pending_startup_totals,
            )
            .await;
        }
    }
}

/// Poll every hose of one fueling position, then dispatch on the active one.
///
/// All hoses are polled each rotation rather than only the active one: the pump
/// drops the link on any address left unpolled for 5 s (разд. 2), and a customer
/// can lift any hose at any time.
#[allow(clippy::too_many_arguments)]
async fn poll_position(
    byte: u8,
    cfg: &SiteConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    disp_by_byte: &HashMap<u8, FuelingPositionConfig>,
    events: &broadcast::Sender<WsEvent>,
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
    pending_startup_totals: &mut HashMap<u8, u8>,
) {
    let Some(fp_cfg) = disp_by_byte.get(&byte) else {
        return;
    };

    // The vendor application sends D5 directly to every hose. In particular,
    // it does not rotate hoses with A1 while idle: that command changes the
    // physical display to the selected hose's previous transaction.
    let statuses = poll_hose_statuses(fp_cfg, backend);

    // A sale owns one hose. Missing replies from it must never let another
    // hose's idle status or previous sale close this transaction.
    let (armed_nozzle, owns_hose) = {
        let map = runtimes.read().await;
        map.get(&byte)
            .map(|rt| {
                (
                    rt.current_tx
                        .as_ref()
                        .map(|tx| tx.nozzle_index)
                        .or(rt.pre_auth.as_ref().map(|pre| pre.nozzle_index))
                        .or(rt.bluesky.completed_nozzle)
                        .or(rt.state.nozzle_index),
                    rt.current_tx.is_some()
                        || rt.pre_auth.is_some()
                        || rt.bluesky.completed_nozzle.is_some(),
                )
            })
            .unwrap_or((None, false))
    };
    if statuses.is_empty()
        || (owns_hose && !statuses.iter().any(|(n, _, _)| Some(*n) == armed_nozzle))
    {
        if let Some(rt) = runtimes.write().await.get_mut(&byte) {
            rt.bluesky.finish_candidate = None;
        }
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
    }

    {
        let mut map = runtimes.write().await;
        if let Some(rt) = map.get_mut(&byte) {
            rt.on_poll_success();
        }
    }

    // Prefer the hose the lane is already working on, then any busy hose, then
    // any lifted one; otherwise the first that answered.
    let active = statuses
        .iter()
        .find(|(n, _, _)| owns_hose && Some(*n) == armed_nozzle)
        .or_else(|| {
            statuses
                .iter()
                .find(|(_, _, st)| st.dispensing() || st.paused())
        })
        .or_else(|| statuses.iter().find(|(n, _, _)| Some(*n) == armed_nozzle))
        .or_else(|| statuses.iter().find(|(_, _, st)| st.nozzle_lifted()))
        .copied()
        .unwrap_or(statuses[0]);
    let (nozzle_index, hose, st) = active;

    // Completion is latched independently of the desktop's Done display. A
    // late busy frame cannot create another UUID for the same lifted hose.
    let completed = runtimes
        .read()
        .await
        .get(&byte)
        .is_some_and(|rt| rt.bluesky.completed_nozzle.is_some());
    if completed {
        if st.nozzle_holstered() && !st.dispensing() && !st.paused() {
            if let Some(rt) = runtimes.write().await.get_mut(&byte) {
                rt.bluesky = Default::default();
            }
            idle_lane(byte, runtimes, events).await;
        }
        broadcast_status(byte, runtimes, events).await;
        return;
    }

    if st.error() {
        let code = query_data(hose, &texnouz_bluesky::read_error(hose), backend)
            .and_then(|d| texnouz_bluesky::parse_error_code(&d));
        warn!(
            hose,
            ?code,
            label = %fp_cfg.label,
            "BlueSky: pump reports error — clearing flag"
        );
        expect_ok(
            hose,
            &texnouz_bluesky::clear_error(hose),
            backend,
            "clear_error",
        );
    }

    if !st.remote_control() {
        // Some TU_WB_KEY units leave bit 3 clear while still accepting D5, A1,
        // and D9. Do not send E5 on every poll: the tested unit does not answer
        // it, and waiting for that timeout pushes a full hose rotation beyond
        // the documented five-second link interval. Authorization takes control
        // explicitly before sending price and dose commands.
        debug!(hose, "BlueSky: observing pump in local mode");
    }

    if st.dispensing() || st.paused() {
        update_live(byte, nozzle_index, hose, fp_cfg, cfg, backend, runtimes, st).await;
        broadcast_status(byte, runtimes, events).await;
        return;
    }

    // Not flowing also means "not started yet" or a temporary interruption.
    // The final-data path decides whether there is evidence of an actual end.
    let had_sale = {
        let map = runtimes.read().await;
        map.get(&byte)
            .map(|rt| rt.current_tx.is_some())
            .unwrap_or(false)
    };
    if had_sale {
        let finalizing = {
            let mut map = runtimes.write().await;
            map.get_mut(&byte).is_some_and(|rt| {
                if (st.nozzle_holstered() || rt.bluesky.stop_acknowledged)
                    && rt.state.status != FpStatus::Finalizing
                {
                    rt.state.status = FpStatus::Finalizing;
                    true
                } else {
                    false
                }
            })
        };
        // Publish before the potentially slow final reads. The last live meters
        // remain visible, explicitly marked as provisional until the sale commits.
        if finalizing {
            broadcast_status(byte, runtimes, events).await;
        }
        close_transaction(
            byte,
            nozzle_index,
            hose,
            fp_cfg,
            st,
            backend,
            runtimes,
            events,
            pool,
            shifts,
        )
        .await;
        broadcast_status(byte, runtimes, events).await;
        return;
    }

    // Armed pre-authorization: the dose is already on the pump, so the lift is
    // the only thing left before start (разд. 9, п. 3).
    //
    // This must be handled before the idle/nozzle-up paths below: an armed lane
    // sits holstered for as long as the customer takes, and idling it there
    // would clear `pre_auth` and silently disarm the sale.
    let armed = {
        let map = runtimes.read().await;
        map.get(&byte)
            .map(|rt| rt.pre_auth.is_some() && rt.state.status == FpStatus::PreAuthorized)
            .unwrap_or(false)
    };
    if armed {
        if runtimes
            .read()
            .await
            .get(&byte)
            .is_some_and(|rt| rt.bluesky.stop_requested)
        {
            request_stop(byte, fp_cfg, backend, runtimes, events).await;
            broadcast_status(byte, runtimes, events).await;
            return;
        }
        // Still holstered is the normal case while the customer walks up — hold
        // the armed state silently and keep waiting.
        if st.nozzle_lifted() {
            if expect_ok(
                hose,
                &texnouz_bluesky::start(hose),
                backend,
                "start_on_lift",
            ) {
                begin_delivery(byte, nozzle_index, fp_cfg, cfg, runtimes).await;
                info!(hose, label = %fp_cfg.label, "BlueSky: lift confirmed → start sent");
            } else {
                warn!(
                    hose,
                    "BlueSky: start refused after lift — retrying next poll"
                );
            }
        }
        broadcast_status(byte, runtimes, events).await;
        return;
    }

    if let Some(remaining) = pending_startup_totals.get_mut(&byte) {
        if *remaining > 0 {
            if sync_totals(byte, fp_cfg, backend, runtimes).await {
                *remaining = 0;
            } else {
                *remaining -= 1;
            }
        }
    }

    // A dose entered on the pump keypad would start a sale we never priced;
    // this site is app-controlled, so clear it (mirrors the AZT БМУ policy).
    if st.keypad_preset_ready() && !armed {
        info!(hose, "BlueSky: keypad dose rejected — app-controlled site");
        exchange(hose, &texnouz_bluesky::clear_keypad_preset(hose), backend);
    }

    if st.nozzle_lifted() {
        emit_nozzle_up(byte, nozzle_index, fp_cfg, cfg, runtimes, events).await;
    } else {
        idle_lane(byte, runtimes, events).await;
    }

    broadcast_status(byte, runtimes, events).await;
}

// ── Wire helpers ─────────────────────────────────────────────────────────────

/// Bus addresses of a position's active hoses, paired with the nozzle index.
///
/// Explicit hose addresses support double-sided dispensers whose odd addresses
/// are on one side and even addresses on the other. Older configs retain
/// `address_byte + nozzle index`.
fn hose_addresses(fp_cfg: &FuelingPositionConfig) -> Vec<(u8, u8)> {
    fp_cfg
        .nozzles
        .iter()
        .filter(|n| n.active)
        .map(|n| (n.index, hose_address(fp_cfg, n.index)))
        .collect()
}

fn hose_address(fp_cfg: &FuelingPositionConfig, nozzle_index: u8) -> u8 {
    fp_cfg
        .nozzles
        .iter()
        .find(|n| n.index == nozzle_index && n.bluesky_hose_number != 0)
        .map(|n| n.bluesky_hose_number)
        .unwrap_or_else(|| texnouz_bluesky::hose_address(fp_cfg.address_byte, nozzle_index))
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// One request/response exchange with retry. Frames with a bad CRC, wrong
/// precode or a foreign address are never answered, so silence is an ordinary
/// transient and the request is repeated (разд. 9).
fn exchange(addr: u8, frame: &[u8], backend: &SerialBackend) -> Option<texnouz_bluesky::Response> {
    exchange_with_attempts(addr, frame, backend, EXCHANGE_RETRIES)
}

fn exchange_with_attempts(
    addr: u8,
    frame: &[u8],
    backend: &SerialBackend,
    attempts: usize,
) -> Option<texnouz_bluesky::Response> {
    let expected_cmd = frame.get(frame.len().checked_sub(2)?).copied()?;
    for attempt in 0..attempts {
        let Ok(raw) = exchange_serial(backend, frame) else {
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        // Scan for our frame: the bus may carry another master's tail bytes.
        let mut cursor = 0usize;
        while cursor < raw.len() {
            let Some((frame_bytes, used)) = texnouz_bluesky::take_frame(&raw[cursor..]) else {
                break;
            };
            cursor += used;
            if let Some(r) = texnouz_bluesky::decode_response(addr, &frame_bytes) {
                if r.cmd() == expected_cmd {
                    return Some(r);
                }
                debug!(
                    addr,
                    expected_cmd,
                    received_cmd = r.cmd(),
                    "BlueSky: ignored stale reply for another command"
                );
            }
        }
        debug!(
            addr,
            attempt,
            tx = %hex(frame),
            rx = %hex(&raw),
            "BlueSky: no valid reply — retrying"
        );
    }
    None
}

/// Request remote control and consume the firmware's optional acknowledgement.
/// A single timeout is enough because this is retried whenever D5 still reports
/// local mode on a later poll.
fn take_remote_control(addr: u8, backend: &SerialBackend) {
    let _ = exchange_with_attempts(addr, &texnouz_bluesky::take_control(addr), backend, 1);
}

/// Poll one hose's status byte (0xD5).
fn query_status(addr: u8, backend: &SerialBackend) -> Option<texnouz_bluesky::BlueSkyStatus> {
    // One documented timeout keeps a disconnected hose from delaying every
    // other card. Mutating commands still use EXCHANGE_RETRIES.
    let r = exchange_with_attempts(addr, &texnouz_bluesky::read_status(addr), backend, 1)?;
    texnouz_bluesky::parse_status(r.data())
}

/// Read every hose state exposed by one TU_WB_KEY side without changing which
/// hose is shown on the dispenser display.
fn poll_hose_statuses(
    fp_cfg: &FuelingPositionConfig,
    backend: &SerialBackend,
) -> Vec<(u8, u8, texnouz_bluesky::BlueSkyStatus)> {
    hose_addresses(fp_cfg)
        .into_iter()
        .filter_map(|(index, hose)| query_status(hose, backend).map(|st| (index, hose, st)))
        .collect()
}

/// Select the hose targeted by an operator command. Price writes may succeed on
/// an unselected hose while dose writes are silently ignored, so authorization
/// must not depend on where the background polling rotation happened to stop.
fn select_hose_for_command(
    fp_cfg: &FuelingPositionConfig,
    backend: &SerialBackend,
    selected_hoses: &mut HashMap<u8, u8>,
    byte: u8,
    target: u8,
) -> bool {
    if let Some(current) = selected_hoses.get(&byte).copied() {
        if current == target {
            return true;
        }
        if expect_ok(
            current,
            &texnouz_bluesky::select_hose(current, target),
            backend,
            "select_hose_for_command",
        ) {
            selected_hoses.insert(byte, target);
            return true;
        }
    }

    // After startup the display's current hose is intentionally unknown. Try
    // A1 only now, beginning with the requested hose and then the other hoses,
    // until the controller accepts the selection.
    let mut candidates = vec![target];
    candidates.extend(
        hose_addresses(fp_cfg)
            .into_iter()
            .map(|(_, hose)| hose)
            .filter(|hose| *hose != target),
    );
    for current in candidates {
        if expect_ok(
            current,
            &texnouz_bluesky::select_hose(current, target),
            backend,
            "select_hose_for_command",
        ) {
            selected_hoses.insert(byte, target);
            return true;
        }
    }

    warn!(target, "BlueSky: cannot select target hose for command");
    false
}

/// Send a request whose reply carries data, returning that payload.
fn query_data(addr: u8, frame: &[u8], backend: &SerialBackend) -> Option<Vec<u8>> {
    let r = exchange(addr, frame, backend)?;
    let data = r.data();
    if data.is_empty() {
        None
    } else {
        Some(data.to_vec())
    }
}

/// Send a command that must be acknowledged; logs and reports failure.
fn expect_ok(addr: u8, frame: &[u8], backend: &SerialBackend, action: &'static str) -> bool {
    match exchange(addr, frame, backend) {
        Some(r) if r.status_ok() => true,
        Some(r) => {
            warn!(addr, action, "BlueSky: command refused by pump ({r:?})");
            false
        }
        None => {
            warn!(addr, action, "BlueSky: no reply to command");
            false
        }
    }
}

// ── Lane state transitions ───────────────────────────────────────────────────

fn nozzle_product(fp_cfg: &FuelingPositionConfig, cfg: &SiteConfig, index: u8) -> (u8, String) {
    let product_id = fp_cfg
        .nozzles
        .iter()
        .find(|n| n.index == index)
        .map(|n| n.product_id)
        .unwrap_or(0);
    let name = cfg
        .product(product_id)
        .map(|p| p.name.clone())
        .unwrap_or_default();
    (product_id, name)
}

fn nozzle_price(fp_cfg: &FuelingPositionConfig, rt: &RuntimeFp, index: u8) -> u32 {
    rt.nozzle_prices
        .get(&index)
        .copied()
        .or_else(|| {
            fp_cfg
                .nozzles
                .iter()
                .find(|n| n.index == index)
                .map(|n| n.price)
        })
        .unwrap_or(rt.state.price)
}

/// Read live volume/money (0xD9) and reflect it on the lane.
#[allow(clippy::too_many_arguments)]
async fn update_live(
    byte: u8,
    nozzle_index: u8,
    hose: u8,
    fp_cfg: &FuelingPositionConfig,
    cfg: &SiteConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    st: texnouz_bluesky::BlueSkyStatus,
) {
    let live = query_data(hose, &texnouz_bluesky::read_fill(hose), backend)
        .and_then(|d| texnouz_bluesky::parse_fill(&d));
    let (product_id, product_name) = nozzle_product(fp_cfg, cfg, nozzle_index);

    let mut map = runtimes.write().await;
    let Some(rt) = map.get_mut(&byte) else { return };

    let price = nozzle_price(fp_cfg, rt, nozzle_index);
    rt.bluesky.finish_candidate = None;
    rt.state.status = FpStatus::Delivering;
    rt.state.nozzle_index = Some(nozzle_index);
    rt.state.product_id = Some(product_id);
    rt.state.product_name = Some(product_name.clone());
    rt.state.price = price;
    if let Some(f) = live {
        rt.bluesky.flow_seen = true;
        rt.state.volume = f.volume_centilitres as f64 / 100.0;
        rt.state.amount = f.amount_wire * WIRE_MONEY_UNIT;
    }
    if rt.current_tx.is_none() {
        rt.current_tx = Some(CurrentTx {
            id: uuid::Uuid::new_v4().to_string(),
            started_at: Utc::now().timestamp_millis(),
            product_id,
            product_name,
            nozzle_index,
        });
    }
    if st.paused() {
        debug!(hose, "BlueSky: pump reports fill paused");
    }
    let stop_requested = rt.bluesky.stop_requested;
    drop(map);
    if stop_requested {
        // A Stop during startup may not be acknowledged until fuel actually
        // starts. Keep the same transaction and continue trying to stop it.
        let acknowledged = expect_ok(hose, &texnouz_bluesky::stop(hose), backend, "pending_stop");
        if let Some(rt) = runtimes.write().await.get_mut(&byte) {
            rt.bluesky.stop_acknowledged |= acknowledged;
        }
    }
}

/// Start was accepted; wait for dispensing status before claiming fuel flowed.
async fn begin_delivery(
    byte: u8,
    nozzle_index: u8,
    fp_cfg: &FuelingPositionConfig,
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
) {
    let (product_id, product_name) = nozzle_product(fp_cfg, cfg, nozzle_index);
    let mut map = runtimes.write().await;
    if let Some(rt) = map.get_mut(&byte) {
        rt.state.status = FpStatus::Authorizing;
        rt.state.nozzle_index = Some(nozzle_index);
        rt.state.product_id = Some(product_id);
        rt.state.product_name = Some(product_name.clone());
        rt.pre_auth = None;
        rt.pre_auth_started_at = None;
        if rt.current_tx.is_none() {
            rt.current_tx = Some(CurrentTx {
                id: uuid::Uuid::new_v4().to_string(),
                started_at: Utc::now().timestamp_millis(),
                product_id,
                product_name,
                nozzle_index,
            });
        }
    }
}

async fn emit_nozzle_up(
    byte: u8,
    nozzle_index: u8,
    fp_cfg: &FuelingPositionConfig,
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
) {
    let (product_id, product_name) = nozzle_product(fp_cfg, cfg, nozzle_index);
    let product_color = cfg
        .product(product_id)
        .map(|p| p.color.clone())
        .unwrap_or_default();

    let (changed, price) = {
        let mut map = runtimes.write().await;
        let Some(rt) = map.get_mut(&byte) else {
            return;
        };
        let price = nozzle_price(fp_cfg, rt, nozzle_index);
        let can_transition = matches!(
            rt.state.status,
            FpStatus::Idle | FpStatus::NozzleUp | FpStatus::Offline
        );
        let changed = can_transition
            && (rt.state.status != FpStatus::NozzleUp
                || rt.state.nozzle_index != Some(nozzle_index));
        if can_transition {
            rt.state.status = FpStatus::NozzleUp;
            rt.state.nozzle_index = Some(nozzle_index);
            rt.state.product_id = Some(product_id);
            rt.state.product_name = Some(product_name.clone());
            rt.state.price = price;
        }
        (changed, price)
    };

    if changed {
        let _ = events.send(WsEvent::NozzleUp {
            fp_id: fp_cfg.id.clone(),
            nozzle_index,
            product_id,
            product_name,
            product_color,
            price,
        });
    }
}

/// Return a genuinely idle lane to Idle. A stopped sale stays put until the
/// operator acts, mirroring Gilbarco and AZT.
async fn idle_lane(
    byte: u8,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
) {
    let became_idle = {
        let mut map = runtimes.write().await;
        let Some(rt) = map.get_mut(&byte) else {
            return;
        };
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
    };
    if became_idle {
        broadcast_status(byte, runtimes, events).await;
    }
}

/// Read the lifetime totalizer (0xC5) for every hose and cache it on the lane.
async fn sync_totals(
    byte: u8,
    fp_cfg: &FuelingPositionConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
) -> bool {
    let mut per_nozzle: Vec<PumpNozzleTotals> = Vec::new();
    for (nozzle_index, hose) in hose_addresses(fp_cfg) {
        let Some(t) = query_data(hose, &texnouz_bluesky::read_total(hose), backend)
            .and_then(|d| texnouz_bluesky::parse_totals(&d))
        else {
            continue;
        };
        per_nozzle.push(PumpNozzleTotals {
            nozzle_index,
            volume: t.volume_centilitres as f64 / 100.0,
            amount: t.amount_wire * WIRE_MONEY_UNIT,
            price: 0,
        });
    }
    if per_nozzle.is_empty() {
        return false;
    }
    let mut map = runtimes.write().await;
    if let Some(rt) = map.get_mut(&byte) {
        rt.state.pump_total_volume = Some(per_nozzle.iter().map(|t| t.volume).sum());
        rt.state.pump_total_amount = Some(per_nozzle.iter().map(|t| t.amount).sum());
        rt.state.pump_totals = per_nozzle;
    }
    true
}

/// Read the final dispense data and record the sale.
#[allow(clippy::too_many_arguments)]
async fn close_transaction(
    byte: u8,
    nozzle_index: u8,
    hose: u8,
    fp_cfg: &FuelingPositionConfig,
    st: texnouz_bluesky::BlueSkyStatus,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
) -> bool {
    let fill = query_data(hose, &texnouz_bluesky::read_fill(hose), backend)
        .and_then(|d| texnouz_bluesky::parse_fill(&d));

    let (ctx, state_price, preset) = {
        let map = runtimes.read().await;
        let Some(rt) = map.get(&byte) else {
            return false;
        };
        (
            rt.current_tx.clone(),
            rt.state.price,
            rt.last_preset.clone(),
        )
    };

    let Some(fill) = fill else {
        if let Some(rt) = runtimes.write().await.get_mut(&byte) {
            rt.bluesky.finish_candidate = None;
        }
        warn!(
            hose,
            "BlueSky: refusing to save transaction without final data"
        );
        return false;
    };

    let Some(ctx) = ctx else {
        return false;
    };
    if ctx.nozzle_index != nozzle_index {
        return false;
    }

    // D9 may span a status change. Only count a candidate when the same hose
    // still reports stopped afterwards; a missing reply breaks confirmation.
    let after = query_status(hose, backend);
    let confirmed = {
        let mut map = runtimes.write().await;
        let Some(rt) = map.get_mut(&byte) else {
            return false;
        };
        let target_reached = rt.bluesky.flow_seen && preset_reached(&preset, fill);
        let terminal = |status: texnouz_bluesky::BlueSkyStatus| {
            !status.dispensing()
                && !status.paused()
                && (status.nozzle_holstered() || rt.bluesky.stop_acknowledged || target_reached)
        };
        // Never replace actual observed delivery with an older final reply.
        let regressed = rt.bluesky.flow_seen
            && (fill.volume_centilitres as f64 / 100.0 < rt.state.volume
                || fill.amount_wire * WIRE_MONEY_UNIT < rt.state.amount);
        if !terminal(st) || !after.is_some_and(terminal) || regressed {
            rt.bluesky.finish_candidate = None;
            false
        } else {
            rt.state.status = FpStatus::Finalizing;
            rt.bluesky
                .confirm_finish(fill, Utc::now().timestamp_millis())
        }
    };
    if !confirmed {
        return false;
    }

    let volume = fill.volume_centilitres as f64 / 100.0;
    let amount = fill.amount_wire * WIRE_MONEY_UNIT;
    // Prefer the pump's own price if it reports a consistent one; otherwise keep
    // the price the sale was authorized at.
    let price = query_data(hose, &texnouz_bluesky::read_price(hose), backend)
        .and_then(|d| texnouz_bluesky::parse_price(&d))
        .and_then(|p| u32::try_from(p * WIRE_MONEY_UNIT).ok())
        .filter(|p| *p > 0)
        .unwrap_or(state_price);

    let (shift_id, operator_name) = shifts.active_info().await;
    let (preset_type, preset_value, preset_label) = preset_metadata(&preset);
    let tx = Transaction {
        id: ctx.id.clone(),
        fp_id: fp_cfg.id.clone(),
        label: fp_cfg.label.clone(),
        address_byte: byte,
        started_at: ctx.started_at,
        completed_at: Some(Utc::now().timestamp_millis()),
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

    if !commit_sale(pool, shifts, events, &tx).await {
        return false;
    }

    {
        let mut map = runtimes.write().await;
        if let Some(rt) = map.get_mut(&byte) {
            rt.state.status = FpStatus::Done;
            rt.state.volume = volume;
            rt.state.amount = amount;
            rt.current_tx = None;
            rt.pre_auth = None;
            rt.bluesky.completed_nozzle = Some(ctx.nozzle_index);
            rt.bluesky.finish_candidate = None;
        }
    }
    let _ = sync_totals(byte, fp_cfg, backend, runtimes).await;
    info!(hose, volume, amount, "BlueSky: transaction complete");
    true
}

// ── Commands ─────────────────────────────────────────────────────────────────

fn preset_reached(preset: &Preset, fill: texnouz_bluesky::FillData) -> bool {
    match preset {
        Preset::Volume(litres) => fill.volume_centilitres >= (litres * 100.0).round() as u64,
        Preset::Amount(amount) => fill.amount_wire * WIRE_MONEY_UNIT >= *amount,
        Preset::Str(_) => false, // Full tank and partial fills end on Stop/holster.
    }
}

fn can_authorize(rt: &RuntimeFp) -> bool {
    matches!(rt.state.status, FpStatus::Idle | FpStatus::NozzleUp)
        && rt.current_tx.is_none()
        && rt.pre_auth.is_none()
        && rt.bluesky.completed_nozzle.is_none()
}

/// Stop intent must survive startup and lost replies, without discarding the
/// current transaction or publishing a fictitious already-persisted STOPPED row.
async fn request_stop(
    byte: u8,
    fp: &FuelingPositionConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
) {
    let pending = {
        let mut map = runtimes.write().await;
        let Some(rt) = map.get_mut(&byte) else { return };
        let nozzle = rt
            .current_tx
            .as_ref()
            .map(|tx| tx.nozzle_index)
            .or(rt.pre_auth.as_ref().map(|pre| pre.nozzle_index));
        nozzle.map(|n| {
            rt.bluesky.stop_requested = true;
            rt.bluesky.finish_candidate = None;
            (n, rt.current_tx.is_none())
        })
    };
    let Some((nozzle, armed_only)) = pending else {
        return;
    };
    let hose = hose_address(fp, nozzle);
    let cleared = armed_only
        && expect_ok(
            hose,
            &texnouz_bluesky::clear_keypad_preset(hose),
            backend,
            "cancel_dose",
        );
    let acknowledged = expect_ok(hose, &texnouz_bluesky::stop(hose), backend, "stop");
    if let Some(rt) = runtimes.write().await.get_mut(&byte) {
        rt.bluesky.stop_acknowledged |= acknowledged;
        if cleared {
            rt.cancel_pre_auth();
            rt.bluesky.completed_nozzle = Some(nozzle);
            rt.state.nozzle_index = Some(nozzle);
            rt.state.status = FpStatus::Done;
            let _ = events.send(WsEvent::PreAuthCancelled {
                fp_id: fp.id.clone(),
            });
        }
    }
}

async fn dismiss_if_safe(
    byte: u8,
    fp: &FuelingPositionConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
) {
    let mut map = runtimes.write().await;
    if let Some(rt) = map.get_mut(&byte) {
        // Only polling may release the completed hose after physical holster.
        if can_authorize(rt) && rt.state.status == FpStatus::Idle {
            rt.reset_for_operator(fp);
            rt.bluesky = Default::default();
        } else {
            warn!(
                byte,
                "BlueSky: display reset ignored until sale ends and nozzle is holstered"
            );
        }
    }
}

/// Convert a preset into the dose command for `hose`, or an error to surface.
fn dose_frame(hose: u8, preset: &Preset, price: u32) -> Result<Vec<u8>, &'static str> {
    match preset {
        Preset::Str(s) if s.eq_ignore_ascii_case("full") => {
            texnouz_bluesky::dose_by_volume(hose, FULL_TANK_CENTILITRES).ok_or("full-tank dose")
        }
        Preset::Str(_) => Err("unsupported preset"),
        Preset::Volume(litres) => {
            let cl = (litres * 100.0).round() as u64;
            if cl == 0 {
                return Err("volume preset is zero");
            }
            texnouz_bluesky::dose_by_volume(hose, cl).ok_or("volume preset exceeds pump limit")
        }
        Preset::Amount(sum) => {
            if price == 0 {
                return Err("price is zero");
            }
            let wire = sum / WIRE_MONEY_UNIT;
            if wire == 0 {
                return Err("amount preset is zero");
            }
            texnouz_bluesky::dose_by_amount(hose, wire).ok_or("amount preset exceeds pump limit")
        }
    }
}

/// Arm a hose: take control, write the price, set the dose, and start if the
/// nozzle is already lifted. `nozzle_index` selects the hose.
#[allow(clippy::too_many_arguments)]
async fn do_authorize(
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    backend: &SerialBackend,
    selected_hoses: &mut HashMap<u8, u8>,
    byte: u8,
    price: u32,
    preset: Preset,
    nozzle_index: Option<u8>,
) {
    let Some(fp_cfg) = cfg.position_by_address(byte).cloned() else {
        return;
    };

    // HTTP requests can queue while the first authorization is still being
    // processed. Recheck here, at execution time, before any mutating command.
    if !runtimes.read().await.get(&byte).is_some_and(can_authorize) {
        warn!(
            byte,
            "BlueSky: authorization ignored — previous sale still owns the lane"
        );
        return;
    }

    // Choose the hose: the requested nozzle, else the lifted one, else the first.
    let nozzle_index = match nozzle_index {
        Some(n) => n,
        None => {
            let map = runtimes.read().await;
            map.get(&byte)
                .and_then(|rt| rt.state.nozzle_index)
                .or_else(|| fp_cfg.nozzles.iter().find(|n| n.active).map(|n| n.index))
                .unwrap_or(1)
        }
    };
    let hose = hose_address(&fp_cfg, nozzle_index);
    if !fp_cfg
        .nozzles
        .iter()
        .any(|n| n.index == nozzle_index && n.active)
    {
        return;
    }
    if !query_status(hose, backend).is_some_and(|st| !st.dispensing() && !st.paused()) {
        warn!(
            hose,
            "BlueSky: authorization refused — hose busy or status unavailable"
        );
        return;
    }

    if !select_hose_for_command(&fp_cfg, backend, selected_hoses, byte, hose) {
        warn!(
            hose,
            "BlueSky: target hose selection failed — authorize aborted"
        );
        return;
    }

    take_remote_control(hose, backend);

    // Price first: the pump computes money from its own price register.
    let wire_price = price as u64 / WIRE_MONEY_UNIT;
    if wire_price == 0 || wire_price > MAX_PRICE {
        warn!(
            hose,
            price, "BlueSky: price out of range — authorize aborted"
        );
        return;
    }
    if let Some(f) = texnouz_bluesky::write_price(hose, wire_price) {
        if !expect_ok(hose, &f, backend, "write_price") {
            warn!(hose, "BlueSky: price write refused — authorize aborted");
            return;
        }
    }

    let frame = match dose_frame(hose, &preset, price) {
        Ok(f) => f,
        Err(e) => {
            warn!(hose, error = e, ?preset, "BlueSky: dose rejected");
            return;
        }
    };
    if !expect_ok(hose, &frame, backend, "set_dose") {
        warn!(hose, "BlueSky: dose refused — authorize aborted");
        return;
    }

    let (product_id, product_name) = nozzle_product(&fp_cfg, cfg, nozzle_index);
    let lifted = query_status(hose, backend).map(|st| st.nozzle_lifted());

    {
        let mut map = runtimes.write().await;
        if let Some(rt) = map.get_mut(&byte) {
            rt.bluesky = Default::default();
            rt.state.volume = 0.0;
            rt.state.amount = 0;
            rt.state.price = price;
            rt.state.nozzle_index = Some(nozzle_index);
            rt.state.product_id = Some(product_id);
            rt.state.product_name = Some(product_name.clone());
            rt.set_last_preset(preset.clone());
            rt.pre_auth = Some(PreAuthContext {
                nozzle_index,
                product_id,
            });
            rt.pre_auth_started_at = Some(Utc::now().timestamp_millis());
            rt.state.status = FpStatus::PreAuthorized;
            rt.state.pre_auth_preset = Some(preset_label(&preset));
        }
    }

    // Дозу можно ставить при повешенном пистолете; старт — только после снятия
    // (разд. 9, п. 3). If it is already lifted, start immediately.
    if lifted == Some(true) {
        if expect_ok(hose, &texnouz_bluesky::start(hose), backend, "start") {
            begin_delivery(byte, nozzle_index, &fp_cfg, cfg, runtimes).await;
            info!(hose, label = %fp_cfg.label, ?preset, "BlueSky: authorized and started");
        } else {
            warn!(hose, "BlueSky: start refused — waiting for next poll");
        }
    } else {
        info!(hose, label = %fp_cfg.label, ?preset, "BlueSky: dose armed, waiting for lift");
    }

    broadcast_status(byte, runtimes, events).await;
}

async fn apply_command(
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    backend: &SerialBackend,
    selected_hoses: &mut HashMap<u8, u8>,
    cmd: DispatchCommand,
) {
    match cmd {
        DispatchCommand::ReloadConfig { .. } => {}

        DispatchCommand::Authorize {
            byte,
            price,
            preset,
        } => {
            do_authorize(
                cfg,
                runtimes,
                events,
                backend,
                selected_hoses,
                byte,
                price,
                preset,
                None,
            )
            .await;
        }

        DispatchCommand::Preauthorize {
            byte,
            price,
            preset,
            nozzle_index,
        } => {
            do_authorize(
                cfg,
                runtimes,
                events,
                backend,
                selected_hoses,
                byte,
                price,
                preset,
                Some(nozzle_index),
            )
            .await;
        }

        // Stops are terminal on this site — the protocol's pause/resume
        // (0xBA/0xB3) is deliberately not exposed. Same policy as Gilbarco/AZT.
        DispatchCommand::Stop { byte } => {
            let Some(fp_cfg) = cfg.position_by_address(byte).cloned() else {
                return;
            };
            request_stop(byte, &fp_cfg, backend, runtimes, events).await;
            broadcast_status(byte, runtimes, events).await;
        }

        DispatchCommand::EStop => {
            for fp in cfg.active_positions() {
                request_stop(fp.address_byte, fp, backend, runtimes, events).await;
                for (_, hose) in hose_addresses(fp) {
                    expect_ok(hose, &texnouz_bluesky::stop(hose), backend, "estop");
                }
            }
            warn!("BlueSky: emergency stop sent to every hose");
            let bytes: Vec<u8> = cfg.active_addresses();
            for byte in bytes {
                broadcast_status(byte, runtimes, events).await;
            }
        }

        DispatchCommand::CancelPreauth { byte } => {
            let Some(fp_cfg) = cfg.position_by_address(byte).cloned() else {
                return;
            };
            // The command may have been queued before a lift/start. It must
            // stop that same session, never erase a now-running transaction.
            request_stop(byte, &fp_cfg, backend, runtimes, events).await;
            broadcast_status(byte, runtimes, events).await;
        }

        DispatchCommand::ResetLane { byte } => {
            let Some(fp_cfg) = cfg.position_by_address(byte).cloned() else {
                return;
            };
            dismiss_if_safe(byte, &fp_cfg, runtimes).await;
            broadcast_status(byte, runtimes, events).await;
        }

        DispatchCommand::ResetAll => {
            for fp in cfg.active_positions() {
                let byte = fp.address_byte;
                dismiss_if_safe(byte, fp, runtimes).await;
                broadcast_status(byte, runtimes, events).await;
            }
        }

        DispatchCommand::UpdatePrices {
            updates,
            changed_by,
        } => {
            // Unlike AZT's JIT pricing, this pump holds a price register, so the
            // new price is written to the hose now as well as cached for the
            // next authorize.
            for u in updates {
                let Some(fp_cfg) = cfg.position_by_id(&u.fp_id).cloned() else {
                    continue;
                };
                let hose = hose_address(&fp_cfg, u.nozzle_index);
                let wire = u.price as u64 / WIRE_MONEY_UNIT;
                if wire == 0 || wire > MAX_PRICE {
                    warn!(
                        hose,
                        price = u.price,
                        "BlueSky: price out of range — skipped"
                    );
                    continue;
                }
                match texnouz_bluesky::write_price(hose, wire) {
                    Some(f) if expect_ok(hose, &f, backend, "update_price") => {}
                    _ => {
                        warn!(hose, "BlueSky: price write refused — cached anyway");
                    }
                }

                let product_name = fp_cfg
                    .nozzles
                    .iter()
                    .find(|n| n.index == u.nozzle_index)
                    .and_then(|n| cfg.product(n.product_id).map(|p| p.name.clone()))
                    .unwrap_or_default();
                let old = {
                    let mut map = runtimes.write().await;
                    map.get_mut(&fp_cfg.address_byte)
                        .map(|rt| rt.set_nozzle_price(u.nozzle_index, u.price))
                };
                if let Some(old_price) = old {
                    let _ = events.send(WsEvent::PriceUpdated {
                        fp_id: u.fp_id.clone(),
                        nozzle_index: u.nozzle_index,
                        product_name,
                        old_price,
                        new_price: u.price,
                        changed_by: changed_by.clone(),
                    });
                }
                broadcast_status(fp_cfg.address_byte, runtimes, events).await;
            }
        }

        DispatchCommand::RefreshTotals => {
            for fp in cfg.active_positions() {
                let busy = {
                    let map = runtimes.read().await;
                    map.get(&fp.address_byte)
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
                let _ = sync_totals(fp.address_byte, fp, backend, runtimes).await;
                broadcast_status(fp.address_byte, runtimes, events).await;
            }
        }
    }
}

#[cfg(test)]
#[path = "texnouz_bluesky_tests.rs"]
mod lifecycle_tests;

#[cfg(test)]
mod tests {
    use super::super::shared::FakeSerial;
    use super::*;
    use site_config::{NozzleConfig, Parity, Protocol};
    use std::sync::Mutex;

    fn fp(address_byte: u8, nozzles: &[(u8, bool)]) -> FuelingPositionConfig {
        FuelingPositionConfig {
            id: "FP1".into(),
            label: "1".into(),
            address_byte,
            active: true,
            nozzles: nozzles
                .iter()
                .map(|(index, active)| NozzleConfig {
                    index: *index,
                    product_id: 1,
                    price: 11_300,
                    active: *active,
                    bluesky_hose_number: 0,
                    azt_address: 0,
                    wayne_code: 0,
                    wayne_product_code: 0,
                })
                .collect(),
        }
    }

    #[test]
    fn hose_addresses_are_base_plus_nozzle_index() {
        // разд. 3: ADDR = базовый адрес + номер рукава.
        let cfg = fp(0x10, &[(1, true), (2, true), (3, true)]);
        assert_eq!(hose_addresses(&cfg), vec![(1, 0x11), (2, 0x12), (3, 0x13)]);
    }

    #[test]
    fn inactive_nozzles_are_not_polled() {
        let cfg = fp(0x00, &[(1, true), (2, false)]);
        assert_eq!(hose_addresses(&cfg), vec![(1, 0x01)]);
    }

    #[test]
    fn idle_poll_reads_every_hose_without_a1_selection() {
        let cfg = fp(0x10, &[(1, true), (2, true)]);
        let fake = Arc::new(Mutex::new(FakeSerial::new([
            texnouz_bluesky::build_request(0x11, 0xD5, &[0x88]).unwrap(),
            texnouz_bluesky::build_request(0x12, 0xD5, &[0x08]).unwrap(),
        ])));
        let backend = SerialBackend::Fake(fake.clone());

        let statuses = poll_hose_statuses(&cfg, &backend);
        assert_eq!(statuses.len(), 2);
        assert!(!statuses[0].2.nozzle_lifted());
        assert!(statuses[1].2.nozzle_lifted());
        assert_eq!(
            fake.lock().unwrap().written(),
            &[
                texnouz_bluesky::read_status(0x11),
                texnouz_bluesky::read_status(0x12),
            ]
        );
    }

    #[test]
    fn operator_command_selects_its_target_hose_before_authorization() {
        let cfg = fp(0x10, &[(1, true), (3, true)]);
        let fake = Arc::new(Mutex::new(FakeSerial::new([
            texnouz_bluesky::build_request(0x11, 0xA1, &[0x59]).unwrap(),
        ])));
        let backend = SerialBackend::Fake(fake.clone());
        let mut selected = HashMap::from([(0x10, 0x11)]);

        assert!(select_hose_for_command(
            &cfg,
            &backend,
            &mut selected,
            0x10,
            0x13
        ));
        assert_eq!(selected.get(&0x10), Some(&0x13));
        assert_eq!(
            fake.lock().unwrap().written(),
            &[texnouz_bluesky::select_hose(0x11, 0x13)]
        );
    }

    #[test]
    fn operator_command_locates_unknown_selection_only_when_needed() {
        let cfg = fp(0x10, &[(1, true), (3, true)]);
        let fake = Arc::new(Mutex::new(FakeSerial::new([
            Vec::new(),
            Vec::new(),
            texnouz_bluesky::build_request(0x11, 0xA1, &[0x59]).unwrap(),
        ])));
        let backend = SerialBackend::Fake(fake.clone());
        let mut selected = HashMap::new();

        assert!(select_hose_for_command(
            &cfg,
            &backend,
            &mut selected,
            0x10,
            0x13
        ));
        assert_eq!(selected.get(&0x10), Some(&0x13));

        let fake = fake.lock().unwrap();
        assert_eq!(fake.remaining(), 0);
        assert_eq!(
            fake.written(),
            &[
                texnouz_bluesky::select_hose(0x13, 0x13),
                texnouz_bluesky::select_hose(0x13, 0x13),
                texnouz_bluesky::select_hose(0x11, 0x13),
            ]
        );
    }

    #[test]
    fn stale_reply_for_another_command_is_not_accepted() {
        let fake = Arc::new(Mutex::new(FakeSerial::new([
            texnouz_bluesky::take_control(0x11),
            texnouz_bluesky::build_request(0x11, 0xA1, &[0x59]).unwrap(),
        ])));
        let backend = SerialBackend::Fake(fake.clone());

        assert!(expect_ok(
            0x11,
            &texnouz_bluesky::select_hose(0x11, 0x13),
            &backend,
            "test_select"
        ));
        assert_eq!(fake.lock().unwrap().remaining(), 0);
    }

    #[test]
    fn shipped_real_config_uses_bluesky_serial_format_and_unique_hose_addresses() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("site.config.texnouz-bluesky.json");
        let cfg = SiteConfig::load(path.to_str().expect("UTF-8 config path"))
            .expect("valid TexnoUz BlueSky config");

        assert_eq!(cfg.connection.protocol, Protocol::TexnoUzBlueSky);
        assert_eq!(cfg.connection.baud_rate, 9_600);
        assert_eq!(cfg.connection.parity, Parity::Even);
        assert_eq!(cfg.connection.data_bits, 8);
        assert_eq!(cfg.connection.stop_bits, 1);
        assert_eq!(cfg.polling.interval_ms, 150);

        let sides: Vec<(&str, &str)> = cfg
            .active_positions()
            .into_iter()
            .map(|fp| (fp.id.as_str(), fp.label.as_str()))
            .collect();
        assert_eq!(
            sides,
            vec![
                ("FP1", "Side 1"),
                ("FP2", "Side 2"),
                ("FP11", "Side 11"),
                ("FP12", "Side 12"),
                ("FP21", "Side 21"),
                ("FP22", "Side 22"),
            ]
        );
        for fp in cfg.active_positions() {
            let product_ids: Vec<u8> = fp.nozzles.iter().map(|n| n.product_id).collect();
            assert_eq!(product_ids, vec![3, 6, 5, 4]);
        }

        let configured_hoses: Vec<Vec<u8>> = cfg
            .active_positions()
            .into_iter()
            .map(|fp| fp.nozzles.iter().map(|n| n.bluesky_hose_number).collect())
            .collect();
        assert_eq!(
            configured_hoses,
            vec![
                vec![1, 3, 5, 7],
                vec![2, 4, 6, 8],
                vec![11, 13, 15, 17],
                vec![12, 14, 16, 18],
                vec![21, 23, 25, 27],
                vec![22, 24, 26, 28],
            ]
        );

        let side_hoses: Vec<(u8, Vec<u8>)> = cfg
            .active_positions()
            .into_iter()
            .map(|fp| {
                (
                    fp.address_byte,
                    hose_addresses(fp)
                        .into_iter()
                        .map(|(_, address)| address)
                        .collect(),
                )
            })
            .collect();
        assert_eq!(
            side_hoses,
            vec![
                (1, vec![1, 3, 5, 7]),
                (2, vec![2, 4, 6, 8]),
                (11, vec![11, 13, 15, 17]),
                (12, vec![12, 14, 16, 18]),
                (21, vec![21, 23, 25, 27]),
                (22, vec![22, 24, 26, 28]),
            ]
        );

        let addresses: Vec<u8> = cfg
            .active_positions()
            .into_iter()
            .flat_map(|fp| hose_addresses(fp).into_iter().map(|(_, address)| address))
            .collect();
        let unique: std::collections::HashSet<u8> = addresses.iter().copied().collect();
        assert_eq!(
            addresses.len(),
            unique.len(),
            "hose addresses must not overlap"
        );
    }

    #[test]
    fn volume_preset_encodes_hundredths_of_a_litre() {
        let f = dose_frame(0x01, &Preset::Volume(12.34), 11_300).unwrap();
        assert_eq!(f, texnouz_bluesky::dose_by_volume(0x01, 1234).unwrap());
    }

    #[test]
    fn amount_preset_uses_the_money_command() {
        let f = dose_frame(0x01, &Preset::Amount(20_000), 11_300).unwrap();
        assert_eq!(
            f,
            texnouz_bluesky::dose_by_amount(0x01, 20_000 / WIRE_MONEY_UNIT).unwrap()
        );
    }

    #[test]
    fn full_tank_uses_the_largest_dose_the_pump_accepts() {
        let f = dose_frame(0x01, &Preset::Str("full".into()), 11_300).unwrap();
        assert_eq!(
            f,
            texnouz_bluesky::dose_by_volume(0x01, FULL_TANK_CENTILITRES).unwrap()
        );
    }

    #[test]
    fn zero_and_oversized_presets_are_refused() {
        assert!(dose_frame(0x01, &Preset::Volume(0.0), 11_300).is_err());
        assert!(dose_frame(0x01, &Preset::Amount(0), 11_300).is_err());
        assert!(
            dose_frame(0x01, &Preset::Amount(1_000), 0).is_err(),
            "zero price"
        );
        assert!(
            dose_frame(0x01, &Preset::Volume(9_999_999.0), 11_300).is_err(),
            "beyond the 4-byte BCD field"
        );
    }
}
