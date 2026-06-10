use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use crate::engine::serial::ReconnectingSerial;
use anyhow::Result;
use chrono::Utc;
use site_config::{FuelingPositionConfig, SiteConfig};
use sqlx::SqlitePool;
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing::{debug, info, warn};
use site_config::Protocol;
use types::{preset_label, FpStatus, Preset, StopSource, UpdatePriceCmd, WsEvent};
use wayne_europump::{
    ack, authorise_cmd, authorize_config, authorize_initial, busy, done, encode_preset_limit_bcd,
    parse_frame, poll, pre_authorise_price, stop_frame, stop_pre_frame, Frame,
    FrameAccumulator,
};

use super::state::{FrameEffect, RuntimeFp, TxCompleteAction, DECEL_WINDOW_TIMEOUT_MS};
use crate::shifts::ShiftCoordinator;

/// RS-485 needs quiet time between polls to different addresses (ms).
const RS485_TURNAROUND_MS: u64 = 50;

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
fn wayne_nozzle_prices(fp: &FuelingPositionConfig) -> Vec<u32> {
    let mut nozzles: Vec<_> = fp.nozzles.iter().collect();
    nozzles.sort_by_key(|n| n.wayne_code);
    nozzles.into_iter().map(|n| n.price).collect()
}

fn preset_limit_bcd(preset: &Preset, price_per_liter: u32) -> [u8; 3] {
    match preset {
        Preset::Str(s) if s.eq_ignore_ascii_case("full") => {
            encode_preset_limit_bcd(true, None, None, None)
        }
        Preset::Volume(v) if *v > 0.0 => encode_preset_limit_bcd(false, Some(*v), None, None),
        Preset::Amount(a) if *a > 0 => {
            encode_preset_limit_bcd(false, None, Some(*a), Some(price_per_liter))
        }
        _ => encode_preset_limit_bcd(true, None, None, None),
    }
}

/// DartV1: prices for all active nozzles sorted by 1-based index.
fn dart_nozzle_prices(fp: &FuelingPositionConfig) -> Vec<u32> {
    let mut nozzles: Vec<_> = fp.nozzles.iter().filter(|n| n.active).collect();
    nozzles.sort_by_key(|n| n.index);
    nozzles.iter().map(|n| n.price).collect()
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
    protocol: &Protocol,
) -> Vec<u8> {
    if matches!(protocol, Protocol::WayneDartV1) {
        let prices = dart_nozzle_prices(fp);
        let _ = exchange_serial(backend, &pre_authorise_price(byte, &prices, active_nozzle));
        let limit = dart_limit_bcd(preset, price_per_liter);
        exchange_serial(backend, &authorise_cmd(byte, active_nozzle, limit)).unwrap_or_default()
    } else {
        let products = wayne_product_codes(fp);
        let prices = wayne_nozzle_prices(fp);
        let limit = preset_limit_bcd(preset, price_per_liter);
        let cfg = authorize_config(byte, &products, &prices, limit);
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
        let preauth_armed = rt.preauth_config_on_wire;
        let confirmed = rt.preauth_nozzle_confirmed;
        let has_pre = rt.pre_auth.is_some();
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
                let preset = map
                    .get(&byte)
                    .map(|rt| rt.last_preset.clone())
                    .unwrap_or(Preset::Str("full".into()));
                let price = map
                    .get(&byte)
                    .map(|rt| rt.state.price)
                    .unwrap_or_else(|| fp_cfg.default_price().unwrap_or(0));
                (preset, price)
            };
            let auth_resp = send_auth_pair(
                backend,
                byte,
                &fp_cfg,
                &preset,
                lifted_nozzle,
                price,
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
            if confirmed && (has_pre || preauth_armed) {
                rt.start_delivery_from_pre_auth(&fp_cfg, cfg);
            }
        }
    }
}

