//! SHELF methane-dispenser protocol V2.2 runtime.
//!
//! Each configured fueling position is one uniquely addressed SHELF gun. Wire
//! framing and parsing live in `shelf-v22`; this module owns polling, packet
//! indices, commands, runtime state and durable transaction close.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use site_config::{FuelingPositionConfig, SiteConfig};
use sqlx::SqlitePool;
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing::{debug, info, warn};
use types::{FpStatus, Preset, PumpNozzleTotals, StopSource, Transaction, TxStatus, WsEvent};

use super::shared::{
    active_positions_by_byte, broadcast_status, commit_sale, exchange_serial, mark_missed,
    preset_metadata, SerialBackend,
};
use crate::engine::poll_loop::DispatchCommand;
use crate::engine::state::{CurrentTx, PreAuthContext, RuntimeFp};
use crate::shifts::ShiftCoordinator;

const EXCHANGE_RETRIES: usize = 20;
const STATUS_REPLIES: &[u8] = &[0x81, 0x82, 0x83, 0x84, 0x85, 0x93, 0xFF];
const COMMAND_REPLIES: &[u8] = &[0x00, 0x84, 0xFF];
const AMOUNT_REPLIES: &[u8] = &[0x85, 0x92, 0x93, 0xFF];
const PRESSURE_REPLIES: &[u8] = &[0xA3, 0xFF];
const TOTAL_REPLIES: &[u8] = &[0xA0, 0xFF];

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
    let mut addresses = cfg.active_addresses();
    let mut indices: HashMap<u8, u8> = addresses.iter().map(|&a| (a, 0)).collect();
    let mut interval = poll_interval(&cfg);

    info!(?addresses, "SHELF V2.2 poll loop started");
    sync_configured_prices(&cfg, &backend, &mut indices);

    'poll_loop: loop {
        while let Ok(command) = commands.try_recv() {
            if let DispatchCommand::ReloadConfig { cfg: next } = command {
                cfg = next;
                disp_by_byte = active_positions_by_byte(&cfg);
                addresses = cfg.active_addresses();
                indices.retain(|address, _| addresses.contains(address));
                for &address in &addresses {
                    indices.entry(address).or_insert(0);
                }
                interval = poll_interval(&cfg);
                sync_configured_prices(&cfg, &backend, &mut indices);
                info!(?addresses, "SHELF V2.2 config reloaded");
                continue 'poll_loop;
            }
            apply_command(&cfg, &backend, &runtimes, &events, &mut indices, command).await;
        }

        interval.tick().await;
        for address in addresses.clone() {
            while let Ok(command) = commands.try_recv() {
                if let DispatchCommand::ReloadConfig { cfg: next } = command {
                    cfg = next;
                    disp_by_byte = active_positions_by_byte(&cfg);
                    addresses = cfg.active_addresses();
                    indices.retain(|address, _| addresses.contains(address));
                    for &address in &addresses {
                        indices.entry(address).or_insert(0);
                    }
                    interval = poll_interval(&cfg);
                    sync_configured_prices(&cfg, &backend, &mut indices);
                    info!(?addresses, "SHELF V2.2 config reloaded");
                    continue 'poll_loop;
                }
                apply_command(&cfg, &backend, &runtimes, &events, &mut indices, command).await;
            }

            let Some(fp) = disp_by_byte.get(&address) else {
                continue;
            };
            poll_position(
                address,
                fp,
                &cfg,
                &backend,
                &runtimes,
                &events,
                &pool,
                &shifts,
                &mut indices,
            )
            .await;
        }
    }
}

