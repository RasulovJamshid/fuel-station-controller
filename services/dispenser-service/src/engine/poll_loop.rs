use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use crate::engine::serial::ReconnectingSerial;
use anyhow::Result;
use chrono::Utc;
use site_config::Protocol;
use site_config::{FuelingPositionConfig, SiteConfig};
use sqlx::SqlitePool;
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing::{debug, info, warn};
use types::{
    preset_label, preset_metadata, FpStatus, Preset, PumpNozzleTotals, StopSource, Transaction,
    TxStatus, UpdatePriceCmd, WsEvent,
};
use wayne_europump::{
    ack, authorise_cmd, authorize_config_with_preset_block, authorize_initial, busy, done,
    encode_preset_limit_bcd, parse_frame, poll, pre_authorise_price, stop_frame, stop_pre_frame,
    Frame, FrameAccumulator, PresetBlock,
};

use super::state::{
    CurrentTx, FrameEffect, PreAuthContext, PreauthOutcome, RuntimeFp, TxCompleteAction,
    DECEL_WINDOW_TIMEOUT_MS,
};
use crate::shifts::ShiftCoordinator;

/// RS-485 needs quiet time between polls to different addresses (ms).
const RS485_TURNAROUND_MS: u64 = 50;
const GBR_RESET_CLOSE_RETRIES: usize = 5;
const GBR_RESET_CLOSE_RETRY_DELAY_MS: u64 = 750;
const AZT_REACTIVE_AUTHORIZE_START_TIMEOUT_MS: i64 = 15_000;

/// Wayne PP byte per nozzle for CONFIG (`01 PP 00` triplets). Never use nozzle index on wire.
fn wayne_pp_byte(n: &site_config::NozzleConfig) -> u8 {
    if n.wayne_product_code != 0 {
        return n.wayne_product_code;
    }
    match n.product_id {
        1 => 0x05, // AI-92 (serial.log PP)
        2 => 0x43, // AI-95
        3 => 0x24, // Diesel
        _ => n.index,
    }
}

fn wayne_product_codes(fp: &FuelingPositionConfig) -> Vec<u8> {
    // Include ALL nozzles (active and inactive) sorted by wayne_code so that
    // CONFIG channel positions match the pump's physical channel numbers.
    // Filtering to active-only shifts positions: e.g. if physical channel 1 is
    // inactive and channel 2 is AI92, filtering produces CONFIG position 1=AI92
    // but the pump maps HH=0x12 to CONFIG position 2 → wrong product/price.
    let mut nozzles: Vec<_> = fp.nozzles.iter().collect();
    nozzles.sort_by_key(|n| n.wayne_code);
    nozzles.into_iter().map(wayne_pp_byte).collect()
}

/// Per-nozzle prices for the Wayne CONFIG frame, sorted by wayne_code (same order as product codes).
fn wayne_nozzle_prices(
    fp: &FuelingPositionConfig,
    overrides: &HashMap<u8, u32>,
    active_nozzle: u8,
    active_price: u32,
) -> Vec<u32> {
    let mut nozzles: Vec<_> = fp.nozzles.iter().collect();
    nozzles.sort_by_key(|n| n.wayne_code);
    nozzles
        .into_iter()
        .map(|n| {
            if let Some(price) = overrides.get(&n.index).copied() {
                price
            } else if n.index == active_nozzle && active_price > 0 {
                active_price
            } else {
                n.price
            }
        })
        .collect()
}

fn pcc485_preset_block(preset: &Preset) -> PresetBlock {
    match preset {
        Preset::Str(s) if s.eq_ignore_ascii_case("full") => {
            PresetBlock::volume_or_full(encode_preset_limit_bcd(true, None, None, None))
        }
        Preset::Volume(v) if *v > 0.0 => {
            PresetBlock::volume_or_full(encode_preset_limit_bcd(false, Some(*v), None, None))
        }
        Preset::Amount(a) if *a > 0 => PresetBlock::amount_sum(*a),
        _ => PresetBlock::volume_or_full(encode_preset_limit_bcd(true, None, None, None)),
    }
}

/// DartV1: prices for all active nozzles sorted by 1-based index.
fn dart_nozzle_prices(
    fp: &FuelingPositionConfig,
    overrides: &HashMap<u8, u32>,
    active_nozzle: u8,
    active_price: u32,
) -> Vec<u32> {
    let mut nozzles: Vec<_> = fp.nozzles.iter().filter(|n| n.active).collect();
    nozzles.sort_by_key(|n| n.index);
    nozzles
        .iter()
        .map(|n| {
            if let Some(price) = overrides.get(&n.index).copied() {
                price
            } else if n.index == active_nozzle && active_price > 0 {
                active_price
            } else {
                n.price
            }
        })
        .collect()
}

/// DartV1 full-tank BCD is `99 99 99`; volume/amount presets use the same BCD encoding as PCC485.
fn dart_limit_bcd(preset: &Preset, price_per_liter: u32) -> [u8; 3] {
    match preset {
        Preset::Volume(v) if *v > 0.0 => encode_preset_limit_bcd(false, Some(*v), None, None),
        Preset::Amount(a) if *a > 0 => {
            encode_preset_limit_bcd(false, None, Some(*a), Some(price_per_liter))
        }
        _ => [0x99, 0x99, 0x99],
    }
}

/// Send the wire auth sequence for the configured protocol.
///
/// PCC485/WayneEuropump: one compound CONFIG frame.
/// WayneDartV1: PreAuthorisePrice then AuthoriseCMD (two frames, active nozzle required).
///
/// Returns the raw bytes received in response to the final auth frame.  The caller
/// should pass them to [`ack_frames_in_response`] to ACK any StatusTransition frame
/// the dispenser may piggy-back on the same read window.
fn send_auth_pair(
    backend: &SerialBackend,
    byte: u8,
    fp: &FuelingPositionConfig,
    preset: &Preset,
    active_nozzle: u8,
    price_per_liter: u32,
    nozzle_prices: &HashMap<u8, u32>,
    protocol: &Protocol,
) -> Vec<u8> {
    if matches!(protocol, Protocol::WayneDartV1) {
        let prices = dart_nozzle_prices(fp, nozzle_prices, active_nozzle, price_per_liter);
        debug!(byte, active_nozzle, ?prices, "WayneDartV1 auth prices");
        let _ = exchange_serial(backend, &pre_authorise_price(byte, &prices, active_nozzle));
        let limit = dart_limit_bcd(preset, price_per_liter);
        exchange_serial(backend, &authorise_cmd(byte, active_nozzle, limit)).unwrap_or_default()
    } else {
        let products = wayne_product_codes(fp);
        let prices = wayne_nozzle_prices(fp, nozzle_prices, active_nozzle, price_per_liter);
        debug!(byte, active_nozzle, ?prices, "Wayne PCC485 auth prices");
        let preset_block = pcc485_preset_block(preset);
        let cfg = authorize_config_with_preset_block(byte, &products, &prices, preset_block);
        exchange_serial(backend, &cfg).unwrap_or_default()
    }
}

/// After sending an auth frame the dispenser may piggy-back a StatusTransition
/// (`01 01 02 02 08 00…`) on the same ACK burst.  Parse the raw response and
/// send `C0 FA` for every frame that requires an ACK, so the pump can advance.
fn ack_frames_in_response(backend: &SerialBackend, byte: u8, raw: &[u8]) {
    if raw.is_empty() {
        return;
    }
    let mut acc = FrameAccumulator::default();
    for frame_raw in acc.push_bytes(raw) {
        let frame = parse_frame(&frame_raw);
        if matches!(
            frame,
            Frame::Data { .. }
                | Frame::Stopped { .. }
                | Frame::DispenserIdle { .. }
                | Frame::TransactionComplete { .. }
                | Frame::NozzleHolstered { .. }
                | Frame::NozzleReturned { .. }
        ) {
            let _ = write_serial(backend, &ack(byte));
        }
    }
}

fn complete_ghost_fill_on_wire(backend: &SerialBackend, byte: u8) {
    let _ = exchange_serial(backend, &done(byte));
}

