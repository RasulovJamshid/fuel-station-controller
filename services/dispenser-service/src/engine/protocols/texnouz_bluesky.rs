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
//!   → bit 5 clears → read final `0xD9` → persist + shift + Done.
//!
//! Stops are terminal (site policy, as for Gilbarco and AZT): Stop sends `0xCA`
//! and the close path records the partial sale. The protocol's pause/resume
//! (`0xBA`/`0xB3`) is deliberately not wired to ContinueFill/ResumeFill.
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
use types::{
    preset_label, FpStatus, Preset, PumpNozzleTotals, StopSource, Transaction, TxStatus, WsEvent,
};

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

    info!(?addrs, "TexnoUz BlueSky poll loop started");

    // Take remote control of every hose once at startup: the pump only honours
    // commands while status bit 3 is set (разд. 7).
    for &byte in &addrs {
        if let Some(fp_cfg) = disp_by_byte.get(&byte) {
            for (_, hose) in hose_addresses(fp_cfg) {
                exchange(hose, &texnouz_bluesky::take_control(hose), &backend);
            }
        }
    }

    'poll_loop: loop {
        while let Ok(cmd) = commands.try_recv() {
            if let DispatchCommand::ReloadConfig { cfg: next_cfg } = cmd {
                info!("TexnoUz BlueSky poll loop reloaded site config");
                cfg = next_cfg;
                disp_by_byte = active_positions_by_byte(&cfg);
                addrs = cfg.active_addresses();
                pending_startup_totals = addrs.iter().map(|&a| (a, 2)).collect();
                interval = tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                continue 'poll_loop;
            }
            apply_command(&cfg, &runtimes, &events, &backend, cmd).await;
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
                    interval =
                        tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    continue 'poll_loop;
                }
                apply_command(&cfg, &runtimes, &events, &backend, cmd).await;
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

    // Poll every hose so none of them times the link out, and remember which one
    // is doing something so a multi-hose position lands on the busy nozzle.
    let mut statuses: Vec<(u8, u8, texnouz_bluesky::BlueSkyStatus)> = Vec::new();
    for (nozzle_index, hose) in hose_addresses(fp_cfg) {
        if let Some(st) = query_status(hose, backend) {
            statuses.push((nozzle_index, hose, st));
        }
    }

    if statuses.is_empty() {
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
    let armed_nozzle = {
        let map = runtimes.read().await;
        map.get(&byte).and_then(|rt| rt.state.nozzle_index)
    };
    let active = statuses
        .iter()
        .find(|(n, _, st)| Some(*n) == armed_nozzle && (st.dispensing() || st.paused()))
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
        // The pump ignores commands in local mode; re-assert control and wait for
        // the next poll to observe bit 3.
        debug!(hose, "BlueSky: pump in local mode — re-taking control");
        exchange(hose, &texnouz_bluesky::take_control(hose), backend);
    }

    if st.dispensing() || st.paused() {
        update_live(byte, nozzle_index, hose, fp_cfg, cfg, backend, runtimes, st).await;
        broadcast_status(byte, runtimes, events).await;
        return;
    }

    // Not flowing. If we believed a sale was running, it has just ended.
    let had_sale = {
        let map = runtimes.read().await;
        map.get(&byte)
            .map(|rt| {
                matches!(
                    rt.state.status,
                    FpStatus::Delivering | FpStatus::Authorizing | FpStatus::Stopped { .. }
                ) || rt.current_tx.is_some()
            })
            .unwrap_or(false)
    };
    if had_sale {
        close_transaction(
            byte,
            nozzle_index,
            hose,
            fp_cfg,
            cfg,
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
/// `ADDR = base + hose number` (разд. 3); the position's `address_byte` is the
/// base and the nozzle index is the hose number.
fn hose_addresses(fp_cfg: &FuelingPositionConfig) -> Vec<(u8, u8)> {
    fp_cfg
        .nozzles
        .iter()
        .filter(|n| n.active)
        .map(|n| {
            (
                n.index,
                texnouz_bluesky::hose_address(fp_cfg.address_byte, n.index),
            )
        })
        .collect()
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
    for attempt in 0..EXCHANGE_RETRIES {
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
                return Some(r);
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

/// Poll one hose's status byte (0xD5).
fn query_status(addr: u8, backend: &SerialBackend) -> Option<texnouz_bluesky::BlueSkyStatus> {
    let r = exchange(addr, &texnouz_bluesky::read_status(addr), backend)?;
    texnouz_bluesky::parse_status(r.data())
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
    rt.state.status = FpStatus::Delivering;
    rt.state.nozzle_index = Some(nozzle_index);
    rt.state.product_id = Some(product_id);
    rt.state.product_name = Some(product_name.clone());
    rt.state.price = price;
    if let Some(f) = live {
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
}

/// Move a lane into delivery after a successful start.
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
        rt.state.status = FpStatus::Delivering;
        rt.state.nozzle_index = Some(nozzle_index);
        rt.state.product_id = Some(product_id);
        rt.state.product_name = Some(product_name.clone());
        rt.pre_auth = None;
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
    cfg: &SiteConfig,
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
        warn!(
            hose,
            "BlueSky: refusing to save transaction without final data"
        );
        return false;
    };

    let ctx = match ctx {
        Some(c) => c,
        None => {
            if fill.volume_centilitres == 0 {
                // Nothing dispensed and no sale of ours — just idle the lane.
                idle_lane(byte, runtimes, events).await;
                return false;
            }
            let (product_id, product_name) = nozzle_product(fp_cfg, cfg, nozzle_index);
            CurrentTx {
                id: uuid::Uuid::new_v4().to_string(),
                started_at: Utc::now().timestamp_millis(),
                product_id,
                product_name,
                nozzle_index,
            }
        }
    };

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
        }
    }
    let _ = sync_totals(byte, fp_cfg, backend, runtimes).await;
    info!(hose, volume, amount, "BlueSky: transaction complete");
    true
}

// ── Commands ─────────────────────────────────────────────────────────────────

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
    byte: u8,
    price: u32,
    preset: Preset,
    nozzle_index: Option<u8>,
) {
    let Some(fp_cfg) = cfg.position_by_address(byte).cloned() else {
        return;
    };

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
    let hose = texnouz_bluesky::hose_address(fp_cfg.address_byte, nozzle_index);

    exchange(hose, &texnouz_bluesky::take_control(hose), backend);

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
    cmd: DispatchCommand,
) {
    match cmd {
        DispatchCommand::ReloadConfig { .. } => {}

        DispatchCommand::Authorize {
            byte,
            price,
            preset,
        } => {
            do_authorize(cfg, runtimes, events, backend, byte, price, preset, None).await;
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
                byte,
                price,
                preset,
                Some(nozzle_index),
            )
            .await;
        }

        // Stops are terminal on this site — the protocol's pause/resume
        // (0xBA/0xB3) is deliberately not exposed. Same policy as Gilbarco/AZT.
        DispatchCommand::ContinueFill { .. } | DispatchCommand::ResumeFill { .. } => {}

        DispatchCommand::Stop { byte } => {
            let Some(fp_cfg) = cfg.position_by_address(byte).cloned() else {
                return;
            };
            let nozzle_index = {
                let map = runtimes.read().await;
                map.get(&byte).and_then(|rt| rt.state.nozzle_index)
            };
            let hose = texnouz_bluesky::hose_address(
                fp_cfg.address_byte,
                nozzle_index.unwrap_or_else(|| {
                    fp_cfg
                        .nozzles
                        .iter()
                        .find(|n| n.active)
                        .map(|n| n.index)
                        .unwrap_or(1)
                }),
            );
            // 0xCA is answered only while a fill is running (разд. 6).
            expect_ok(hose, &texnouz_bluesky::stop(hose), backend, "stop");

            let stopped = {
                let mut map = runtimes.write().await;
                match map.get_mut(&byte) {
                    Some(rt) if !rt.state.status.is_stopped() => {
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
                        Some((vol, amt, tx_id))
                    }
                    _ => None,
                }
            };
            if let Some((vol, amt, tx_id)) = stopped {
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
            for fp in cfg.active_positions() {
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
            let nozzle_index = {
                let map = runtimes.read().await;
                map.get(&byte)
                    .and_then(|rt| rt.pre_auth.as_ref().map(|p| p.nozzle_index))
            };
            if let Some(n) = nozzle_index {
                let hose = texnouz_bluesky::hose_address(fp_cfg.address_byte, n);
                // Drop the armed dose so a later lift cannot start a sale.
                exchange(hose, &texnouz_bluesky::clear_keypad_preset(hose), backend);
                expect_ok(
                    hose,
                    &texnouz_bluesky::stop(hose),
                    backend,
                    "cancel_preauth",
                );
            }
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
        }

        DispatchCommand::ResetLane { byte } => {
            let Some(fp_cfg) = cfg.position_by_address(byte).cloned() else {
                return;
            };
            {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.reset_for_operator(&fp_cfg);
                }
            }
            broadcast_status(byte, runtimes, events).await;
        }

        DispatchCommand::ResetAll => {
            for fp in cfg.active_positions() {
                let byte = fp.address_byte;
                {
                    let mut map = runtimes.write().await;
                    if let Some(rt) = map.get_mut(&byte) {
                        rt.reset_for_operator(fp);
                    }
                }
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
                let hose = texnouz_bluesky::hose_address(fp_cfg.address_byte, u.nozzle_index);
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
mod tests {
    use super::*;
    use site_config::NozzleConfig;

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