fn poll_interval(cfg: &SiteConfig) -> tokio::time::Interval {
    let mut interval = tokio::time::interval(Duration::from_millis(cfg.polling.interval_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval
}

#[allow(clippy::too_many_arguments)]
async fn poll_position(
    address: u8,
    fp: &FuelingPositionConfig,
    cfg: &SiteConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
    indices: &mut HashMap<u8, u8>,
) {
    let response = exchange(address, STATUS_REPLIES, indices, backend, |index| {
        shelf_v22::status(address, index)
    });
    let Some(response) = response else {
        mark_missed(
            address,
            fp,
            cfg.polling.offline_threshold_polls,
            runtimes,
            events,
        )
        .await;
        broadcast_status(address, runtimes, events).await;
        return;
    };

    {
        let mut map = runtimes.write().await;
        if let Some(rt) = map.get_mut(&address) {
            rt.on_poll_success();
        }
    }

    if let Some(final_sale) = shelf_v22::parse_final_sale(&response) {
        if close_transaction(address, fp, cfg, final_sale, runtimes, events, pool, shifts).await {
            // Appendix 1 recommends a total-counter read immediately after MAR.
            let _ = sync_totalizer(address, fp, backend, runtimes, indices).await;
            broadcast_status(address, runtimes, events).await;
        }
        return;
    }

    let Some(status) = shelf_v22::parse_live_status(&response) else {
        debug!(
            address,
            command = response.command,
            "SHELF: unhandled status response"
        );
        broadcast_status(address, runtimes, events).await;
        return;
    };

    match status.state {
        shelf_v22::ShelfState::Dispensing => {
            if status.paused() || status.stopped() {
                // Pause/resume is unsupported: a fill interrupted on the
                // dispenser side is terminated so it reports a final MAR and
                // the sale closes durably.
                warn!(
                    address,
                    "SHELF fill reported paused/stopped; sending terminal stop"
                );
                let _ = exchange(address, COMMAND_REPLIES, indices, backend, |index| {
                    shelf_v22::stop(address, index)
                });
            } else if !status.any_gun_lifted()
                && status.volume_steps.unwrap_or_default() == 0
                && has_pending_preauth(address, runtimes).await
            {
                // A dose command may return 0x84 while it is merely queued for
                // a holstered gun. Keep PRE_AUTHORIZED until a gun bit or meter
                // movement proves that delivery has actually begun.
            } else {
                update_live(address, fp, cfg, status, runtimes).await;
            }
            // Appendix 1 requires status and pressure commands to alternate
            // throughout delivery. Pressure is telemetry-only for now, but the
            // request itself is part of the dispenser watchdog workflow.
            let _ = exchange(address, PRESSURE_REPLIES, indices, backend, |index| {
                shelf_v22::pressure(address, index)
            });
        }
        shelf_v22::ShelfState::Synchronizing => {
            // End-of-fill handshake: acknowledge by advancing the packet index,
            // then the dispenser returns MAR (0x93) with authoritative totals.
            if let Some(steps) = status.volume_steps {
                update_meter(address, steps, runtimes).await;
            }
        }
        shelf_v22::ShelfState::Idle => {
            if status.any_gun_lifted() {
                emit_nozzle_up(address, fp, cfg, runtimes, events).await;
            } else {
                let has_transaction = {
                    let map = runtimes.read().await;
                    map.get(&address).is_some_and(|rt| rt.current_tx.is_some())
                };
                if has_transaction {
                    // Recover a final MAR if the normal 0x85→0x93 sequence was
                    // missed around the dispenser's 60–100 ms NVRAM pause.
                    if let Some(final_response) =
                        exchange(address, AMOUNT_REPLIES, indices, backend, |index| {
                            shelf_v22::amount_info(address, index)
                        })
                    {
                        if let Some(final_sale) = shelf_v22::parse_final_sale(&final_response) {
                            if close_transaction(
                                address, fp, cfg, final_sale, runtimes, events, pool, shifts,
                            )
                            .await
                            {
                                let _ =
                                    sync_totalizer(address, fp, backend, runtimes, indices).await;
                                broadcast_status(address, runtimes, events).await;
                            }
                            return;
                        }
                    }
                } else {
                    idle_lane(address, runtimes).await;
                }
            }
        }
        shelf_v22::ShelfState::KeypadActive | shelf_v22::ShelfState::KeypadRequest => {
            emit_nozzle_up(address, fp, cfg, runtimes, events).await;
        }
        _ => {}
    }

    broadcast_status(address, runtimes, events).await;
}

async fn has_pending_preauth(address: u8, runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>) -> bool {
    let map = runtimes.read().await;
    map.get(&address).is_some_and(|rt| rt.pre_auth.is_some())
}

fn exchange(
    address: u8,
    expected_commands: &[u8],
    indices: &mut HashMap<u8, u8>,
    backend: &SerialBackend,
    build: impl Fn(u8) -> Vec<u8>,
) -> Option<shelf_v22::Response> {
    let index = *indices.entry(address).or_insert(0);
    let frame = build(index);
    for attempt in 0..EXCHANGE_RETRIES {
        let Ok(raw) = exchange_serial(backend, &frame) else {
            continue;
        };
        let mut cursor = 0usize;
        while cursor < raw.len() {
            let Some((candidate, used)) = shelf_v22::take_frame(&raw[cursor..]) else {
                break;
            };
            cursor += used;
            if let Some(response) = shelf_v22::decode_response(address, index, &candidate) {
                // Ignore a locally echoed request and unrelated valid frames.
                if !expected_commands.contains(&response.command) {
                    continue;
                }
                indices.insert(address, index.wrapping_add(1));
                return Some(response);
            }
        }
        debug!(
            address,
            index, attempt, "SHELF: no valid response, retrying same index"
        );
    }
    None
}

fn command_ok(response: &shelf_v22::Response) -> bool {
    response.command == 0x00 || response.command == 0x84
}

fn sync_configured_prices(
    cfg: &SiteConfig,
    backend: &SerialBackend,
    indices: &mut HashMap<u8, u8>,
) {
    for fp in cfg.active_positions() {
        let Some(nozzle) = fp.nozzles.iter().find(|nozzle| nozzle.active) else {
            continue;
        };
        let address = fp.address_byte;
        let response = exchange(address, COMMAND_REPLIES, indices, backend, |index| {
            shelf_v22::write_price(address, index, nozzle.price)
                .expect("validated SHELF config price")
        });
        if !response.as_ref().is_some_and(command_ok) {
            warn!(
                address,
                price = nozzle.price,
                "SHELF startup price synchronization failed"
            );
        }
    }
}

fn primary_nozzle(
    fp: &FuelingPositionConfig,
    cfg: &SiteConfig,
) -> Option<(u8, u8, String, String, u32)> {
    let nozzle = fp.nozzles.iter().find(|n| n.active)?;
    let product = cfg.product(nozzle.product_id);
    Some((
        nozzle.index,
        nozzle.product_id,
        product.map(|p| p.name.clone()).unwrap_or_default(),
        product.map(|p| p.color.clone()).unwrap_or_default(),
        nozzle.price,
    ))
}

async fn emit_nozzle_up(
    address: u8,
    fp: &FuelingPositionConfig,
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
) {
    let Some((nozzle_index, product_id, product_name, product_color, configured_price)) =
        primary_nozzle(fp, cfg)
    else {
        return;
    };
    let (changed, price) = {
        let mut map = runtimes.write().await;
        let Some(rt) = map.get_mut(&address) else {
            return;
        };
        let price = rt
            .nozzle_prices
            .get(&nozzle_index)
            .copied()
            .unwrap_or(configured_price);
        let changed = matches!(rt.state.status, FpStatus::Idle | FpStatus::Offline)
            || rt.state.nozzle_index != Some(nozzle_index);
        if !matches!(
            rt.state.status,
            FpStatus::Delivering | FpStatus::Stopped { .. } | FpStatus::Done
        ) {
            rt.state.status = FpStatus::NozzleUp;
            rt.state.nozzle_index = Some(nozzle_index);
            rt.state.product_id = Some(product_id);
            rt.state.product_name = Some(product_name.clone());
            rt.state.product_color = Some(product_color.clone());
            rt.state.price = price;
        }
        (changed, price)
    };
    if changed {
        let _ = events.send(WsEvent::NozzleUp {
            fp_id: fp.id.clone(),
            nozzle_index,
            product_id,
            product_name,
            product_color,
            price,
        });
    }
}

async fn update_live(
    address: u8,
    fp: &FuelingPositionConfig,
    cfg: &SiteConfig,
    status: shelf_v22::LiveStatus,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
) {
    let Some((nozzle_index, product_id, product_name, product_color, configured_price)) =
        primary_nozzle(fp, cfg)
    else {
        return;
    };
    let mut map = runtimes.write().await;
    let Some(rt) = map.get_mut(&address) else {
        return;
    };
    let price = rt
        .nozzle_prices
        .get(&nozzle_index)
        .copied()
        .unwrap_or(configured_price);
    let volume = status.volume_steps.unwrap_or(0) as f64 / shelf_v22::VOLUME_STEPS_PER_CUBIC_METRE;
    let amount = (volume * price as f64).round() as u64;
    if let Some(continuation) = rt.continuation.as_mut() {
        continuation.segment_volume = (volume - continuation.base_volume).max(0.0);
        continuation.segment_amount = amount.saturating_sub(continuation.base_amount);
        rt.state.base_volume = Some(continuation.base_volume);
        rt.state.base_amount = Some(continuation.base_amount);
        rt.state.segment_volume = Some(continuation.segment_volume);
        rt.state.segment_amount = Some(continuation.segment_amount);
    } else {
        rt.state.base_volume = None;
        rt.state.base_amount = None;
        rt.state.segment_volume = None;
        rt.state.segment_amount = None;
    }
    rt.state.status = FpStatus::Delivering;
    rt.state.nozzle_index = Some(nozzle_index);
    rt.state.product_id = Some(product_id);
    rt.state.product_name = Some(product_name.clone());
    rt.state.product_color = Some(product_color);
    rt.state.price = price;
    rt.state.volume = volume;
    rt.state.amount = amount;
    if rt.current_tx.is_none() {
        rt.current_tx = Some(CurrentTx {
            id: uuid::Uuid::new_v4().to_string(),
            started_at: Utc::now().timestamp_millis(),
            product_id,
            product_name,
            nozzle_index,
        });
    }
    rt.pre_auth = None;
}

async fn update_meter(
    address: u8,
    volume_steps: u32,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
) {
    let mut map = runtimes.write().await;
    if let Some(rt) = map.get_mut(&address) {
        let volume = volume_steps as f64 / shelf_v22::VOLUME_STEPS_PER_CUBIC_METRE;
        rt.state.volume = volume;
        rt.state.amount = (volume * rt.state.price as f64).round() as u64;
    }
}

async fn idle_lane(address: u8, runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>) {
    let mut map = runtimes.write().await;
    let Some(rt) = map.get_mut(&address) else {
        return;
    };
    if !matches!(rt.state.status, FpStatus::Stopped { .. } | FpStatus::Done) {
        rt.state.status = FpStatus::Idle;
        rt.state.volume = 0.0;
        rt.state.amount = 0;
        rt.state.nozzle_index = None;
        rt.state.pre_auth_preset = None;
        rt.current_tx = None;
        rt.pre_auth = None;
    }
}

#[allow(clippy::too_many_arguments)]
async fn close_transaction(
    address: u8,
    fp: &FuelingPositionConfig,
    cfg: &SiteConfig,
    final_sale: shelf_v22::FinalSale,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
) -> bool {
    let Some((nozzle_index, product_id, product_name, _, configured_price)) =
        primary_nozzle(fp, cfg)
    else {
        return false;
    };
    let (context, continuation, preset, runtime_price) = {
        let map = runtimes.read().await;
        let Some(rt) = map.get(&address) else {
            return false;
        };
        (
            rt.current_tx.clone(),
            rt.continuation.clone(),
            rt.last_preset.clone(),
            rt.state.price,
        )
    };
    let volume = final_sale.volume_steps as f64 / shelf_v22::VOLUME_STEPS_PER_CUBIC_METRE;
    if volume <= 0.0 && context.is_none() {
        idle_lane(address, runtimes).await;
        return false;
    }
    let context = context.unwrap_or_else(|| CurrentTx {
        id: uuid::Uuid::new_v4().to_string(),
        started_at: Utc::now().timestamp_millis(),
        product_id,
        product_name: product_name.clone(),
        nozzle_index,
    });
    let price = if final_sale.price > 0 {
        final_sale.price as u32
    } else if runtime_price > 0 {
        runtime_price
    } else {
        configured_price
    };
    let combined_amount = if final_sale.amount > 0 {
        final_sale.amount as u64
    } else {
        (volume * price as f64).round() as u64
    };
    let segment_volume = continuation
        .as_ref()
        .map(|c| (volume - c.base_volume).max(0.0))
        .unwrap_or(volume);
    let segment_amount = continuation
        .as_ref()
        .map(|c| combined_amount.saturating_sub(c.base_amount))
        .unwrap_or(combined_amount);
    let (shift_id, operator_name) = shifts.active_info().await;
    let (preset_type, preset_value, _) = preset_metadata(&preset);
    let preset_label = Some(shelf_preset_label(&preset));
    let transaction = Transaction {
        id: context.id.clone(),
        fp_id: fp.id.clone(),
        label: fp.label.clone(),
        address_byte: address,
        started_at: context.started_at,
        completed_at: Some(Utc::now().timestamp_millis()),
        volume: segment_volume,
        amount: segment_amount,
        price,
        nozzle_index: context.nozzle_index,
        product_id: context.product_id,
        product_name: context.product_name.clone(),
        preset_type,
        preset_value,
        preset_label,
        status: TxStatus::resolve(volume, true),
        shift_id,
        operator_name,
        parent_tx_id: continuation.as_ref().map(|c| c.parent_tx_id.clone()),
        combined_volume: volume,
        combined_amount,
    };
    if !commit_sale(pool, shifts, events, &transaction).await {
        return false;
    }
    let mut map = runtimes.write().await;
    if let Some(rt) = map.get_mut(&address) {
        rt.state.status = FpStatus::Done;
        rt.state.volume = volume;
        rt.state.amount = combined_amount;
        rt.state.price = price;
        rt.state.nozzle_index = Some(context.nozzle_index);
        rt.current_tx = None;
        rt.continuation = None;
        rt.pre_auth = None;
    }
    info!(
        address,
        volume_m3 = volume,
        amount = combined_amount,
        "SHELF transaction committed"
    );
    true
}

fn dose_frame(
    address: u8,
    index: u8,
    preset: &Preset,
    price: u32,
) -> Result<Vec<u8>, &'static str> {
    match preset {
        Preset::Volume(cubic_metres) => {
            let steps = (cubic_metres * shelf_v22::VOLUME_STEPS_PER_CUBIC_METRE).round() as u32;
            shelf_v22::write_volume(address, index, steps, price)
                .ok_or("SHELF volume/price is outside the wire range")
        }
        Preset::Amount(amount) => {
            let amount =
                u32::try_from(*amount).map_err(|_| "SHELF amount is outside the wire range")?;
            shelf_v22::write_money(address, index, amount)
                .ok_or("SHELF amount is outside the wire range")
        }
        Preset::Str(value) if value.eq_ignore_ascii_case("full") => {
            let by_amount = shelf_v22::MAX_DOSE
                .saturating_mul(100)
                .checked_div(price.max(1))
                .unwrap_or(shelf_v22::MAX_DOSE);
            let steps = shelf_v22::MAX_DOSE.min(by_amount).max(1);
            shelf_v22::write_volume(address, index, steps, price)
                .ok_or("SHELF full preset is outside the wire range")
        }
        Preset::Str(_) => Err("unsupported SHELF preset"),
    }
}

#[allow(clippy::too_many_arguments)]
async fn authorize(
    cfg: &SiteConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    indices: &mut HashMap<u8, u8>,
    address: u8,
    price: u32,
    preset: Preset,
    requested_nozzle: Option<u8>,
) {
    let Some(fp) = cfg.position_by_address(address) else {
        return;
    };
    let Some((nozzle_index, product_id, product_name, product_color, _)) = primary_nozzle(fp, cfg)
    else {
        return;
    };
    if requested_nozzle.is_some_and(|requested| requested != nozzle_index) {
        warn!(
            address,
            requested_nozzle, nozzle_index, "SHELF authorize rejected wrong nozzle"
        );
        return;
    }
    if price == 0 || price > shelf_v22::MAX_PRICE {
        warn!(address, price, "SHELF authorize price outside 1..=9999");
        return;
    }
    let price_response = exchange(address, COMMAND_REPLIES, indices, backend, |index| {
        shelf_v22::write_price(address, index, price).expect("validated SHELF price")
    });
    if !price_response.as_ref().is_some_and(command_ok) {
        warn!(address, "SHELF price write rejected; authorization aborted");
        return;
    }
    if let Err(error) = dose_frame(address, 0, &preset, price) {
        warn!(
            address,
            ?preset,
            error,
            "SHELF dose rejected before wire send"
        );
        return;
    }
    let response = exchange(address, COMMAND_REPLIES, indices, backend, |index| {
        dose_frame(address, index, &preset, price).expect("SHELF dose was prevalidated")
    });
    if !response.as_ref().is_some_and(command_ok) {
        warn!(address, ?preset, "SHELF dose rejected");
        return;
    }
    {
        let mut map = runtimes.write().await;
        if let Some(rt) = map.get_mut(&address) {
            rt.state.status = FpStatus::PreAuthorized;
            rt.state.nozzle_index = Some(nozzle_index);
            rt.state.product_id = Some(product_id);
            rt.state.product_name = Some(product_name);
            rt.state.product_color = Some(product_color);
            rt.state.price = price;
            rt.state.pre_auth_preset = Some(shelf_preset_label(&preset));
            rt.set_last_preset(preset);
            rt.pre_auth = Some(PreAuthContext {
                nozzle_index,
                product_id,
            });
            rt.pre_auth_started_at = Some(Utc::now().timestamp_millis());
        }
    }
    broadcast_status(address, runtimes, events).await;
}

fn shelf_preset_label(preset: &Preset) -> String {
    match preset {
        Preset::Str(value) if value.eq_ignore_ascii_case("full") => "Full tank".into(),
        Preset::Volume(cubic_metres) => format!("{cubic_metres:.2} m³"),
        Preset::Amount(amount) => format!("{amount} sum"),
        Preset::Str(_) => "Preset".into(),
    }
}

async fn sync_totalizer(
    address: u8,
    fp: &FuelingPositionConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    indices: &mut HashMap<u8, u8>,
) -> bool {
    let response = exchange(address, TOTAL_REPLIES, indices, backend, |index| {
        shelf_v22::total_counters(address, index)
    });
    let Some(total) = response.as_ref().and_then(shelf_v22::parse_totalizer) else {
        return false;
    };
    let nozzle_index = fp
        .nozzles
        .iter()
        .find(|n| n.active)
        .map(|n| n.index)
        .unwrap_or(1);
    let volume = total.volume_steps as f64 / shelf_v22::VOLUME_STEPS_PER_CUBIC_METRE;
    let mut map = runtimes.write().await;
    if let Some(rt) = map.get_mut(&address) {
        rt.state.pump_total_nozzle_index = Some(nozzle_index);
        rt.state.pump_total_volume = Some(volume);
        rt.state.pump_totals = vec![PumpNozzleTotals {
            nozzle_index,
            volume,
            amount: 0,
            price: 0,
        }];
    }
    true
}

async fn apply_command(
    cfg: &SiteConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    indices: &mut HashMap<u8, u8>,
    command: DispatchCommand,
) {
    match command {
        DispatchCommand::ReloadConfig { .. } => {}
        DispatchCommand::Authorize {
            byte,
            price,
            preset,
        } => {
            authorize(
                cfg, backend, runtimes, events, indices, byte, price, preset, None,
            )
            .await;
        }
        DispatchCommand::Preauthorize {
            byte,
            price,
            preset,
            nozzle_index,
        } => {
            authorize(
                cfg,
                backend,
                runtimes,
                events,
                indices,
                byte,
                price,
                preset,
                Some(nozzle_index),
            )
            .await;
        }
        DispatchCommand::Stop { byte } => {
            // Every SHELF stop is terminal: the dispenser finishes the fill
            // and reports a final MAR, which closes the sale durably. There
            // is no pause and no resume.
            let response = exchange(byte, COMMAND_REPLIES, indices, backend, |index| {
                shelf_v22::stop(byte, index)
            });
            if response.as_ref().is_some_and(command_ok) {
                let stopped = {
                    let mut map = runtimes.write().await;
                    map.get_mut(&byte).map(|rt| {
                        let volume = rt.state.volume;
                        let amount = rt.state.amount;
                        let tx_id = rt
                            .current_tx
                            .as_ref()
                            .map(|tx| tx.id.clone())
                            .unwrap_or_default();
                        rt.state.status = FpStatus::Stopped {
                            stopped_volume: volume,
                            stopped_amount: amount,
                            stopped_tx_id: tx_id.clone(),
                            stop_source: StopSource::AppFinal,
                        };
                        (volume, amount, tx_id)
                    })
                };
                if let Some((volume, amount, tx_id)) = stopped {
                    let _ = events.send(WsEvent::Paused {
                        fp_id: cfg
                            .position_by_address(byte)
                            .map(|fp| fp.id.clone())
                            .unwrap_or_default(),
                        stopped_volume: volume,
                        stopped_amount: amount,
                        stopped_tx_id: tx_id,
                        stop_source: "APP_FINAL".to_string(),
                    });
                }
                broadcast_status(byte, runtimes, events).await;
            }
        }
        DispatchCommand::EStop => {
            for address in cfg.active_addresses() {
                let _ = exchange(address, COMMAND_REPLIES, indices, backend, |index| {
                    shelf_v22::stop(address, index)
                });
            }
            warn!("SHELF emergency stop sent to all configured guns");
        }
        DispatchCommand::CancelPreauth { byte } => {
            let _ = exchange(byte, COMMAND_REPLIES, indices, backend, |index| {
                shelf_v22::stop(byte, index)
            });
            let mut map = runtimes.write().await;
            if let Some(rt) = map.get_mut(&byte) {
                rt.cancel_pre_auth();
            }
            drop(map);
            if let Some(fp) = cfg.position_by_address(byte) {
                let _ = events.send(WsEvent::PreAuthCancelled {
                    fp_id: fp.id.clone(),
                });
            }
            broadcast_status(byte, runtimes, events).await;
        }
        DispatchCommand::ResetLane { byte } => {
            if let Some(fp) = cfg.position_by_address(byte) {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    rt.reset_for_operator(fp);
                }
                drop(map);
                broadcast_status(byte, runtimes, events).await;
            }
        }
        DispatchCommand::ResetAll => {
            for fp in cfg.active_positions() {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&fp.address_byte) {
                    rt.reset_for_operator(fp);
                }
                drop(map);
                broadcast_status(fp.address_byte, runtimes, events).await;
            }
        }
        DispatchCommand::UpdatePrices {
            updates,
            changed_by,
        } => {
            for update in updates {
                let Some(fp) = cfg.position_by_id(&update.fp_id) else {
                    continue;
                };
                let address = fp.address_byte;
                let wire_written = if update.price > 0 && update.price <= shelf_v22::MAX_PRICE {
                    exchange(address, COMMAND_REPLIES, indices, backend, |index| {
                        shelf_v22::write_price(address, index, update.price)
                            .expect("validated SHELF price")
                    })
                    .as_ref()
                    .is_some_and(command_ok)
                } else {
                    false
                };
                if !wire_written {
                    warn!(
                        address,
                        price = update.price,
                        "SHELF price was cached but not accepted on wire"
                    );
                }
                let product_name = fp
                    .nozzles
                    .iter()
                    .find(|n| n.index == update.nozzle_index)
                    .and_then(|n| cfg.product(n.product_id))
                    .map(|p| p.name.clone())
                    .unwrap_or_default();
                let old = {
                    let mut map = runtimes.write().await;
                    map.get_mut(&address)
                        .map(|rt| rt.set_nozzle_price(update.nozzle_index, update.price))
                };
                if let Some(old_price) = old {
                    let _ = events.send(WsEvent::PriceUpdated {
                        fp_id: update.fp_id,
                        nozzle_index: update.nozzle_index,
                        product_name,
                        old_price,
                        new_price: update.price,
                        changed_by: changed_by.clone(),
                    });
                }
                broadcast_status(address, runtimes, events).await;
            }
        }
        DispatchCommand::RefreshTotals => {
            for fp in cfg.active_positions() {
                let _ = sync_totalizer(fp.address_byte, fp, backend, runtimes, indices).await;
                broadcast_status(fp.address_byte, runtimes, events).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn exchange_retries_with_same_index_and_advances_after_valid_reply() {
        let reply = shelf_v22::build_request(0x0F, 7, 0x81, &[0x00, 0x20]).unwrap();
        let fake = Arc::new(Mutex::new(super::super::shared::FakeSerial::new([
            Vec::new(),
            reply,
        ])));
        let backend = SerialBackend::Fake(fake.clone());
        let mut indices = HashMap::from([(0x0F, 7)]);
        let response = exchange(0x0F, STATUS_REPLIES, &mut indices, &backend, |index| {
            shelf_v22::status(0x0F, index)
        })
        .unwrap();
        assert_eq!(response.command, 0x81);
        assert_eq!(indices[&0x0F], 8);
        let guard = fake.lock().unwrap();
        assert_eq!(guard.written().len(), 2);
        assert_eq!(guard.written()[0], guard.written()[1]);
    }

    #[test]
    fn volume_preset_uses_hundredths_of_a_cubic_metre() {
        let frame = dose_frame(0x0F, 1, &Preset::Volume(12.34), 162).unwrap();
        assert_eq!(&frame[7..10], &[0xD2, 0x04, 0x00]);
    }

    #[test]
    fn shipped_shelf_config_is_valid() {
        let cfg: SiteConfig = serde_json::from_str(include_str!("../../../site.config.shelf.json"))
            .expect("parse shipped SHELF config");
        cfg.validate().expect("validate shipped SHELF config");
        assert_eq!(cfg.connection.protocol, site_config::Protocol::ShelfV22);
    }
}