/// Format raw bytes as space-separated hex for log messages.
fn fmt_hex(b: &[u8]) -> String {
    b.iter()
        .map(|x| format!("{x:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

struct PollRxAnalysis {
    got_valid: bool,
    saw_foreign: bool,
    saw_idle: bool,
}

fn analyze_poll_frames(parsed: &[Frame], polled_addr: u8) -> PollRxAnalysis {
    let mut got_valid = false;
    let mut saw_foreign = false;
    let mut saw_idle = false;
    for frame in parsed {
        let Some(addr) = frame.response_addr() else {
            continue;
        };
        if addr == polled_addr {
            got_valid = true;
            if matches!(frame, Frame::Idle { .. }) {
                saw_idle = true;
            }
        } else if (0x50..=0x6F).contains(&addr) {
            saw_foreign = true;
        }
    }
    PollRxAnalysis {
        got_valid,
        saw_foreign,
        saw_idle,
    }
}

async fn dispatch_poll_frames(
    byte: u8,
    parsed: &[Frame],
    disp_by_byte: &HashMap<u8, FuelingPositionConfig>,
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    pool: &SqlitePool,
    backend: &SerialBackend,
    shifts: &ShiftCoordinator,
) {
    for frame in parsed.iter().filter(|f| f.should_apply_before_nozzle_up()) {
        // ACK every 3X frame with a valid CRC before processing its payload.
        // NozzleHolstered (01 01 02) MUST be ACK'd so the dispenser advances
        // to send 01 01 05 (TransactionComplete). Without the ACK it stalls and
        // the state machine never escapes Authorizing/Delivering.
        // Stopped (01 01 01) is also a 3X frame and must be ACK'd per the spec.
        if matches!(
            frame,
            Frame::Data { .. }
                | Frame::Stopped { .. }
                | Frame::DispenserIdle { .. }
                | Frame::TransactionComplete { .. }
                | Frame::NozzleHolstered { .. }
                | Frame::NozzleReturned { .. }
        ) {
            let _ = write_serial(backend, &ack(byte));
        }
        process_parsed_frame(
            byte,
            frame.clone(),
            disp_by_byte,
            cfg,
            runtimes,
            events,
            pool,
            backend,
            shifts,
        )
        .await;
    }
    for frame in parsed
        .iter()
        .filter(|f| matches!(f, Frame::NozzleUp { .. }))
    {
        // ACK the NozzleUp (type-03 data block) immediately, then send auth on the
        // same poll slot — before the round-robin visits the next dispenser address.
        let _ = write_serial(backend, &ack(byte));
        process_parsed_frame(
            byte,
            frame.clone(),
            disp_by_byte,
            cfg,
            runtimes,
            events,
            pool,
            backend,
            shifts,
        )
        .await;
        let fp_cfg = match disp_by_byte.get(&byte) {
            Some(x) => x.clone(),
            None => continue,
        };
        let mut map = runtimes.write().await;
        let Some(rt) = map.get_mut(&byte) else {
            continue;
        };
        // nozzle_index is resolved from the Wayne hose code by process_parsed_frame above.
        let lifted_nozzle = rt.state.nozzle_index.unwrap_or(1);
        drop(map);

        let auth_mode = cfg.ui.default_auth_mode.as_str();
        let allow_wire_config = {
            let map = runtimes.read().await;
            map.get(&byte)
                .map(|rt| rt.allow_reactive_nozzle_auth(auth_mode))
                .unwrap_or(false)
        };
        if allow_wire_config {
            let (preset, price) = {
                let map = runtimes.read().await;
                let rt = map.get(&byte);
                let preset = rt
                    .map(|rt| rt.last_preset.clone())
                    .unwrap_or(Preset::Str("full".into()));
                let price = rt
                    .map(|rt| rt.state.price)
                    .unwrap_or_else(|| fp_cfg.default_price().unwrap_or(0));
                (preset, price)
            };
            let nozzle_prices = refresh_nozzle_prices_from_db(pool, &fp_cfg, byte, runtimes).await;
            let auth_resp = send_auth_pair(
                backend,
                byte,
                &fp_cfg,
                &preset,
                lifted_nozzle,
                price,
                &nozzle_prices,
                &cfg.connection.protocol,
            );
            {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.apply_nozzle_lift_config_sent();
                }
            }
            // ACK any StatusTransition the dispenser piggy-backs on the auth ACK burst,
            // then send BUSY so the pump arms the nozzle.
            ack_frames_in_response(backend, byte, &auth_resp);
            let _ = write_serial(backend, &busy(byte));
            info!(
                addr = format_args!("0x{byte:02X}"),
                label = %fp_cfg.label,
                nozzle = lifted_nozzle,
                "NozzleUp → ACK + auth + ACK-flush + BUSY"
            );
        }
        // holstered preauth: CONFIG already on wire, BUSY keepalive handles it

        let mut map = runtimes.write().await;
        if let Some(rt) = map.get_mut(&byte) {
            if rt.preauth_nozzle_confirmed && (rt.pre_auth.is_some() || rt.preauth_config_on_wire) {
                rt.start_delivery_from_pre_auth(&fp_cfg, cfg);
            }
        }
    }
}

#[derive(Debug)]
pub enum DispatchCommand {
    ReloadConfig {
        cfg: Arc<SiteConfig>,
    },
    Authorize {
        byte: u8,
        price: u32,
        preset: Preset,
    },
    ContinueFill {
        byte: u8,
        price: u32,
        preset: Preset,
    },
    ResumeFill {
        byte: u8,
        price: u32,
        preset: Preset,
    },
    Stop {
        byte: u8,
    },
    EStop,
    /// Clear all lane runtimes to idle (and optionally sync sim via desktop).
    ResetAll,
    /// Operator dismissed completed-sale display on one lane.
    ResetLane {
        byte: u8,
    },
    UpdatePrices {
        updates: Vec<UpdatePriceCmd>,
        changed_by: String,
    },
    Preauthorize {
        byte: u8,
        price: u32,
        preset: Preset,
        nozzle_index: u8,
    },
    CancelPreauth {
        byte: u8,
    },
    /// Re-read the pump lifetime totalizer for all lanes (e.g. operator opened the
    /// totalizer view). No-op on protocols without a totalizer.
    RefreshTotals,
}

pub enum SerialBackend {
    Real(Arc<ReconnectingSerial>),
    Mock(Arc<std::sync::Mutex<MockSerial>>),
}

pub struct MockSerial {
    out: VecDeque<u8>,
}

impl MockSerial {
    pub fn new() -> Self {
        Self {
            out: VecDeque::new(),
        }
    }

    fn on_write(&mut self, data: &[u8]) {
        if data.len() >= 4 && data[data.len() - 2] == 0x03 && data[data.len() - 1] == 0xFA {
            let addr = data[0];
            if addr != 0 {
                self.out.extend([addr, 0xC0, 0xFA]);
            }
            return;
        }
        if data.len() >= 3 {
            let n = data.len();
            let addr = data[n - 3];
            if data[n - 2] == 0x20 && data[n - 1] == 0xFA && addr != 0 {
                self.out.push_back(addr);
                self.out.push_back(0x70);
                self.out.push_back(0xFA);
            }
        }
    }

    fn read_available(&mut self, max: usize) -> Vec<u8> {
        let mut v = Vec::new();
        for _ in 0..max {
            if let Some(b) = self.out.pop_front() {
                v.push(b);
            } else {
                break;
            }
        }
        v
    }
}

pub fn exchange_serial(backend: &SerialBackend, out: &[u8]) -> Result<Vec<u8>> {
    match backend {
        SerialBackend::Real(real) => real.exchange(out),
        SerialBackend::Mock(m) => {
            let mut g = m.lock().unwrap();
            g.on_write(out);
            Ok(g.read_available(512))
        }
    }
}

/// Write-only serial send — used for short ACK frames (`C0 FA`) where the
/// protocol does not expect an immediate response from the dispenser.
pub fn write_serial(backend: &SerialBackend, out: &[u8]) -> Result<()> {
    match backend {
        SerialBackend::Real(real) => real.write_only(out),
        SerialBackend::Mock(_) => Ok(()),
    }
}

fn active_positions_by_byte(cfg: &SiteConfig) -> HashMap<u8, FuelingPositionConfig> {
    cfg.fueling_positions
        .iter()
        .filter(|fp| fp.active)
        .map(|fp| (fp.address_byte, fp.clone()))
        .collect()
}

async fn refresh_nozzle_prices_from_db(
    pool: &SqlitePool,
    fp: &FuelingPositionConfig,
    byte: u8,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
) -> HashMap<u8, u32> {
    let Ok(nozzles_by_fp) = crate::db::admin_queries::load_fp_nozzles_from_db(pool).await else {
        let map = runtimes.read().await;
        return map
            .get(&byte)
            .map(|rt| rt.nozzle_prices.clone())
            .unwrap_or_default();
    };
    let Some(nozzles) = nozzles_by_fp.get(&fp.id) else {
        let map = runtimes.read().await;
        return map
            .get(&byte)
            .map(|rt| rt.nozzle_prices.clone())
            .unwrap_or_default();
    };
    let fresh: HashMap<u8, u32> = nozzles
        .iter()
        .filter(|n| n.active)
        .map(|n| (n.index, n.price))
        .collect();
    let mut map = runtimes.write().await;
    if let Some(rt) = map.get_mut(&byte) {
        rt.nozzle_prices = fresh.clone();
        if let Some(idx) = rt.state.nozzle_index {
            if let Some(price) = fresh.get(&idx).copied() {
                rt.state.price = price;
            }
        }
    }
    fresh
}

pub async fn run_poll_loop(
    mut cfg: Arc<SiteConfig>,
    backend: SerialBackend,
    runtimes: Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    mut disp_by_byte: HashMap<u8, FuelingPositionConfig>,
    events: broadcast::Sender<WsEvent>,
    mut commands: mpsc::Receiver<DispatchCommand>,
    pool: SqlitePool,
    shifts: Arc<ShiftCoordinator>,
) {
    // Exhaustive dispatch: each protocol either returns into its own poll loop or
    // falls through to the Wayne-shaped body below. Keeping this a `match` (rather
    // than an `if Gilbarco {...} else Wayne`) means a newly-added `Protocol`
    // variant is a compile error here until it is explicitly routed, instead of
    // silently running the Wayne loop with the wrong framing.
    match cfg.connection.protocol {
        Protocol::Gilbarco => {
            return run_gilbarco_poll_loop(
                cfg,
                backend,
                runtimes,
                disp_by_byte,
                events,
                commands,
                pool,
                shifts,
            )
            .await;
        }
        Protocol::Azt20 => {
            return run_azt_poll_loop(
                cfg,
                backend,
                runtimes,
                disp_by_byte,
                events,
                commands,
                pool,
                shifts,
            )
            .await;
        }
        // Wayne Europump (PCC485) + Dart variants + Mock all share the body below.
        Protocol::WayneEuropump
        | Protocol::WayneDartV1
        | Protocol::WayneDartV2
        | Protocol::Mock => {}
    }

    let mut addrs: Vec<u8> = cfg.active_addresses();

    let mut interval = tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut accum = FrameAccumulator::default();

    // Startup reset (matches the old app — see docs/logs/waynesniffer_restart.log): put every pump into
    // a known idle state so any stale transaction or armed authorization left from before this service
    // start is cleared, instead of being inherited. Best-effort: if the bus is down the exchanges return
    // empty and steady-state polling proceeds/retries.
    for &byte in &addrs {
        let resp = exchange_serial(&backend, &done(byte)).unwrap_or_default(); // GO_IDLE  (30 01 01 05)
        ack_frames_in_response(&backend, byte, &resp);
        let _ = exchange_serial(&backend, &busy(byte)); // BUSY (30 01 01 04) re-sync
        debug!(
            addr = format_args!("0x{byte:02X}"),
            "startup reset → GO_IDLE + BUSY"
        );
    }

    'poll_loop: loop {
        while let Ok(cmd) = commands.try_recv() {
            if let DispatchCommand::ReloadConfig { cfg: next_cfg } = cmd {
                tracing::info!("poll loop reloaded site config");
                cfg = next_cfg;
                disp_by_byte = active_positions_by_byte(&cfg);
                addrs = cfg.active_addresses();
                interval = tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                continue 'poll_loop;
            }
            apply_command(
                &cfg,
                &runtimes,
                &events,
                &pool,
                &backend,
                cmd,
                shifts.as_ref(),
            )
            .await;
        }

        for byte in addrs.clone() {
            interval.tick().await;
            while let Ok(cmd) = commands.try_recv() {
                if let DispatchCommand::ReloadConfig { cfg: next_cfg } = cmd {
                    tracing::info!("poll loop reloaded site config");
                    cfg = next_cfg;
                    disp_by_byte = active_positions_by_byte(&cfg);
                    addrs = cfg.active_addresses();
                    interval =
                        tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    continue 'poll_loop;
                }
                apply_command(
                    &cfg,
                    &runtimes,
                    &events,
                    &pool,
                    &backend,
                    cmd,
                    shifts.as_ref(),
                )
                .await;
            }

            let poll_f = poll(byte);
            let mut offline_meta: Option<(String, String)> = None;
            accum.clear();
            let mut got_valid_response = false;
            let mut saw_foreign_response = false;
            let mut saw_idle_response = false;
            let real_bus = matches!(backend, SerialBackend::Real(_));

            for attempt in 0..2u32 {
                match exchange_serial(&backend, &poll_f) {
                    Ok(chunk) => {
                        let frames_raw = accum.push_bytes(&chunk);
                        let parsed: Vec<Frame> =
                            frames_raw.iter().map(|raw| parse_frame(raw)).collect();
                        let analysis = analyze_poll_frames(&parsed, byte);
                        if analysis.saw_foreign {
                            saw_foreign_response = true;
                        }
                        if analysis.saw_idle {
                            saw_idle_response = true;
                        }

                        // ── per-poll diagnostic trace ──────────────────────────────────
                        if real_bus {
                            debug!(
                                addr = format_args!("0x{byte:02X}"),
                                rx_bytes = chunk.len(),
                                rx = %fmt_hex(&chunk),
                                frames = parsed.len(),
                                valid = analysis.got_valid,
                                foreign = analysis.saw_foreign,
                                attempt,
                                "poll"
                            );
                        }

                        dispatch_poll_frames(
                            byte,
                            &parsed,
                            &disp_by_byte,
                            &cfg,
                            &runtimes,
                            &events,
                            &pool,
                            &backend,
                            shifts.as_ref(),
                        )
                        .await;
                        if analysis.got_valid {
                            got_valid_response = true;
                            break;
                        }
                        // Another pump answered in our window — retry once after bus settles.
                        if attempt == 0 && real_bus && (!chunk.is_empty() || analysis.saw_foreign) {
                            debug!(
                                addr = format_args!("0x{byte:02X}"),
                                len = chunk.len(),
                                foreign = analysis.saw_foreign,
                                "poll retry after RS-485 crosstalk"
                            );
                            accum.clear();
                            tokio::time::sleep(Duration::from_millis(RS485_TURNAROUND_MS)).await;
                            continue;
                        }
                        break;
                    }
                    Err(e) => {
                        warn!(
                            ?e,
                            addr = format_args!("0x{byte:02X}"),
                            attempt,
                            "serial exchange error"
                        );
                        if attempt == 0 && real_bus {
                            accum.clear();
                            tokio::time::sleep(Duration::from_millis(RS485_TURNAROUND_MS)).await;
                            continue;
                        }
                        break;
                    }
                }
            }

            {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    if got_valid_response {
                        let was_offline = rt.state.status == FpStatus::Offline;
                        let had_serial_misses = rt.missed > 0;
                        rt.on_poll_success();
                        if was_offline {
                            // Always log when a pump first comes online – critical for address debug
                            info!(
                                addr = format_args!("0x{byte:02X}"),
                                label = %rt.state.label,
                                "pump came online"
                            );
                        }
                        if was_offline && had_serial_misses {
                            rt.on_reconnect_flush(cfg.polling.reconnect_settle_rounds);
                        }
                    } else {
                        if saw_foreign_response && real_bus {
                            debug!(
                                addr = format_args!("0x{byte:02X}"),
                                label = %rt.state.label,
                                "poll slot saw only foreign/noisy frames; counting as miss"
                            );
                        }
                        let miss = rt.missed + 1;
                        if rt.on_poll_missed(cfg.polling.offline_threshold_polls) {
                            offline_meta = Some((rt.state.fp_id.clone(), rt.state.label.clone()));
                        }
                        // Log every missed poll so address problems are obvious in the log
                        if real_bus {
                            debug!(
                                addr = format_args!("0x{byte:02X}"),
                                label = %rt.state.label,
                                miss,
                                threshold = cfg.polling.offline_threshold_polls,
                                "poll miss"
                            );
                        }
                    }
                }
            }
            if let Some((fp_id, label)) = offline_meta {
                warn!(label, "pump went offline — no response");
                let _ = events.send(WsEvent::Offline { fp_id, label });
            }

            {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.note_dispenser_poll(got_valid_response && saw_idle_response);
                }
            }

            // Decel window wall-clock expiry: fire even if the device sends no frames.
            {
                let expired = {
                    let map = runtimes.read().await;
                    map.get(&byte).map_or(false, |rt| {
                        rt.decel_stop_sent_at.map_or(false, |sent_at| {
                            Utc::now().timestamp_millis() - sent_at >= DECEL_WINDOW_TIMEOUT_MS
                        })
                    })
                };
                if expired {
                    let fp_cfg = disp_by_byte.get(&byte).cloned();
                    if let Some(fp_cfg) = fp_cfg {
                        let (active_shift_id, active_operator_name) = shifts.active_info().await;
                        let effect = {
                            let mut map = runtimes.write().await;
                            map.get_mut(&byte).map(|rt| {
                                let preset = rt
                                    .decel_pending_preset
                                    .take()
                                    .unwrap_or_else(|| rt.last_preset.clone());
                                let ss = rt.decel_pending_stop_source;
                                rt.clear_decel_window();
                                rt.enter_stopped_state(
                                    &fp_cfg,
                                    &cfg,
                                    active_shift_id.clone(),
                                    active_operator_name.clone(),
                                    preset,
                                    ss,
                                )
                            })
                        };
                        if let Some(FrameEffect::Paused {
                            tx,
                            fp_id,
                            stopped_volume,
                            stopped_amount,
                            stopped_tx_id,
                            stop_source,
                        }) = effect
                        {
                            let source_str = match stop_source {
                                StopSource::App => "APP",
                                StopSource::AppFinal => "APP_FINAL",
                                StopSource::External => "EXTERNAL",
                            };
                            let _ = events.send(WsEvent::Paused {
                                fp_id,
                                stopped_volume,
                                stopped_amount,
                                stopped_tx_id,
                                stop_source: source_str.to_string(),
                            });
                            if let Err(e) = crate::db::queries::insert_transaction(&pool, &tx).await
                            {
                                warn!(?e, "db insert decel-timeout paused tx");
                            }
                            broadcast_status(byte, &runtimes, &events).await;
                        }
                    }
                }
            }

            let send_busy_keepalive = {
                let map = runtimes.read().await;
                map.get(&byte).map_or(false, |rt| {
                    // Holstered pre-auth: CONFIG is on wire, pump expects BUSY every poll
                    // to keep the authorization alive until the nozzle is lifted.
                    if rt.state.status == FpStatus::PreAuthorized && rt.pre_auth.is_some() {
                        return true;
                    }
                    if !matches!(
                        rt.state.status,
                        FpStatus::Authorizing | FpStatus::Delivering
                    ) {
                        return false;
                    }
                    // During zero-volume arming (AUTH sent, CONFIG not yet sent), keep
                    // polling only — BUSY races the ACK window.  Once CONFIG is on the
                    // wire (preauth_config_on_wire) the pump expects BUSY every cycle.
                    if rt.state.status == FpStatus::Authorizing
                        && rt.nozzle_physically_up()
                        && rt.state.volume < 0.01
                        && rt.state.amount == 0
                        && !rt.preauth_config_on_wire
                    {
                        return false;
                    }
                    true
                })
            };
            if send_busy_keepalive {
                let _ = write_serial(&backend, &busy(byte));
            }

            broadcast_status(byte, &runtimes, &events).await;

            // Turnaround guard: wait for the bus to settle after the last TX for
            // this slot (which may be a BUSY keepalive sent above) before polling
            // the next pump address.  Previously this sleep was before the busy
            // write, leaving zero gap between BUSY TX and the next poll — causing
            // the pump's C0 FA ACK to arrive in the next pump's response window.
            if real_bus {
                tokio::time::sleep(Duration::from_millis(RS485_TURNAROUND_MS)).await;
            }
        }
    }
}