#[derive(Debug)]
pub enum DispatchCommand {
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

pub async fn run_poll_loop(
    cfg: Arc<SiteConfig>,
    backend: SerialBackend,
    runtimes: Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    disp_by_byte: HashMap<u8, FuelingPositionConfig>,
    events: broadcast::Sender<WsEvent>,
    mut commands: mpsc::Receiver<DispatchCommand>,
    pool: SqlitePool,
    shifts: Arc<ShiftCoordinator>,
) {
    let addrs: Vec<u8> = cfg.active_addresses();

    let mut interval = tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut accum = FrameAccumulator::default();

    loop {
        while let Ok(cmd) = commands.try_recv() {
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

        for &byte in &addrs {
            interval.tick().await;
            while let Ok(cmd) = commands.try_recv() {
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
                    } else if saw_foreign_response {
                        // Bus is alive; another lane's frame arrived in our slot.
                        rt.on_poll_crosstalk();
                    } else {
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
                                let preset = rt.decel_pending_preset.take()
                                    .unwrap_or_else(|| rt.last_preset.clone());
                                let ss = rt.decel_pending_stop_source;
                                rt.clear_decel_window();
                                rt.enter_stopped_state(
                                    &fp_cfg, &cfg,
                                    active_shift_id.clone(), active_operator_name.clone(),
                                    preset, ss,
                                )
                            })
                        };
                        if let Some(FrameEffect::Paused {
                            tx, fp_id, stopped_volume, stopped_amount, stopped_tx_id, stop_source,
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
                            if let Err(e) = crate::db::queries::insert_transaction(&pool, &tx).await {
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
        FrameEffect::PreAuthNozzleMismatch {
            expected_nozzle_index,
            expected_product_name,
            lifted_nozzle_index,
            lifted_product_name,
        } => {
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
        FrameEffect::SendAuthorizeConfig => {
            let (preset, active_nozzle, price) = {
                let map = runtimes.read().await;
                let preset = map
                    .get(&byte)
                    .map(|rt| rt.last_preset.clone())
                    .unwrap_or(Preset::Str("full".into()));
                let nozzle = map
                    .get(&byte)
                    .and_then(|rt| rt.state.nozzle_index)
                    .unwrap_or(1);
                let price = map
                    .get(&byte)
                    .map(|rt| rt.state.price)
                    .unwrap_or_else(|| fp_cfg.default_price().unwrap_or(0));
                (preset, nozzle, price)
            };
            let auth_resp = send_auth_pair(
                backend,
                byte,
                &fp_cfg,
                &preset,
                active_nozzle,
                price,
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
                    map.get(&byte).and_then(|rt| rt.state.nozzle_index).unwrap_or(1)
                };
                // Send CONFIG with the remaining limit immediately after AUTH so the pump
                // uses the correct hardware limit when the customer lifts the nozzle.
                let _ = send_auth_pair(
                    backend,
                    byte,
                    &fp_cfg,
                    &preset,
                    active_nozzle,
                    price,
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
                    rt.map_or(false, |r| matches!(
                        r.state.status,
                        FpStatus::Delivering
                            | FpStatus::Authorizing
                            | FpStatus::NozzleUp
                            | FpStatus::PreAuthorized
                    ) || r.current_tx.is_some()),
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
                map.get_mut(&byte)
                    .and_then(|rt| rt.apply_stop(&fp_cfg, cfg, active_shift_id, active_operator_name, cfg.ui.use_decel_window_on_stop, cfg.ui.use_stop_mode))
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
                    map.get(&byte).and_then(|rt| rt.state.nozzle_index).unwrap_or(1)
                };
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
            // §8.2: broadcast 0x31 pre-commands to all addresses first (write-
            // only, no wait), then send the 0x30 stop to each in turn.
            for &addr in &cfg.active_addresses() {
                let _ = write_serial(backend, &stop_pre_frame(addr));
            }
            for &addr in &cfg.active_addresses() {
                let f = stop_frame(addr);
                let _ = exchange_serial(backend, &f);
            }
            let (active_shift_id, active_operator_name) = shifts.active_info().await;
            let mut stopped_effects = Vec::new();
            {
                let mut map = runtimes.write().await;
                for fp in cfg.active_positions() {
                    if let Some(rt) = map.get_mut(&fp.address_byte) {
                        if let Some(effect) = rt.apply_stop(fp, cfg, active_shift_id.clone(), active_operator_name.clone(), false, false) {
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
            let lift_confirmed = {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.apply_preauthorize_sent(&fp_cfg, cfg, nozzle_index, price, preset.clone());
                    rt.preauth_nozzle_confirmed
                } else {
                    false
                }
            };
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
                // Holstered preauth: CONFIG sent before lift; StatusTransition arrives
                // during a later POLL when the nozzle is lifted, handled normally then.
                let auth_resp = send_auth_pair(
                    backend,
                    byte,
                    &fp_cfg,
                    &preset,
                    nozzle_index,
                    price,
                    &cfg.connection.protocol,
                );
                // Only mark config on wire when the pump actually ACKed it (C0 FA in
                // response). If CONFIG got no reply the flag stays false, so
                // start_delivery_from_pre_auth will call begin_auth_session() on NozzleUp
                // and the first Data frame will retrigger SendAuthorizeConfig.
                let config_acked = auth_resp.windows(2).any(|w| w == [0xC0, 0xFA]);
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    if config_acked {
                        rt.mark_preauth_config_on_wire();
                    }
                }
            }
            let _ = events.send(WsEvent::PreAuthorized {
                fp_id: fp_cfg.id.clone(),
                price,
                preset: preset_label_str,
                nozzle_index,
            });
            if !lift_confirmed {
                let b = busy(byte);
                let _ = exchange_serial(backend, &b);
            }
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
            let abort_f = stop_frame(byte);
            let _ = exchange_serial(backend, &abort_f);
            {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    if rt.has_cancellable_preauth() {
                        rt.cancel_pre_auth();
                    }
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
    }
}