async fn broadcast_status(
    byte: u8,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
) {
    let st = {
        let map = runtimes.read().await;
        map.get(&byte).map(|r| r.snapshot_state())
    };
    if let Some(s) = st {
        let _ = events.send(WsEvent::Status(s));
    }
}

/// After resume/continue authorize, poll the pump a few times so meter data reaches the runtime.
async fn kick_delivery_polls(
    byte: u8,
    backend: &SerialBackend,
    disp_by_byte: &HashMap<u8, FuelingPositionConfig>,
    site: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
    rounds: usize,
) {
    let mut accum = FrameAccumulator::default();
    for _ in 0..rounds {
        let poll_f = poll(byte);
        if let Ok(chunk) = exchange_serial(backend, &poll_f) {
            if chunk.is_empty() {
                continue;
            }
            let frames_raw = accum.push_bytes(&chunk);
            for raw in frames_raw {
                let frame = parse_frame(&raw);
                if matches!(
                    frame,
                    Frame::Data { .. }
                        | Frame::NozzleUp { .. }
                        | Frame::Stopped { .. }
                        | Frame::DispenserIdle { .. }
                        | Frame::TransactionComplete { .. }
                        | Frame::NozzleHolstered { .. }
                        | Frame::NozzleReturned { .. }
                ) {
                    let _ = write_serial(backend, &ack(byte));
                }
                process_parsed_frame(
                    byte,
                    frame,
                    disp_by_byte,
                    site,
                    runtimes,
                    events,
                    pool,
                    backend,
                    shifts,
                )
                .await;
            }
        }
    }
    broadcast_status(byte, runtimes, events).await;
}

async fn process_parsed_frame(
    byte: u8,
    frame: Frame,
    disp_by_byte: &HashMap<u8, FuelingPositionConfig>,
    site: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    pool: &SqlitePool,
    backend: &SerialBackend,
    shifts: &ShiftCoordinator,
) {
    let fp_cfg = match disp_by_byte.get(&byte) {
        Some(x) => x.clone(),
        None => return,
    };
    let (active_shift_id, active_operator_name) = shifts.active_info().await;
    let effect = {
        let mut map = runtimes.write().await;
        let Some(rt) = map.get_mut(&byte) else {
            return;
        };
        rt.apply_frame(&frame, &fp_cfg, site, active_shift_id, active_operator_name)
    };
    match effect {
        FrameEffect::Online => {
            let _ = events.send(WsEvent::Online {
                fp_id: fp_cfg.id.clone(),
                label: fp_cfg.label.clone(),
            });
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::NozzleUp {
            nozzle_index,
            product_id,
            product_name,
            product_color,
            price,
        } => {
            let auth_mode = site.ui.default_auth_mode.as_str();
            let allow_wire_auth = {
                let map = runtimes.read().await;
                map.get(&byte)
                    .map(|rt| rt.allow_reactive_nozzle_auth(auth_mode))
                    .unwrap_or(false)
            };
            // Always notify the UI (grade banner + setup). Wire AUTH only in reactive mode.
            let _ = events.send(WsEvent::NozzleUp {
                fp_id: fp_cfg.id.clone(),
                nozzle_index,
                product_id,
                product_name,
                product_color,
                price,
            });
            if !allow_wire_auth {
                debug!(
                    addr = format_args!("0x{byte:02X}"),
                    label = %fp_cfg.label,
                    auth_mode,
                    "NozzleUp UI only — preauth: operator sets limit before wire AUTH"
                );
            }
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::ResendAuthorize => {
            let _ = exchange_serial(backend, &busy(byte));
            debug!(
                addr = format_args!("0x{byte:02X}"),
                label = %fp_cfg.label,
                "70 FA while armed → BUSY keepalive"
            );
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::TransactionDone { tx, action } => {
            let _ = events.send(WsEvent::Done(tx.clone()));
            if let Err(e) = crate::db::queries::persist_closed_transaction(pool, &tx).await {
                warn!(tx_id = %tx.id, ?e, "db persist transaction");
            } else if let Err(e) = shifts.on_transaction_recorded(&tx).await {
                warn!(?e, "shift totals update");
            }
            match action {
                TxCompleteAction::AcknowledgeIdle => {
                    let done_f = done(byte);
                    let _ = exchange_serial(backend, &done_f);
                    let mut map = runtimes.write().await;
                    if let Some(rt) = map.get_mut(&byte) {
                        rt.apply_done_ack();
                    }
                }
            }
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::Paused {
            tx,
            fp_id,
            stopped_volume,
            stopped_amount,
            stopped_tx_id,
            stop_source,
        } => {
            let source_str = match stop_source {
                types::StopSource::App => "APP",
                types::StopSource::AppFinal => "APP_FINAL",
                types::StopSource::External => "EXTERNAL",
            };
            let _ = events.send(WsEvent::Paused {
                fp_id: fp_id.clone(),
                stopped_volume,
                stopped_amount,
                stopped_tx_id: stopped_tx_id.clone(),
                stop_source: source_str.to_string(),
            });
            if let Err(e) = crate::db::queries::insert_transaction(pool, &tx).await {
                warn!(?e, "db insert paused tx");
            }
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::PreAuthCancelled => {
            let fp_id = fp_cfg.id.clone();
            let _ = events.send(WsEvent::PreAuthCancelled { fp_id });
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::UnauthorizedDelivery { volume, amount } => {
            // The pump is delivering on a lane that holds no authorization (e.g. it stayed armed
            // after a cancelled pre-auth). Re-assert STOP + GO_IDLE on every such frame so the pump
            // halts, and raise the operator alert once per episode (deduped on the runtime).
            let _ = exchange_serial(backend, &stop_frame(byte));
            let _ = write_serial(backend, &done(byte));
            let alert = {
                let mut map = runtimes.write().await;
                match map.get_mut(&byte) {
                    Some(rt) if !rt.unauthorized_alerted => {
                        rt.unauthorized_alerted = true;
                        true
                    }
                    _ => false,
                }
            };
            if alert {
                warn!(
                    addr = format_args!("0x{byte:02X}"),
                    label = %fp_cfg.label,
                    volume,
                    amount,
                    "unauthorized delivery on idle lane → STOP + GO_IDLE + alert operator"
                );
                let _ = events.send(WsEvent::UnauthorizedDelivery {
                    fp_id: fp_cfg.id.clone(),
                    volume,
                    amount,
                });
            }
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::PreAuthNozzleMismatch {
            expected_nozzle_index,
            expected_product_name,
            lifted_nozzle_index,
            lifted_product_name,
        } => {
            let _ = exchange_serial(backend, &stop_frame(byte));
            let _ = events.send(WsEvent::PreAuthNozzleMismatch {
                fp_id: fp_cfg.id.clone(),
                expected_nozzle_index,
                expected_product_name,
                lifted_nozzle_index,
                lifted_product_name,
            });
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::NozzleRemoved {
            fp_id,
            stopped_tx_id,
            tx,
        } => {
            if let Err(e) = crate::db::queries::persist_closed_transaction(pool, &tx).await {
                warn!(?e, "db persist tx on nozzle removed");
            } else if let Err(e) = shifts.on_transaction_recorded(&tx).await {
                warn!(?e, "shift totals on nozzle removed");
            }
            let _ = events.send(WsEvent::NozzleRemoved {
                fp_id: fp_id.clone(),
                stopped_tx_id,
            });
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::NozzleHolstered => {
            let stop_f = stop_frame(byte);
            let _ = exchange_serial(backend, &stop_f);
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::CompleteGhostFill => {
            let nozzle_up = {
                let map = runtimes.read().await;
                map.get(&byte).is_some_and(|rt| rt.nozzle_physically_up())
            };
            if !nozzle_up {
                complete_ghost_fill_on_wire(backend, byte);
                info!(
                    addr = format_args!("0x{byte:02X}"),
                    label = %fp_cfg.label,
                    "ghost fill complete → GO_IDLE"
                );
            } else {
                debug!(
                    addr = format_args!("0x{byte:02X}"),
                    label = %fp_cfg.label,
                    "ghost fill suppressed — nozzle still lifted on wire"
                );
            }
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::CompleteGhostFillWithNozzleUp => {
            complete_ghost_fill_on_wire(backend, byte);
            info!(
                addr = format_args!("0x{byte:02X}"),
                label = %fp_cfg.label,
                "startup ghost fill complete → GO_IDLE; nozzle remains lifted"
            );
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::SendAuthorizeConfig => {
            let (preset, active_nozzle, price) = {
                let map = runtimes.read().await;
                let rt = map.get(&byte);
                let preset = rt
                    .map(|rt| rt.last_preset.clone())
                    .unwrap_or(Preset::Str("full".into()));
                let nozzle = rt.and_then(|rt| rt.state.nozzle_index).unwrap_or(1);
                let price = rt
                    .map(|rt| rt.state.price)
                    .unwrap_or_else(|| fp_cfg.default_price().unwrap_or(0));
                (preset, nozzle, price)
            };
            let nozzle_prices = refresh_nozzle_prices_from_db(pool, &fp_cfg, byte, runtimes).await;
            let auth_resp = send_auth_pair(
                backend,
                byte,
                &fp_cfg,
                &preset,
                active_nozzle,
                price,
                &nozzle_prices,
                &site.connection.protocol,
            );
            {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.mark_preauth_config_on_wire();
                }
            }
            ack_frames_in_response(backend, byte, &auth_resp);
            let _ = write_serial(backend, &busy(byte));
            info!(
                addr = format_args!("0x{byte:02X}"),
                label = %fp_cfg.label,
                ?preset,
                nozzle = active_nozzle,
                "sent auth + ACK-flush + BUSY after first Data"
            );
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::SendDoneAwaitHolster => {
            // Pump reported end-of-sale while nozzle is still physically in the tank.
            // Send GO_IDLE with write_serial (no read) so the pump's NozzleReturned
            // response stays in the serial buffer for the next poll to process through
            // apply_frame → apply_nozzle_holstered → close with true final volume.
            // Using exchange_serial here would consume and discard the NozzleReturned,
            // leaving status stuck in Delivering until the 4-second timestamp timeout.
            let done_f = done(byte);
            let _ = write_serial(backend, &done_f);
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::ResendStop => {
            // The lane is STOPPED but the pump's counter kept advancing — the stop
            // frame was likely lost to bus noise. Re-send the full §8.2 stop sequence
            // (the state machine allows this once per stop episode).
            warn!(
                addr = format_args!("0x{byte:02X}"),
                label = %fp_cfg.label,
                "volume still rising after STOP → re-sending stop sequence"
            );
            let _ = exchange_serial(backend, &stop_pre_frame(byte)); // dispenser replies C1 FA
            let _ = write_serial(backend, &ack(byte)); // PC ACKs the C1 FA
            let _ = exchange_serial(backend, &stop_frame(byte));
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::StatusChanged => {
            broadcast_status(byte, runtimes, events).await;
        }
        FrameEffect::None => {}
    }
}

async fn apply_command(
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    pool: &SqlitePool,
    backend: &SerialBackend,
    cmd: DispatchCommand,
    shifts: &ShiftCoordinator,
) {
    match cmd {
        DispatchCommand::ReloadConfig { .. } => {}
        DispatchCommand::Authorize {
            byte,
            price,
            preset,
        } => {
            debug!(byte, price, ?preset, "authorize");
            let fp_cfg = match cfg.position_by_address(byte) {
                Some(p) => p.clone(),
                None => return,
            };

            // If the nozzle is already physically up, pump 4 (type-B firmware) sends
            // another NozzleUp frame after authorize_initial — not a Data frame — so the
            // deferred SendAuthorizeConfig path never fires.  Mirror the reactive
            // NozzleUp handler: send the full CONFIG immediately and mark it on wire.
            let (nozzle_already_up, lifted_nozzle) = {
                let map = runtimes.read().await;
                let rt = map.get(&byte);
                (
                    rt.map_or(false, |r| r.state.status == FpStatus::NozzleUp),
                    rt.and_then(|r| r.state.nozzle_index).unwrap_or(1),
                )
            };

            if nozzle_already_up {
                // Pump is in data-frame mode (armed). It ACKs CONFIG but does NOT start
                // delivery unless it is in IDLE state. Stop sending BUSY so the pump exits
                // data-frame mode within a few polls, then send CONFIG+BUSY on the first
                // IDLE response via apply_idle_response → SendAuthorizeConfig.
                {
                    let mut map = runtimes.write().await;
                    if let Some(rt) = map.get_mut(&byte) {
                        rt.state.price = price;
                        rt.set_last_preset(preset);
                        rt.apply_nozzle_lift_deferred_config();
                    }
                }
                info!(
                    addr = format_args!("0x{byte:02X}"),
                    label = %fp_cfg.label,
                    nozzle = lifted_nozzle,
                    "Authorize (nozzle already up) → deferred CONFIG on next IDLE"
                );
                broadcast_status(byte, runtimes, events).await;
            } else {
                let auth = authorize_initial(byte);
                if exchange_serial(backend, &auth).is_ok() {
                    let mut map = runtimes.write().await;
                    if let Some(rt) = map.get_mut(&byte) {
                        rt.state.price = price;
                        rt.state.pre_auth_preset = Some(preset_label(&preset));
                        rt.set_last_preset(preset);
                        rt.apply_authorize_sent();
                    }
                }
            }
        }
        DispatchCommand::ContinueFill {
            byte,
            price,
            preset,
        } => {
            debug!(byte, price, ?preset, "continue fill authorize");
            let fp_cfg = match cfg.position_by_address(byte) {
                Some(p) => p.clone(),
                None => return,
            };
            let auth = authorize_initial(byte);
            if exchange_serial(backend, &auth).is_ok() {
                let active_nozzle = {
                    let map = runtimes.read().await;
                    let rt = map.get(&byte);
                    rt.and_then(|rt| rt.state.nozzle_index).unwrap_or(1)
                };
                let nozzle_prices =
                    refresh_nozzle_prices_from_db(pool, &fp_cfg, byte, runtimes).await;
                // Send CONFIG with the remaining limit immediately after AUTH so the pump
                // uses the correct hardware limit when the customer lifts the nozzle.
                let _ = send_auth_pair(
                    backend,
                    byte,
                    &fp_cfg,
                    &preset,
                    active_nozzle,
                    price,
                    &nozzle_prices,
                    &cfg.connection.protocol,
                );
                {
                    let mut map = runtimes.write().await;
                    if let Some(rt) = map.get_mut(&byte) {
                        rt.state.price = price;
                        rt.last_preset = preset; // caps already set correctly by prepare_continue
                        rt.mark_preauth_config_on_wire();
                        rt.apply_authorize_sent();
                        rt.begin_continuation_segment(&fp_cfg, cfg);
                    }
                }
                broadcast_status(byte, runtimes, events).await;
            } else {
                warn!(byte, "continue fill: authorize frame failed");
            }
        }
        DispatchCommand::Stop { byte } => {
            // §8.2: mid-delivery stop requires the 0x31 pre-command first.
            let (is_delivering, has_active_session) = {
                let map = runtimes.read().await;
                let rt = map.get(&byte);
                (
                    rt.map_or(false, |r| r.state.status == FpStatus::Delivering),
                    rt.map_or(false, |r| {
                        matches!(
                            r.state.status,
                            FpStatus::Delivering
                                | FpStatus::Authorizing
                                | FpStatus::NozzleUp
                                | FpStatus::PreAuthorized
                        ) || r.current_tx.is_some()
                    }),
                )
            };
            // Only send the wire stop when there is an active session.
            // Sending stop_frame in Done/Idle state makes the pump emit a response
            // that ends up buffered on the bus and can corrupt the next poll parse.
            if has_active_session {
                if is_delivering {
                    let pre = stop_pre_frame(byte);
                    let _ = exchange_serial(backend, &pre); // dispenser replies C1 FA
                    let _ = write_serial(backend, &ack(byte)); // PC ACKs the C1 FA
                }
                let f = stop_frame(byte);
                let _ = exchange_serial(backend, &f);
            }
            let fp_cfg = match cfg.position_by_address(byte) {
                Some(p) => p.clone(),
                None => return,
            };
            let (active_shift_id, active_operator_name) = shifts.active_info().await;
            let effect = {
                let mut map = runtimes.write().await;
                map.get_mut(&byte).and_then(|rt| {
                    rt.apply_stop(
                        &fp_cfg,
                        cfg,
                        active_shift_id,
                        active_operator_name,
                        cfg.ui.use_decel_window_on_stop,
                        cfg.ui.use_stop_mode,
                    )
                })
            };
            if let Some(FrameEffect::Paused {
                tx,
                fp_id,
                stopped_volume,
                stopped_amount,
                stopped_tx_id,
                stop_source,
            }) = effect
            {
                let source_str = match stop_source {
                    types::StopSource::App => "APP",
                    types::StopSource::AppFinal => "APP_FINAL",
                    types::StopSource::External => "EXTERNAL",
                };
                let _ = events.send(WsEvent::Paused {
                    fp_id,
                    stopped_volume,
                    stopped_amount,
                    stopped_tx_id,
                    stop_source: source_str.to_string(),
                });
                if let Err(e) = crate::db::queries::insert_transaction(pool, &tx).await {
                    warn!(?e, "db insert paused tx");
                }
                broadcast_status(byte, runtimes, events).await;
            }
        }
        DispatchCommand::ResumeFill {
            byte,
            price,
            preset,
        } => {
            debug!(byte, price, ?preset, "resume fill (app pause)");
            let fp_cfg = match cfg.position_by_address(byte) {
                Some(p) => p.clone(),
                None => return,
            };
            let auth = authorize_initial(byte);
            if exchange_serial(backend, &auth).is_ok() {
                // Read nozzle index while we still hold no locks.
                let active_nozzle = {
                    let map = runtimes.read().await;
                    let rt = map.get(&byte);
                    rt.and_then(|rt| rt.state.nozzle_index).unwrap_or(1)
                };
                let nozzle_prices =
                    refresh_nozzle_prices_from_db(pool, &fp_cfg, byte, runtimes).await;
                // Send CONFIG with the *remaining* limit immediately after AUTH, before the
                // first BUSY frame starts the pump counting.  The pump resets its internal
                // counter on AUTH, so without this it would count against the old 2 L CONFIG.
                let _ = send_auth_pair(
                    backend,
                    byte,
                    &fp_cfg,
                    &preset,
                    active_nozzle,
                    price,
                    &nozzle_prices,
                    &cfg.connection.protocol,
                );
                {
                    let mut map = runtimes.write().await;
                    if let Some(rt) = map.get_mut(&byte) {
                        rt.state.price = price;
                        rt.last_preset = preset; // remaining — caps already set by prepare_continue
                        rt.mark_preauth_config_on_wire(); // config already on wire; skip deferred path
                        rt.apply_authorize_sent();
                        rt.begin_continuation_segment(&fp_cfg, cfg);
                        rt.promote_continuation_delivering();
                    }
                }
                let disp_by_byte: HashMap<u8, FuelingPositionConfig> = cfg
                    .active_positions()
                    .into_iter()
                    .map(|fp| (fp.address_byte, fp.clone()))
                    .collect();
                kick_delivery_polls(
                    byte,
                    backend,
                    &disp_by_byte,
                    cfg,
                    runtimes,
                    events,
                    pool,
                    shifts,
                    6,
                )
                .await;
            } else {
                warn!(byte, "resume fill: authorize frame failed");
            }
        }
        DispatchCommand::EStop => {
            // §8.2: per-address: PRE (31) → read C1 FA → ACK → STOP (30) → read C0 FA.
            for &addr in &cfg.active_addresses() {
                let _ = exchange_serial(backend, &stop_pre_frame(addr));
                let _ = write_serial(backend, &ack(addr));
                let _ = exchange_serial(backend, &stop_frame(addr));
            }
            let (active_shift_id, active_operator_name) = shifts.active_info().await;
            let mut stopped_effects = Vec::new();
            {
                let mut map = runtimes.write().await;
                for fp in cfg.active_positions() {
                    if let Some(rt) = map.get_mut(&fp.address_byte) {
                        if let Some(effect) = rt.apply_stop(
                            fp,
                            cfg,
                            active_shift_id.clone(),
                            active_operator_name.clone(),
                            false,
                            false,
                        ) {
                            stopped_effects.push((fp.address_byte, fp.id.clone(), effect));
                        }
                    }
                }
            }
            for (byte, _fp_id, effect) in stopped_effects {
                if let FrameEffect::Paused {
                    tx,
                    fp_id,
                    stopped_volume,
                    stopped_amount,
                    stopped_tx_id,
                    stop_source,
                } = effect
                {
                    let source_str = match stop_source {
                        types::StopSource::App => "APP",
                        types::StopSource::AppFinal => "APP_FINAL",
                        types::StopSource::External => "EXTERNAL",
                    };
                    let _ = events.send(WsEvent::Paused {
                        fp_id,
                        stopped_volume,
                        stopped_amount,
                        stopped_tx_id,
                        stop_source: source_str.to_string(),
                    });
                    if let Err(e) = crate::db::queries::insert_transaction(pool, &tx).await {
                        warn!(?e, "db insert paused tx");
                    }
                    broadcast_status(byte, runtimes, events).await;
                }
            }
        }
        DispatchCommand::ResetAll => {
            for fp in cfg.active_positions() {
                let byte = fp.address_byte;
                let done_f = done(byte);
                let _ = exchange_serial(backend, &done_f);
            }
            let mut map = runtimes.write().await;
            for fp in cfg.active_positions() {
                if let Some(rt) = map.get_mut(&fp.address_byte) {
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
            let done_f = done(byte);
            let _ = exchange_serial(backend, &done_f);
            let mut map = runtimes.write().await;
            if let Some(rt) = map.get_mut(&byte) {
                match rt.operator_dismiss_display(&fp_cfg) {
                    Ok(()) => {
                        let _ = events.send(WsEvent::Status(rt.snapshot_state()));
                    }
                    Err(e) => warn!(byte, %e, "dismiss lane"),
                }
            }
        }
        DispatchCommand::Preauthorize {
            byte,
            price,
            preset,
            nozzle_index,
        } => {
            debug!(byte, price, ?preset, nozzle_index, "preauthorize");
            let fp_cfg = match cfg.position_by_address(byte) {
                Some(p) => p.clone(),
                None => return,
            };
            let preset_label_str = preset_label(&preset);
            let outcome = {
                let mut map = runtimes.write().await;
                match map.get_mut(&byte) {
                    Some(rt) => rt.apply_preauthorize_sent(
                        &fp_cfg,
                        cfg,
                        nozzle_index,
                        price,
                        preset.clone(),
                    ),
                    None => return,
                }
            };
            // Wrong nozzle physically up — a TOCTOU lift the API could not see when it queued this
            // command. STOP the pump, notify the operator, and do NOT arm CONFIG. The lane already
            // reflects the lifted (wrong) nozzle as NozzleUp (left untouched by the state call).
            // The write guard above is already dropped, so broadcast_status cannot deadlock.
            let lift_confirmed = match outcome {
                PreauthOutcome::NozzleMismatch {
                    expected_nozzle_index,
                    expected_product_name,
                    lifted_nozzle_index,
                    lifted_product_name,
                } => {
                    let _ = exchange_serial(backend, &stop_frame(byte));
                    let _ = events.send(WsEvent::PreAuthNozzleMismatch {
                        fp_id: fp_cfg.id.clone(),
                        expected_nozzle_index,
                        expected_product_name,
                        lifted_nozzle_index,
                        lifted_product_name,
                    });
                    info!(
                        addr = format_args!("0x{byte:02X}"),
                        label = %fp_cfg.label,
                        expected = expected_nozzle_index,
                        lifted = lifted_nozzle_index,
                        "Preauthorize: wrong nozzle already up → STOP, no CONFIG armed"
                    );
                    broadcast_status(byte, runtimes, events).await;
                    return;
                }
                PreauthOutcome::LiftConfirmed => true,
                PreauthOutcome::Holstered => false,
            };
            let nozzle_prices = refresh_nozzle_prices_from_db(pool, &fp_cfg, byte, runtimes).await;
            if lift_confirmed {
                // Nozzle was already up when the operator pressed preauthorize.
                // Send CONFIG immediately (same as the reactive NozzleUp path) so the
                // dispenser starts delivering without waiting for a Data frame trigger.
                let auth_resp = send_auth_pair(
                    backend,
                    byte,
                    &fp_cfg,
                    &preset,
                    nozzle_index,
                    price,
                    &nozzle_prices,
                    &cfg.connection.protocol,
                );
                {
                    let mut map = runtimes.write().await;
                    if let Some(rt) = map.get_mut(&byte) {
                        // Mark before start_delivery_from_pre_auth so it skips
                        // the deferred-CONFIG path (pending_authorize_config).
                        rt.mark_preauth_config_on_wire();
                        rt.start_delivery_from_pre_auth(&fp_cfg, cfg);
                    }
                }
                ack_frames_in_response(backend, byte, &auth_resp);
                let _ = write_serial(backend, &busy(byte));
                info!(
                    addr = format_args!("0x{byte:02X}"),
                    label = %fp_cfg.label,
                    nozzle = nozzle_index,
                    "Preauthorize (nozzle already up) → full CONFIG + BUSY"
                );
            } else {
                // Holstered pre-auth (lift-first, like Gilbarco): do NOT arm the pump now.
                // Arming a holstered pump means a later cancel must de-authorize it on the wire, and
                // if that STOP is missed the pump can dispense fuel the controller never tracks.
                // Leave the lane PreAuthorized with CONFIG deferred: when the nozzle is lifted, the
                // NozzleUp path calls start_delivery_from_pre_auth → begin_auth_session →
                // SendAuthorizeConfig sends AUTH+CONFIG then (preauth_config_on_wire stays false).
                // A cancel before the lift therefore has nothing armed on the pump to de-authorize.
                // (nozzle_prices was refreshed from the DB above; CONFIG is built from it on lift.)
                debug!(
                    addr = format_args!("0x{byte:02X}"),
                    label = %fp_cfg.label,
                    nozzle = nozzle_index,
                    "Preauthorize (holstered) → deferred; AUTH+CONFIG sent on nozzle lift"
                );
            }
            let _ = events.send(WsEvent::PreAuthorized {
                fp_id: fp_cfg.id.clone(),
                price,
                preset: preset_label_str,
                nozzle_index,
            });
            broadcast_status(byte, runtimes, events).await;
            let disp_by_byte: HashMap<u8, FuelingPositionConfig> = cfg
                .active_positions()
                .into_iter()
                .map(|fp| (fp.address_byte, fp.clone()))
                .collect();
            kick_delivery_polls(
                byte,
                backend,
                &disp_by_byte,
                cfg,
                runtimes,
                events,
                pool,
                shifts,
                4,
            )
            .await;
        }
        DispatchCommand::CancelPreauth { byte } => {
            let fp_cfg = match cfg.position_by_address(byte) {
                Some(p) => p.clone(),
                None => return,
            };
            // De-authorize the pump: STOP halts any active delivery, GO_IDLE clears a holstered
            // authorization. A single STOP does not de-arm an armed-but-idle pump on all firmware, so
            // we send both and set `preauth_cancel_pending` — the poll loop then verifies the pump
            // reports idle (`70 FA`) and treats any delivery before that as unauthorized (re-STOP +
            // alert) instead of fueling silently.
            let _ = exchange_serial(backend, &stop_frame(byte));
            let _ = write_serial(backend, &done(byte));
            {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    if rt.has_cancellable_preauth() {
                        rt.cancel_pre_auth();
                    }
                    rt.mark_preauth_cancel_pending();
                }
            }
            let _ = events.send(WsEvent::PreAuthCancelled {
                fp_id: fp_cfg.id.clone(),
            });
            broadcast_status(byte, runtimes, events).await;
        }
        DispatchCommand::UpdatePrices {
            updates,
            changed_by,
        } => {
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
        // Wayne Europump has no lifetime totalizer query — nothing to refresh.
        DispatchCommand::RefreshTotals => {}
    }
}

// ── Gilbarco Two-Wire Protocol (TWOTP-IS-1.0-S) poll loop ────────────────────

async fn run_gilbarco_poll_loop(
    mut cfg: Arc<SiteConfig>,
    backend: SerialBackend,
    runtimes: Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    mut disp_by_byte: HashMap<u8, FuelingPositionConfig>,
    events: broadcast::Sender<WsEvent>,
    mut commands: mpsc::Receiver<DispatchCommand>,
    pool: SqlitePool,
    shifts: Arc<ShiftCoordinator>,
) {
    use gilbarco::GilbarcoStatus;

    let mut addrs: Vec<u8> = cfg.active_addresses();
    // Startup captures show totals reads for active addresses. Price writes only
    // happen as part of an operator-created authorization transaction.
    let mut pending_startup_totals: HashMap<u8, u8> = addrs.iter().map(|&a| (a, 2)).collect();

    let mut interval = tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    'poll_loop: loop {
        while let Ok(cmd) = commands.try_recv() {
            if let DispatchCommand::ReloadConfig { cfg: next_cfg } = cmd {
                tracing::info!("Gilbarco poll loop reloaded site config");
                cfg = next_cfg;
                disp_by_byte = active_positions_by_byte(&cfg);
                addrs = cfg.active_addresses();
                pending_startup_totals = addrs.iter().map(|&a| (a, 2)).collect();
                interval = tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                continue 'poll_loop;
            }
            gbr_apply_command(&cfg, &runtimes, &events, &backend, cmd, &pool, &shifts).await;
        }

        for byte in addrs.clone() {
            interval.tick().await;
            while let Ok(cmd) = commands.try_recv() {
                if let DispatchCommand::ReloadConfig { cfg: next_cfg } = cmd {
                    tracing::info!("Gilbarco poll loop reloaded site config");
                    cfg = next_cfg;
                    disp_by_byte = active_positions_by_byte(&cfg);
                    addrs = cfg.active_addresses();
                    pending_startup_totals = addrs.iter().map(|&a| (a, 2)).collect();
                    interval =
                        tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    continue 'poll_loop;
                }
                gbr_apply_command(&cfg, &runtimes, &events, &backend, cmd, &pool, &shifts).await;
            }

            let fp_cfg = match disp_by_byte.get(&byte) {
                Some(x) => x,
                None => continue,
            };

            // Send single-byte status request; response: [status] (echo stripped by serial.rs)
            let resp = match exchange_serial(&backend, &gilbarco::status(byte)) {
                Ok(r) if r.len() >= 1 => r,
                _ => {
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
                    broadcast_status(byte, &runtimes, &events).await;
                    continue;
                }
            };

            {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.on_poll_success();
                }
            }

            let gbr_st = gbr_parse_status_response(byte, &resp);

            match gbr_st {
                GilbarcoStatus::Offline => {
                    // Short response already handled above; this is an unknown status byte.
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

                GilbarcoStatus::Idle => {
                    // Gilbarco F-group pumps use addr|0x08 for BOTH Idle and TxComplete.
                    // If we were delivering, this is actually transaction complete.  A
                    // stopped sale is closed from B2/TxComplete or ResetLane retries; do not
                    // auto-reset a non-zero stopped sale just because the pump later reports Idle.
                    let was_delivering = {
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
                    if was_delivering {
                        gbr_close_transaction(
                            byte, fp_cfg, &backend, &cfg, &runtimes, &events, &pool, &shifts,
                        )
                        .await;
                        continue;
                    }

                    if let Some(remaining) = pending_startup_totals.get_mut(&byte) {
                        if *remaining > 0 {
                            let _ = gbr_sync_totals(byte, fp_cfg, &backend, &runtimes).await;
                            *remaining -= 1;
                        }
                    }

                    let is_pre_auth = {
                        let map = runtimes.read().await;
                        map.get(&byte)
                            .map(|rt| {
                                rt.pre_auth.is_some() && rt.state.status == FpStatus::PreAuthorized
                            })
                            .unwrap_or(false)
                    };

                    if is_pre_auth {
                        // 9600 protocol: authorization is pump-side (attendant keypad), no RS-485 command needed.
                        debug!(
                            addr = format_args!("0x{byte:02X}"),
                            "Gilbarco: pre-authorize armed, waiting for pump to self-authorize"
                        );
                    } else {
                        // Genuinely idle — clear any lingering mid-transaction state.
                        // Done is NOT blocked here: for Gilbarco the pump's own TC→Idle
                        // sequence signals that the transaction is fully closed; no separate
                        // operator acknowledgment is needed.  Stopped sales are still blocked
                        // and require explicit operator action via ResetLane.
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
                                // Push any real transition INTO idle (e.g. NozzleUp→Idle when a
                                // wrong/lifted nozzle is holstered) so the UI — and the
                                // wrong-nozzle mismatch banner — updates immediately instead of
                                // waiting for a client-side fallback timer. Steady idle→idle polls
                                // stay silent to avoid per-poll WS spam; the frontend's holdDone
                                // merge still protects the post-fill "last sale" display.
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

                GilbarcoStatus::NozzleLifted => {
                    let in_ghost_recovery = {
                        let map = runtimes.read().await;
                        map.get(&byte)
                            .map(|rt| rt.ghost_recovery_active())
                            .unwrap_or(false)
                    };
                    if in_ghost_recovery {
                        debug!(
                            addr = format_args!("0x{byte:02X}"),
                            "Gilbarco: suppressing NozzleLifted during wrong-nozzle recovery"
                        );
                        broadcast_status(byte, &runtimes, &events).await;
                        continue;
                    }

                    let has_pending_auth = {
                        let map = runtimes.read().await;
                        map.get(&byte)
                            .map(|rt| {
                                rt.pre_auth.is_some() || rt.state.status == FpStatus::PreAuthorized
                            })
                            .unwrap_or(false)
                    };

                    // Never guess the lifted nozzle: a wrong guess could authorize the
                    // wrong product/price. If GetAll can't identify it this poll (rare,
                    // usually a transient RS-485 glitch), do nothing and retry on the
                    // next poll — the read self-heals in ~one cycle. A genuinely
                    // permanent failure during a preauth is caught by the preauth-timeout
                    // task, which cancels and notifies.
                    let Some(nozzle) = gbr_query_nozzle_from_all(byte, &backend) else {
                        warn!(
                            addr = format_args!("0x{byte:02X}"),
                            "Gilbarco: nozzle lifted but GetAll did not identify it — retrying next poll (no guess)"
                        );
                        broadcast_status(byte, &runtimes, &events).await;
                        continue;
                    };
                    let (product_id, product_name) = gbr_nozzle_product(fp_cfg, &cfg, nozzle);
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

                    if has_pending_auth {
                        let expected_nozzle = {
                            let map = runtimes.read().await;
                            map.get(&byte)
                                .and_then(|rt| rt.pre_auth.as_ref().map(|p| p.nozzle_index))
                                .unwrap_or(nozzle)
                        };
                        // Wrong nozzle: a specific nozzle was pre-authorized but a
                        // different one was lifted. Cancel the preauth (the pump is never
                        // authorized, so no wrong-product fuel can flow) and reflect the
                        // physically-lifted wrong nozzle as NozzleUp — NOT Idle, which
                        // would be misleading while a nozzle is in the operator's hand.
                        // (expected_nozzle == 0 is a generic Authorize — any nozzle ok.)
                        if expected_nozzle != 0 && expected_nozzle != nozzle {
                            let expected_name = gbr_nozzle_product(fp_cfg, &cfg, expected_nozzle).1;
                            info!(
                                addr = format_args!("0x{byte:02X}"),
                                expected_nozzle,
                                lifted_nozzle = nozzle,
                                "Gilbarco: preauth nozzle mismatch → cancel preauth + notify"
                            );
                            // NOTE: scope the write guard so it is released BEFORE
                            // broadcast_status (which takes a read lock on the same
                            // RwLock). Holding the write guard across that await
                            // deadlocks this task — the whole poll loop freezes, polling
                            // stops, and the pump-down is never sensed.
                            {
                                let mut map = runtimes.write().await;
                                if let Some(rt) = map.get_mut(&byte) {
                                    // cancel_pre_auth() drops the pre-auth and resets to Idle.
                                    rt.cancel_pre_auth();
                                    // Show the lifted (wrong) nozzle as NozzleUp instead of
                                    // Idle. We deliberately do NOT enter ghost_recovery here:
                                    // pre_auth is now cleared, so the next poll's NozzleLifted
                                    // handler takes the "no pending auth" path (which never
                                    // auto-authorizes in preauth mode) and simply keeps the
                                    // lane at NozzleUp. When the operator holsters the wrong
                                    // nozzle the pump reports Idle and the lane clears normally,
                                    // so a fresh pre-authorization works immediately. The 9600
                                    // pump emits only a status byte (no unsolicited meter Data
                                    // frames), so there is nothing stale to suppress — unlike
                                    // the Wayne path, ghost_recovery would only mask reality.
                                    rt.state.status = FpStatus::NozzleUp;
                                    rt.state.nozzle_index = Some(nozzle);
                                    rt.state.product_id = Some(product_id);
                                    rt.state.product_name = Some(product_name.clone());
                                    rt.state.price = price;
                                }
                            }
                            let _ = events.send(WsEvent::PreAuthNozzleMismatch {
                                fp_id: fp_cfg.id.clone(),
                                expected_nozzle_index: expected_nozzle,
                                expected_product_name: expected_name,
                                lifted_nozzle_index: nozzle,
                                lifted_product_name: product_name.clone(),
                            });
                            broadcast_status(byte, &runtimes, &events).await;
                            continue;
                        }
                        let preset = {
                            let map = runtimes.read().await;
                            map.get(&byte)
                                .map(|rt| rt.last_preset.clone())
                                .unwrap_or_else(|| Preset::Str("full".into()))
                        };
                        if !gbr_send_price_and_preset(byte, nozzle, price, &preset, &backend) {
                            continue;
                        }
                        gbr_send_no_response_command(
                            &backend,
                            &gilbarco::authorize(byte),
                            "authorize",
                        );
                        // No status confirm here: the authorize byte's echo is still
                        // in flight, so a status poll would read the echo, not a real
                        // status. Optimistically enter Authorizing; the main poll loop
                        // confirms Delivering (0x9N) on the next cycles.
                        let tx = CurrentTx {
                            id: uuid::Uuid::new_v4().to_string(),
                            started_at: Utc::now().timestamp_millis(),
                            product_id,
                            product_name: product_name.clone(),
                            nozzle_index: nozzle,
                        };
                        let mut map = runtimes.write().await;
                        if let Some(rt) = map.get_mut(&byte) {
                            rt.current_tx = Some(tx);
                            rt.state.nozzle_index = Some(nozzle);
                            rt.state.product_id = Some(product_id);
                            rt.state.product_name = Some(product_name);
                            rt.state.price = price;
                            rt.state.volume = 0.0;
                            rt.state.amount = 0;
                            rt.state.status = FpStatus::Authorizing;
                            rt.pre_auth = None;
                        }
                        info!(
                            addr = format_args!("0x{byte:02X}"),
                            nozzle, "Gilbarco: NozzleLifted + pre-auth → 0x10|addr sent"
                        );
                    } else {
                        // No pending auth — notify UI and wait for operator.
                        let product_color = cfg
                            .product(product_id)
                            .map(|p| p.color.clone())
                            .unwrap_or_default();
                        let should_emit_nozzle_up = {
                            let mut map = runtimes.write().await;
                            if let Some(rt) = map.get_mut(&byte) {
                                // Don't regress Authorizing/Delivering/Stopped/Done back to NozzleUp
                                // if the pump is slow and still shows NozzleLifted after we sent authorize.
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
                        if should_emit_nozzle_up {
                            let _ = events.send(WsEvent::NozzleUp {
                                fp_id: fp_cfg.id.clone(),
                                nozzle_index: nozzle,
                                product_id,
                                product_name,
                                product_color,
                                price,
                            });
                        }
                    }
                }

                GilbarcoStatus::Ready | GilbarcoStatus::Delivering => {
                    // Send GetDisplay (0x60|addr) → 6 E-prefixed digits encoding live amount / 10.
                    let disp_raw =
                        exchange_serial(&backend, &gilbarco::get_display(byte)).unwrap_or_default();
                    let live_amount_raw = gilbarco::parse_display_response(&disp_raw);
                    let mut map = runtimes.write().await;
                    if let Some(rt) = map.get_mut(&byte) {
                        rt.state.status = FpStatus::Delivering;
                        if let Some(amount_raw) = live_amount_raw {
                            rt.state.amount = gilbarco::live_amount_raw_to_soum(amount_raw);
                            if let Some(vol) = gilbarco::live_amount_raw_to_litres(
                                amount_raw,
                                rt.state.price.into(),
                            ) {
                                rt.state.volume = vol;
                            }
                        }
                        // Ensure a tx record exists if Delivering was first observed here.
                        if rt.current_tx.is_none() {
                            let nozzle = rt.state.nozzle_index.unwrap_or(1);
                            let (pid, pname) = gbr_nozzle_product(fp_cfg, &cfg, nozzle);
                            rt.current_tx = Some(CurrentTx {
                                id: uuid::Uuid::new_v4().to_string(),
                                started_at: Utc::now().timestamp_millis(),
                                product_id: pid,
                                product_name: pname,
                                nozzle_index: nozzle,
                            });
                        }
                    }
                }

                GilbarcoStatus::TransactionComplete => {
                    // A pump in Delivering/Authorizing/Stopped is closing a real sale.
                    // But TC also fires when a lifted-but-unauthorized nozzle is simply
                    // holstered (e.g. after a wrong-nozzle preauth mismatch, the lane
                    // sits at NozzleUp). gbr_close_transaction bails out in that case, so
                    // handle it here: there is no sale to record, so just return the lane
                    // to Idle and broadcast it. Without this the lane lingers on NozzleUp
                    // ("still shows as lifted after the nozzle is down").
                    let closeable = {
                        let map = runtimes.read().await;
                        map.get(&byte)
                            .map(|rt| {
                                matches!(
                                    rt.state.status,
                                    FpStatus::Delivering
                                        | FpStatus::Authorizing
                                        | FpStatus::Stopped { .. }
                                )
                            })
                            .unwrap_or(false)
                    };
                    if closeable {
                        gbr_close_transaction(
                            byte, fp_cfg, &backend, &cfg, &runtimes, &events, &pool, &shifts,
                        )
                        .await;
                    } else {
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

                GilbarcoStatus::Stopped => {
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
                                    stop_source: StopSource::External,
                                };
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
                            stop_source: "EXTERNAL".to_string(),
                        });
                    }
                }

                // ListenMode stray response — no action.
                GilbarcoStatus::ListenMode => {}
            }

            broadcast_status(byte, &runtimes, &events).await;
        }
    }
}

/// Identify the lifted nozzle from the 9600 `F0` all-pump/all-nozzle frame.
fn gbr_query_nozzle_from_all(addr: u8, backend: &SerialBackend) -> Option<u8> {
    // Replays the exact sequence the original 9600 POS used (docs/logs/gilbarco/
    // 9600/*_nozzles_lifted_and_down.log, CH2-Pc = PC-transmit-only):
    //   0x20|addr  ->  (0xD0|addr ack)
    //   FF E9 FE E0 E1 E0 FB EE   (full GetNozzle frame)
    //   F0         ->  BA frame   (lifted-nozzle index at offset 14)
    //
    // The pump will NOT answer `F0` until it has received the COMPLETE 8-byte
    // GetNozzle frame; a single `FF` (commit 6b25944) leaves it unanswered, which
    // both fell back to nozzle 1 AND stalled the poll loop on the 500ms `F0`
    // timeout every cycle (tripping other pumps offline and sticking pump 3 on
    // "lifted"). The nozzle index can only come from the `F0` BA frame — the
    // GetNozzle frame itself has the index stripped by the gilb-v2 board.
    let ack = exchange_serial(backend, &gilbarco::command_mode(addr)).ok()?;
    let expected_ack = 0xD0 | (addr & 0x0F);
    if !ack.contains(&expected_ack) {
        return None;
    }
    std::thread::sleep(Duration::from_millis(15));
    let _ = write_serial(backend, &gilbarco::get_nozzle_frame());
    std::thread::sleep(Duration::from_millis(95));
    let resp = exchange_serial(backend, &gilbarco::get_all()).ok()?;
    let (pump, nozzle) = gilbarco::parse_all_nozzle_response(&resp)?;
    (pump == (addr & 0x0F)).then_some(nozzle)
}

/// Look up (product_id, product_name) for a nozzle by 1-based index.
fn gbr_nozzle_product(
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

fn gbr_preset_amount_raw(preset: &Preset, price: u32) -> Option<u32> {
    match preset {
        Preset::Str(s) if s.eq_ignore_ascii_case("full") => Some(0),
        Preset::Amount(amount) if *amount > 0 && *amount <= 9_999_990 => Some((amount / 10) as u32),
        Preset::Volume(litres) if *litres > 0.0 && price > 0 => {
            Some(((*litres * price as f64) / 10.0).round() as u32)
        }
        _ => None,
    }
}

fn gbr_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn gbr_expect_nonempty_response(
    backend: &SerialBackend,
    frame: &[u8],
    action: &'static str,
) -> Option<Vec<u8>> {
    match exchange_serial(backend, frame) {
        Ok(resp) if !resp.is_empty() => Some(resp),
        Ok(_) => {
            warn!(action, "Gilbarco: command got no pump response");
            None
        }
        Err(e) => {
            warn!(?e, action, "Gilbarco: command exchange failed");
            None
        }
    }
}

fn gbr_send_no_response_command(backend: &SerialBackend, frame: &[u8], action: &'static str) {
    if let Err(e) = write_serial(backend, frame) {
        warn!(?e, action, "Gilbarco: no-response command write failed");
    }
}

async fn gbr_sync_totals(
    byte: u8,
    fp_cfg: &FuelingPositionConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
) -> bool {
    let Some(resp) =
        gbr_expect_nonempty_response(backend, &gilbarco::get_totals(byte), "startup_totals")
    else {
        return false;
    };

    let nozzle_index = {
        let map = runtimes.read().await;
        map.get(&byte)
            .and_then(|rt| rt.state.nozzle_index)
            .or_else(|| fp_cfg.active_nozzles().first().map(|n| n.index))
            .unwrap_or(1)
    };

    let all = gilbarco::parse_all_totals_response(&resp);
    if all.is_empty() {
        warn!(
            byte,
            nozzle_index,
            rx = %gbr_hex(&resp),
            "Gilbarco: startup totals parse failed"
        );
        return true;
    }
    let totals_vec = gbr_totals_to_state(&all);
    // Legacy single fields track the active/selected nozzle (fallback: first entry).
    let pick = all
        .iter()
        .find(|t| t.nozzle_index == nozzle_index)
        .or_else(|| all.first());

    let mut map = runtimes.write().await;
    if let Some(rt) = map.get_mut(&byte) {
        rt.state.pump_totals = totals_vec;
        if let Some(t) = pick {
            rt.state.pump_total_nozzle_index = Some(t.nozzle_index);
            rt.state.pump_total_volume =
                Some(t.volume_total_raw as f64 / GBR_TOTALS_VOLUME_DIVISOR);
            rt.state.pump_total_amount = Some(t.amount_total_raw * 10);
            rt.state.pump_total_price = Some((t.unit_price_raw * 10).min(u32::MAX as u64) as u32);
        }
    }
    true
}

/// GetTotals volume is reported with one fewer decimal place than the per-transaction
/// frame, so the lifetime totalizer volume divides by 100 (not 1000). Matching the
/// real pump's odometer reading — without this the totalizer volume reads 10× low.
const GBR_TOTALS_VOLUME_DIVISOR: f64 = 100.0;

/// Map decoded GetTotals sections to the per-nozzle UI shape (raw pump units →
/// litres / soum, matching the legacy single-field scaling).
fn gbr_totals_to_state(all: &[gilbarco::TotalsData]) -> Vec<PumpNozzleTotals> {
    all.iter()
        .map(|t| PumpNozzleTotals {
            nozzle_index: t.nozzle_index,
            volume: t.volume_total_raw as f64 / GBR_TOTALS_VOLUME_DIVISOR,
            amount: t.amount_total_raw * 10,
            price: (t.unit_price_raw * 10).min(u32::MAX as u64) as u32,
        })
        .collect()
}

fn gbr_enter_command_mode(byte: u8, backend: &SerialBackend, action: &'static str) -> bool {
    let Some(resp) = gbr_expect_nonempty_response(backend, &gilbarco::command_mode(byte), action)
    else {
        return false;
    };
    let expected = 0xD0 | (byte & 0x0F);
    if resp.contains(&expected) {
        return true;
    }
    warn!(
        byte,
        action,
        expected = format_args!("{expected:02X}"),
        rx = %gbr_hex(&resp),
        "Gilbarco: command-mode ack mismatch"
    );
    false
}

fn gbr_send_command_mode_frame(
    byte: u8,
    backend: &SerialBackend,
    frame: &[u8],
    action: &'static str,
) -> bool {
    if !gbr_enter_command_mode(byte, backend, action) {
        return false;
    }
    gbr_send_no_response_command(backend, frame, action);
    // The frame is sent write-only, so its RS-485 echo is still arriving. Wait for
    // the echo to fully land before returning, so the NEXT exchange's input-clear
    // flushes it and its read waits cleanly for the pump's `D` ack instead of
    // returning on the lingering echo (which previously aborted the next step).
    std::thread::sleep(Duration::from_millis(80));
    true
}

fn gbr_parse_status_response(byte: u8, resp: &[u8]) -> gilbarco::GilbarcoStatus {
    resp.iter()
        .rev()
        .map(|&b| gilbarco::parse_status_byte(byte, b))
        .find(|st| *st != gilbarco::GilbarcoStatus::Offline)
        .unwrap_or(gilbarco::GilbarcoStatus::Offline)
}

fn gbr_send_price_and_preset(
    byte: u8,
    nozzle: u8,
    price: u32,
    preset: &Preset,
    backend: &SerialBackend,
) -> bool {
    if price == 0 {
        warn!(byte, nozzle, "Gilbarco: refusing authorize with zero price");
        return false;
    }
    let Some(amount_raw) = gbr_preset_amount_raw(preset, price) else {
        warn!(
            byte,
            nozzle, "Gilbarco: refusing authorize with invalid preset"
        );
        return false;
    };
    if amount_raw > 999_999 {
        warn!(
            byte,
            nozzle, amount_raw, "Gilbarco: refusing preset above protocol limit"
        );
        return false;
    }

    // Authorize sequence (docs/logs/gilbarco/9600/fullfill.log, CH2-Pc): after the
    // nozzle identify (done by gbr_query_nozzle_from_all before we get here):
    //   0x20|addr .. set_price frame
    //   0x20|addr .. preset_amount frame
    //   0x10|addr  authorize (sent by caller)
    //
    // Each command frame is sent write-only, so its RS-485 echo is still in flight
    // immediately afterward. We deliberately do NOT poll status between/after the
    // frames here: that read returns the lingering frame echo (no real status
    // byte) and a strict confirm would spuriously fail and abort the whole
    // authorize — leaving the lane stuck and the pump never fueling. The
    // command-mode entry inside gbr_send_command_mode_frame already gates on the
    // reliable `0xD0|addr` ack, and the main poll loop confirms the pump reaches
    // Delivering (0x9N) on the following cycles.
    //
    // Also do NOT gate on a bare `get_nozzle`/`parse_nozzle_response` (the pump
    // returns only its prompt ack; the E9/E5 payload arrives too late) — same root
    // cause as the nozzle-identification bug.
    if !gbr_send_command_mode_frame(
        byte,
        backend,
        &gilbarco::set_price(nozzle, price / 10),
        "set_price",
    ) {
        return false;
    }
    if !gbr_send_command_mode_frame(
        byte,
        backend,
        &gilbarco::preset_amount(amount_raw),
        "preset_amount",
    ) {
        return false;
    }
    // gbr_send_command_mode_frame already settled after the preset frame, so its
    // echo has drained and the pump has latched it before the caller sends the
    // authorize byte.
    true
}

/// Fetch final transaction data from pump, persist to DB, emit Done event.
async fn gbr_close_transaction(
    byte: u8,
    fp_cfg: &FuelingPositionConfig,
    backend: &SerialBackend,
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
) -> bool {
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

    // Step 1: GetTransaction (0x40|addr) → final sale frame.
    // Step 2: GetTotals (0x50|addr) → accumulated per-nozzle totals.
    let tx_data = exchange_serial(backend, &gilbarco::get_transaction(byte))
        .ok()
        .and_then(|r| gilbarco::parse_transaction_response(&r))
        .or_else(|| {
            exchange_serial(backend, &gilbarco::get_transaction(byte))
                .ok()
                .and_then(|r| gilbarco::parse_transaction_response(&r))
        });
    let totals_raw = exchange_serial(backend, &gilbarco::get_totals(byte)).ok();

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

    let ctx = match ctx {
        Some(c) => c,
        None => {
            if tx_data.is_none() {
                warn!(
                    addr = format_args!("0x{byte:02X}"),
                    "Gilbarco: transaction complete without active transaction or final frame"
                );
                return false;
            }
            // No active tx recorded — create a minimal one for the record.
            let (product_id, product_name) = gbr_nozzle_product(fp_cfg, cfg, nozzle_index);
            CurrentTx {
                id: uuid::Uuid::new_v4().to_string(),
                started_at: Utc::now().timestamp_millis(),
                product_id,
                product_name,
                nozzle_index,
            }
        }
    };

    let price = tx_data
        .map(|td| (td.unit_price_raw * 10).min(u32::MAX as u64) as u32)
        .filter(|p| *p > 0)
        .unwrap_or(state_price);

    let all_totals = totals_raw
        .as_deref()
        .map(gilbarco::parse_all_totals_response)
        .unwrap_or_default();
    if !all_totals.is_empty() {
        let totals_vec = gbr_totals_to_state(&all_totals);
        // Legacy single fields track the nozzle that just sold (fallback: first entry).
        let pick = all_totals
            .iter()
            .find(|t| t.nozzle_index == nozzle_index)
            .or_else(|| all_totals.first());

        info!(
            addr = format_args!("0x{byte:02X}"),
            nozzle_index,
            nozzles = all_totals.len(),
            "Gilbarco: parsed pump totals (all nozzles)"
        );

        let mut map = runtimes.write().await;
        if let Some(rt) = map.get_mut(&byte) {
            rt.state.pump_totals = totals_vec;
            if let Some(t) = pick {
                rt.state.pump_total_nozzle_index = Some(t.nozzle_index);
                rt.state.pump_total_volume =
                    Some(t.volume_total_raw as f64 / GBR_TOTALS_VOLUME_DIVISOR);
                rt.state.pump_total_amount = Some(t.amount_total_raw * 10);
                rt.state.pump_total_price =
                    Some((t.unit_price_raw * 10).min(u32::MAX as u64) as u32);
            }
        }
    }

    let (volume, amount) = match tx_data {
        Some(td) => (td.volume_raw as f64 / 1000.0, td.amount_raw * 10),
        None => {
            warn!(
                addr = format_args!("0x{byte:02X}"),
                "Gilbarco: refusing to save transaction without final frame"
            );
            return false;
        }
    };

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
        warn!(?e, byte, "Gilbarco: DB persist failed for transaction");
        return false;
    }
    // Bump active-shift totals (Wayne does this in FrameEffect::TransactionDone;
    // the Gilbarco close path must do the same or shift reports stay stale).
    if let Err(e) = shifts.on_transaction_recorded(&tx).await {
        warn!(?e, byte, "Gilbarco: shift totals update failed");
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
    info!(
        addr = format_args!("0x{byte:02X}"),
        volume, amount, "Gilbarco: transaction complete, Done emitted"
    );
    true
}

async fn gbr_apply_command(
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    backend: &SerialBackend,
    cmd: DispatchCommand,
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
) {
    match cmd {
        DispatchCommand::ReloadConfig { .. } => {}
        DispatchCommand::Authorize {
            byte,
            price,
            preset,
        } => {
            let fp_cfg = match cfg.position_by_address(byte) {
                Some(p) => p.clone(),
                None => return,
            };
            let nozzle_up = {
                let map = runtimes.read().await;
                map.get(&byte)
                    .filter(|rt| rt.state.status == FpStatus::NozzleUp)
                    .and_then(|rt| rt.state.nozzle_index)
            };
            if let Some(nozzle) = nozzle_up {
                if !gbr_send_price_and_preset(byte, nozzle, price, &preset, backend) {
                    broadcast_status(byte, runtimes, events).await;
                    return;
                }
                gbr_send_no_response_command(backend, &gilbarco::authorize(byte), "authorize");
                // No status confirm: the authorize echo is still in flight; the main
                // poll loop confirms Delivering on the next cycles.
                let (product_id, product_name) = gbr_nozzle_product(&fp_cfg, cfg, nozzle);
                let tx = CurrentTx {
                    id: uuid::Uuid::new_v4().to_string(),
                    started_at: Utc::now().timestamp_millis(),
                    product_id,
                    product_name,
                    nozzle_index: nozzle,
                };
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.current_tx = Some(tx);
                    rt.state.price = price;
                    rt.set_last_preset(preset);
                    rt.state.status = FpStatus::Authorizing;
                    rt.pre_auth = None;
                }
            } else {
                // Queue authorize for when nozzle is lifted.
                let product_id = fp_cfg.nozzles.first().map(|n| n.product_id).unwrap_or(0);
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.pre_auth = Some(PreAuthContext {
                        nozzle_index: 0,
                        product_id,
                    });
                    rt.state.price = price;
                    rt.set_last_preset(preset);
                    rt.pre_auth_started_at = Some(Utc::now().timestamp_millis());
                }
            }
            broadcast_status(byte, runtimes, events).await;
        }

        DispatchCommand::Preauthorize {
            byte,
            price,
            preset,
            nozzle_index,
        } => {
            let fp_cfg = match cfg.position_by_address(byte) {
                Some(p) => p.clone(),
                None => return,
            };
            let (product_id, _product_name) = gbr_nozzle_product(&fp_cfg, cfg, nozzle_index);
            let preset_label_str = preset_label(&preset);
            {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    let nozzle_already_up = rt.state.status == FpStatus::NozzleUp;
                    rt.pre_auth = Some(PreAuthContext {
                        nozzle_index,
                        product_id,
                    });
                    rt.state.price = price;
                    if !nozzle_already_up {
                        rt.state.nozzle_index = Some(nozzle_index);
                        rt.state.product_id = Some(product_id);
                    }
                    if rt.state.status != FpStatus::NozzleUp {
                        rt.state.status = FpStatus::PreAuthorized;
                    }
                    rt.state.pre_auth_preset = Some(preset_label_str.clone());
                    rt.set_last_preset(preset);
                    rt.pre_auth_started_at = Some(Utc::now().timestamp_millis());
                }
            }
            let _ = events.send(WsEvent::PreAuthorized {
                fp_id: fp_cfg.id.clone(),
                price,
                preset: preset_label_str,
                nozzle_index,
            });
            broadcast_status(byte, runtimes, events).await;
        }

        DispatchCommand::Stop { byte } => {
            let fp_cfg = match cfg.position_by_address(byte) {
                Some(p) => p.clone(),
                None => return,
            };
            let _ = write_serial(backend, &gilbarco::halt(byte));
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
            for fp in cfg.active_positions() {
                let _ = write_serial(backend, &gilbarco::halt(fp.address_byte));
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
                        warn!(
                            byte = fp.address_byte,
                            "Gilbarco: reset all skipped active lane"
                        );
                        continue;
                    }
                    if let FpStatus::Stopped { stopped_amount, .. } = rt.state.status {
                        if stopped_amount > 0 {
                            warn!(
                                byte = fp.address_byte,
                                "Gilbarco: reset all skipped non-zero stopped sale"
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
                for attempt in 1..=GBR_RESET_CLOSE_RETRIES {
                    if gbr_close_transaction(
                        byte, &fp_cfg, backend, cfg, runtimes, events, pool, shifts,
                    )
                    .await
                    {
                        closed = true;
                        break;
                    }
                    if amount == 0 || attempt == GBR_RESET_CLOSE_RETRIES {
                        break;
                    }
                    warn!(
                        byte,
                        attempt,
                        max_attempts = GBR_RESET_CLOSE_RETRIES,
                        "Gilbarco: reset lane close retry failed"
                    );
                    tokio::time::sleep(Duration::from_millis(GBR_RESET_CLOSE_RETRY_DELAY_MS)).await;
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
                            attempts = GBR_RESET_CLOSE_RETRIES,
                            "Gilbarco: reset lane refused while stopped sale has non-zero amount"
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
                    Err(e) => warn!(byte, %e, "Gilbarco: dismiss lane"),
                }
            }
        }

        DispatchCommand::UpdatePrices {
            updates,
            changed_by,
        } => {
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

        // Gilbarco does not support E-stop continuation in MVP.
        DispatchCommand::ContinueFill { .. } | DispatchCommand::ResumeFill { .. } => {}

        DispatchCommand::CancelPreauth { byte } => {
            let fp_cfg = match cfg.position_by_address(byte) {
                Some(p) => p.clone(),
                None => return,
            };
            {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.cancel_pre_auth();
                    // Gilbarco never arms the pump for a holstered pre-auth, so there is nothing on
                    // the wire to de-authorize here; set the guard for parity with the shared
                    // unauthorized-delivery safety net.
                    rt.mark_preauth_cancel_pending();
                }
            }
            let _ = events.send(WsEvent::PreAuthCancelled {
                fp_id: fp_cfg.id.clone(),
            });
            broadcast_status(byte, runtimes, events).await;
        }
        DispatchCommand::RefreshTotals => {
            // Operator opened the totalizer view: re-read each lane's lifetime totals
            // now (runs on the poll-loop task, so it shares the serial bus safely).
            // Skip lanes mid-delivery so a totals read doesn't disturb live polling.
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
                if gbr_sync_totals(byte, fp, backend, runtimes).await {
                    broadcast_status(byte, runtimes, events).await;
                }
            }
        }
    }
}

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

async fn run_azt_poll_loop(
    mut cfg: Arc<SiteConfig>,
    backend: SerialBackend,
    runtimes: Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    mut disp_by_byte: HashMap<u8, FuelingPositionConfig>,
    events: broadcast::Sender<WsEvent>,
    mut commands: mpsc::Receiver<DispatchCommand>,
    pool: SqlitePool,
    shifts: Arc<ShiftCoordinator>,
) {
    use azt::AztStatus;

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
                &cfg, &runtimes, &events, &backend, cmd, &pool, &shifts, &mut trk_types,
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
                    &cfg, &runtimes, &events, &backend, cmd, &pool, &shifts, &mut trk_types,
                )
                .await;
            }

            let fp_cfg = match disp_by_byte.get(&byte) {
                Some(x) => x,
                None => continue,
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
                broadcast_status(byte, &runtimes, &events).await;
                continue;
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
                        warn!(net, "AZT: pump idle during active sale — closing out-of-band");
                        azt_close_transaction(
                            byte, fp_cfg, &backend, &cfg, &runtimes, &events, &pool, &shifts,
                            &mut trk_types,
                        )
                        .await;
                        continue;
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
                        broadcast_status(byte, &runtimes, &events).await;
                        continue;
                    }

                    if let Some(remaining) = pending_startup_totals.get_mut(&byte) {
                        if *remaining > 0 {
                            let synced =
                                azt_sync_totals(byte, fp_cfg, &backend, &runtimes).await;
                            if synced {
                                *remaining = 0;
                            } else {
                                *remaining -= 1;
                            }
                            // Learn the TRK type while the lane is quiet.
                            azt_trk_type(net, &backend, &mut trk_types);
                        }
                    }

                    if lifted {
                        // Nozzle up with no pending authorization → notify UI.
                        // `active_nozzle` is the hose that reported lifted.
                        let nozzle = active_nozzle;
                        let (product_id, product_name) =
                            azt_nozzle_product(fp_cfg, &cfg, nozzle);
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
                        broadcast_status(byte, &runtimes, &events).await;
                        continue;
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
                            rt.state.amount =
                                (cd.volume_centilitres * rt.state.price as u64 + 50) / 100;
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
                                    FpStatus::Delivering
                                        | FpStatus::Authorizing
                                        | FpStatus::Stopped { .. }
                                )
                            })
                            .unwrap_or(false)
                    };
                    if closeable {
                        azt_close_transaction(
                            byte, fp_cfg, &backend, &cfg, &runtimes, &events, &pool, &shifts,
                            &mut trk_types,
                        )
                        .await;
                    } else {
                        // No sale of ours (cancelled arming, rejected local dose,
                        // service restart after the fact): acknowledge so the pump
                        // returns to idle, then clear the lane. If the ACK is
                        // missed, keep the lane as-is and retry on the next poll;
                        // otherwise the pump can remain stuck in '4' while the UI
                        // has already moved on.
                        let confirmed = azt_expect_ack(
                            net,
                            &azt::confirm_totals(net),
                            &backend,
                            "confirm_totals",
                        );
                        if !confirmed {
                            warn!(net, "AZT: confirm totals failed — retrying next poll");
                            continue;
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
                    azt_expect_ack(net, &azt::reset(net), &backend, "reset_local_dose");
                }
            }

            broadcast_status(byte, &runtimes, &events).await;
        }
    }
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
            debug!(net, code = format_args!("{c:02X}"), "AZT: short reply to data query");
            None
        }
    }
}

/// Send a command and require an ACK. CAN/NAK/no-reply are logged and fail.
fn azt_expect_ack(net: u8, frame: &[u8], backend: &SerialBackend, action: &'static str) -> bool {
    match azt_exchange(net, frame, backend) {
        Some(azt::Response::Short(azt::ACK)) => true,
        Some(azt::Response::Short(code)) => {
            warn!(net, action, code = format_args!("{code:02X}"), "AZT: command refused");
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
    let t = azt_query_data(net, &azt::trk_type(net), backend)
        .and_then(|d| azt::parse_trk_type(&d))?;
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
fn azt_arm(net: u8, price: u32, preset: &Preset, backend: &SerialBackend) -> Result<(), &'static str> {
    if price == 0 {
        return Err("zero price");
    }
    if price > AZT_MAX_PRICE {
        return Err("price exceeds the 4-digit protocol field (§7.10, wire = soum/10)");
    }
    if price % AZT_WIRE_UNIT as u32 != 0 {
        // 10-soum wire resolution: 11 305 soum/L would silently sell at 11 300.
        warn!(net, price, "AZT: price not a multiple of 10 soum — wire truncates");
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

    info!(net, volume, amount, "AZT: transaction complete, Done emitted");
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
                azt_expect_ack(net, &azt::confirm_totals(net), backend, "cancel_preauth_confirm");
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
                nozzle,
                "AZT: direct authorize start command ACKed after status 2"
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
    info!(net, nozzle, price, "AZT: pump armed (price+dose+authorize ACKed)");
    broadcast_status(byte, runtimes, events).await;
}
