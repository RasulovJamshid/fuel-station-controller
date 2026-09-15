//! SHELF protocol V2.2 runtime for gas and liquid-fuel dispensers.
//!
//! Each configured fueling position is a side containing addressed SHELF guns. Wire
//! framing and parsing live in `shelf-v22`; this module owns polling, packet
//! indices, commands, runtime state and durable transaction close.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use site_config::{FuelingPositionConfig, SiteConfig};
use sqlx::SqlitePool;
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing::{debug, info, warn};
use types::{FpStatus, Preset, PumpNozzleTotals, Transaction, TxStatus, WsEvent};

use super::shared::{
    active_positions_by_byte, broadcast_status, commit_sale, exchange_serial, mark_missed,
    preset_metadata, SerialBackend,
};
use crate::engine::poll_loop::DispatchCommand;
use crate::engine::state::{CurrentTx, PreAuthContext, RuntimeFp};
use crate::shifts::ShiftCoordinator;

const EXCHANGE_RETRIES: usize = 20;
// Operator-selected full-fill ceiling, converted down to hundredths of volume.
const FULL_FILL_AMOUNT_LIMIT: u32 = 999_999;
const STATUS_REPLIES: &[u8] = &[0x81, 0x82, 0x83, 0x84, 0x85, 0x93, 0xFF];
const COMMAND_REPLIES: &[u8] = &[0x00, 0x84, 0xFF];
const STOP_REPLIES: &[u8] = &[0x00, 0x81, 0x84, 0x85, 0x93, 0xFF];
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
    let mut indices: HashMap<u8, u8> = wire_addresses(&cfg).into_iter().map(|a| (a, 0)).collect();
    let mut interval = poll_interval(&cfg);
    let mut pending_totals: HashMap<u8, Instant> = wire_addresses(&cfg)
        .into_iter()
        .map(|address| (address, Instant::now()))
        .collect();

    info!(?addresses, "SHELF V2.2 poll loop started");
    sync_configured_prices(&cfg, &backend, &mut indices);

    'poll_loop: loop {
        while let Ok(command) = commands.try_recv() {
            if let DispatchCommand::ReloadConfig { cfg: next } = command {
                cfg = next;
                pending_totals = wire_addresses(&cfg)
                    .into_iter()
                    .map(|a| (a, Instant::now()))
                    .collect();
                disp_by_byte = active_positions_by_byte(&cfg);
                addresses = cfg.active_addresses();
                indices.retain(|address, _| wire_addresses(&cfg).contains(address));
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
                    pending_totals = wire_addresses(&cfg)
                        .into_iter()
                        .map(|a| (a, Instant::now()))
                        .collect();
                    disp_by_byte = active_positions_by_byte(&cfg);
                    addresses = cfg.active_addresses();
                    indices.retain(|address, _| wire_addresses(&cfg).contains(address));
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
            poll_side(
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
            refresh_pending_totalizer(
                fp,
                &backend,
                &runtimes,
                &events,
                &mut indices,
                &mut pending_totals,
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

async fn can_read_side_totals(byte: u8, runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>) -> bool {
    runtimes.read().await.get(&byte).is_some_and(|rt| {
        matches!(
            rt.state.status,
            FpStatus::Idle | FpStatus::NozzleUp | FpStatus::Done
        ) && rt.pre_auth.is_none()
            && rt.current_tx.is_none()
            && !rt.shelf.start_attempted
            && !rt.shelf.cancel_requested
            && rt.shelf.final_sale.is_none()
    })
}

// Read one pending gun per side per rotation, allowing commands between sides.
// §20 forbids totalizer reads during delivery; failures remain pending for retry.
async fn refresh_pending_totalizer(
    fp: &FuelingPositionConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    indices: &mut HashMap<u8, u8>,
    pending: &mut HashMap<u8, Instant>,
) {
    if !can_read_side_totals(fp.address_byte, runtimes).await {
        return;
    }
    let now = Instant::now();
    for nozzle in fp.nozzles.iter().filter(|n| n.active) {
        let gun = gun_position(fp, Some(nozzle.index)).expect("active gun");
        let address = gun_address(&gun);
        if !pending.get(&address).is_some_and(|due| *due <= now) {
            continue;
        }
        if sync_totalizer(address, &gun, backend, runtimes, indices).await {
            pending.remove(&address);
            broadcast_status(fp.address_byte, runtimes, events).await;
        } else {
            pending.insert(address, now + Duration::from_secs(2));
        }
        break;
    }
}

// A single-gun view retains the side identity while selecting wire metadata.
fn gun_position(fp: &FuelingPositionConfig, index: Option<u8>) -> Option<FuelingPositionConfig> {
    let nozzle = fp
        .nozzles
        .iter()
        .find(|n| n.active && index.is_none_or(|i| n.index == i))?;
    let mut gun = fp.clone();
    gun.nozzles = vec![nozzle.clone()];
    Some(gun)
}

fn gun_address(fp: &FuelingPositionConfig) -> u8 {
    fp.nozzles
        .iter()
        .find(|n| n.active)
        .map(|n| n.shelf_address)
        .filter(|&address| address != 0)
        .unwrap_or(fp.address_byte)
}

fn wire_addresses(cfg: &SiteConfig) -> Vec<u8> {
    cfg.active_positions()
        .iter()
        .flat_map(|fp| {
            fp.nozzles
                .iter()
                .filter(|n| n.active)
                .filter_map(|n| gun_position(fp, Some(n.index)))
                .map(|gun| gun_address(&gun))
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
async fn poll_side(
    byte: u8,
    fp: &FuelingPositionConfig,
    cfg: &SiteConfig,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
    indices: &mut HashMap<u8, u8>,
) {
    let selected = runtimes
        .read()
        .await
        .get(&byte)
        .and_then(|rt| rt.state.nozzle_index);
    for nozzle in fp
        .nozzles
        .iter()
        .filter(|n| n.active && selected.is_none_or(|i| n.index == i))
    {
        let Some(gun) = gun_position(fp, Some(nozzle.index)) else {
            continue;
        };
        poll_position(
            gun_address(&gun),
            &gun,
            cfg,
            backend,
            runtimes,
            events,
            pool,
            shifts,
            indices,
        )
        .await;
        // An idle sibling must never clear a selected nozzle, reservation or sale.
        let map = runtimes.read().await;
        if map.get(&byte).is_some_and(|rt| {
            rt.state.nozzle_index.is_some() || rt.pre_auth.is_some() || rt.current_tx.is_some()
        }) {
            break;
        }
    }
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
    let byte = fp.address_byte;
    if expire_reservation(byte, cfg, runtimes, events).await {
        broadcast_status(byte, runtimes, events).await;
        return;
    }
    let cached_final = runtimes
        .read()
        .await
        .get(&byte)
        .and_then(|rt| rt.shelf.final_sale);
    if let Some(final_sale) = cached_final {
        if close_transaction(address, fp, cfg, final_sale, runtimes, events, pool, shifts).await {
            let _ = sync_totalizer(address, fp, backend, runtimes, indices).await;
        }
        broadcast_status(byte, runtimes, events).await;
        return;
    }
    let response = exchange(address, STATUS_REPLIES, indices, backend, |index| {
        shelf_v22::status(address, index)
    });
    let Some(response) = response else {
        mark_missed(
            byte,
            fp,
            cfg.polling.offline_threshold_polls,
            runtimes,
            events,
        )
        .await;
        send_pending_stop(byte, backend, runtimes, indices).await;
        broadcast_status(byte, runtimes, events).await;
        return;
    };

    {
        let mut map = runtimes.write().await;
        if let Some(rt) = map.get_mut(&byte) {
            rt.on_poll_success();
        }
    }

    if let Some(final_sale) = shelf_v22::parse_final_sale(&response) {
        {
            let mut map = runtimes.write().await;
            if let Some(rt) = map.get_mut(&byte) {
                if rt.state.status == FpStatus::Done && rt.current_tx.is_none() {
                    return;
                }
                // A recovered sale may have no live transaction yet. Pin its
                // gun so a database retry cannot attach it to an idle sibling.
                rt.shelf.wire_address = Some(address);
                rt.state.nozzle_index = fp.nozzles.iter().find(|n| n.active).map(|n| n.index);
                rt.state.status = FpStatus::Finalizing;
                rt.shelf.final_sale = Some(final_sale);
            }
        }
        if close_transaction(address, fp, cfg, final_sale, runtimes, events, pool, shifts).await {
            // Appendix 1 recommends a total-counter read immediately after MAR.
            let _ = sync_totalizer(address, fp, backend, runtimes, indices).await;
            broadcast_status(byte, runtimes, events).await;
        }
        return;
    }

    let Some(status) = shelf_v22::parse_live_status(&response) else {
        debug!(
            address,
            command = response.command,
            "SHELF: unhandled status response"
        );
        send_pending_stop(byte, backend, runtimes, indices).await;
        broadcast_status(byte, runtimes, events).await;
        return;
    };

    if status.describes_other_gun(address) {
        // A shared controller returns 0x85 throughout another gun's delivery.
        // It is neither this gun's meter nor an end-of-fill handshake for it.
        // Keep its own transaction/preauth state until its own status arrives.
        broadcast_status(byte, runtimes, events).await;
        return;
    }
    let gun_number = fp
        .nozzles
        .iter()
        .find(|n| n.active)
        .map(|n| n.index)
        .unwrap_or(1);

    match status.state {
        shelf_v22::ShelfState::Dispensing => {
            let unstarted_reservation = {
                let map = runtimes.read().await;
                map.get(&byte)
                    .is_some_and(|rt| rt.pre_auth.is_some() && !rt.shelf.start_attempted)
            };
            if status.paused() || status.stopped() {
                // Pause/resume is unsupported: a fill interrupted on the
                // dispenser side is terminated so it reports a final MAR and
                // the sale closes durably.
                warn!(
                    address,
                    "SHELF fill reported paused/stopped; sending terminal stop"
                );
                update_live(address, fp, cfg, status, runtimes).await;
                request_cancel(byte, backend, runtimes, events, indices).await;
            } else if unstarted_reservation {
                // Another controller/keypad armed this gun before our start.
                // Adopt its readings and stop it; never overwrite it with our dose.
                update_live(address, fp, cfg, status, runtimes).await;
                request_cancel(byte, backend, runtimes, events, indices).await;
            } else if !status.gun_lifted(gun_number)
                && status.volume_steps.unwrap_or_default() == 0
                && has_pending_preauth(byte, runtimes).await
            {
                // The nozzle may have been reholstered after the fresh lift
                // check. Keep the sent order Authorizing until movement/lift.
            } else {
                update_live(address, fp, cfg, status, runtimes).await;
            }
            // Keep the documented gas watchdog exchange. The liquid-fuel
            // capture completes by polling status alone, without pressure.
            if !is_liquid_position(fp, cfg) {
                let _ = exchange(address, PRESSURE_REPLIES, indices, backend, |index| {
                    shelf_v22::pressure(address, index)
                });
            }
        }
        shelf_v22::ShelfState::Synchronizing => {
            // Only a reply describing this gun can be its end-of-fill handshake.
            // Shared-controller reports for another gun were filtered above.
            if let Some(steps) = status.volume_steps {
                update_meter(byte, steps, runtimes).await;
            }
        }
        shelf_v22::ShelfState::Idle => {
            let (reservation, has_transaction, cancel_requested) = {
                let map = runtimes.read().await;
                let Some(rt) = map.get(&byte) else { return };
                (
                    rt.pre_auth
                        .as_ref()
                        .filter(|_| !rt.shelf.start_attempted && rt.current_tx.is_none())
                        .map(|_| {
                            (
                                rt.shelf.order_price.unwrap_or(rt.state.price),
                                rt.last_preset.clone(),
                            )
                        }),
                    rt.current_tx.is_some(),
                    rt.shelf.cancel_requested,
                )
            };
            if let Some((price, preset)) = reservation {
                if status.gun_lifted(gun_number) && !cancel_requested {
                    // Check expiry again after the serial exchange, before start.
                    if !expire_reservation(byte, cfg, runtimes, events).await {
                        authorize(
                            cfg,
                            backend,
                            runtimes,
                            events,
                            indices,
                            byte,
                            price,
                            preset,
                            Some(gun_number),
                        )
                        .await;
                    }
                }
            } else if status.gun_lifted(gun_number) && !has_transaction {
                emit_nozzle_up(address, fp, cfg, runtimes, events).await;
            } else {
                let has_transaction = {
                    let map = runtimes.read().await;
                    map.get(&byte).is_some_and(|rt| rt.current_tx.is_some())
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
                            if let Some(rt) = runtimes.write().await.get_mut(&byte) {
                                rt.shelf.final_sale = Some(final_sale);
                            }
                            if close_transaction(
                                address, fp, cfg, final_sale, runtimes, events, pool, shifts,
                            )
                            .await
                            {
                                let _ =
                                    sync_totalizer(address, fp, backend, runtimes, indices).await;
                                broadcast_status(byte, runtimes, events).await;
                            }
                            return;
                        }
                    }
                } else {
                    idle_lane(byte, runtimes).await;
                }
            }
        }
        shelf_v22::ShelfState::KeypadActive | shelf_v22::ShelfState::KeypadRequest => {
            emit_nozzle_up(address, fp, cfg, runtimes, events).await;
        }
        _ => {}
    }

    send_pending_stop(byte, backend, runtimes, indices).await;
    broadcast_status(byte, runtimes, events).await;
}

async fn has_pending_preauth(address: u8, runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>) -> bool {
    let map = runtimes.read().await;
    map.get(&address).is_some_and(|rt| rt.pre_auth.is_some())
}

async fn reserve(
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    address: u8,
    price: u32,
    preset: Preset,
    requested_nozzle: Option<u8>,
) {
    let Some(fp) = cfg.position_by_address(address) else {
        return;
    };
    let selected = requested_nozzle.or(runtimes
        .read()
        .await
        .get(&address)
        .and_then(|rt| rt.state.nozzle_index));
    let Some(fp) = gun_position(fp, selected) else {
        return;
    };
    let wire_address = gun_address(&fp);
    let Some((nozzle_index, product_id, product_name, product_color, _)) = primary_nozzle(&fp, cfg)
    else {
        return;
    };
    if requested_nozzle.is_some_and(|n| n != nozzle_index)
        || price == 0
        || price > shelf_v22::MAX_PRICE
        || dose_frame(address, 0, &preset, price, is_liquid_position(&fp, cfg)).is_err()
    {
        return;
    }
    let mut map = runtimes.write().await;
    let Some(rt) = map.get_mut(&address) else {
        return;
    };
    if !matches!(rt.state.status, FpStatus::Idle | FpStatus::NozzleUp)
        || rt.pre_auth.is_some()
        || rt.current_tx.is_some()
        || rt.shelf.start_attempted
        || rt.shelf.cancel_requested
        || rt.shelf.final_sale.is_some()
    {
        return;
    }
    rt.shelf = Default::default();
    rt.shelf.order_price = Some(price);
    rt.shelf.wire_address = Some(wire_address);
    rt.state.status = FpStatus::PreAuthorized;
    rt.state.nozzle_index = Some(nozzle_index);
    rt.state.product_id = Some(product_id);
    rt.state.product_name = Some(product_name);
    rt.state.product_color = Some(product_color);
    rt.state.price = price;
    rt.state.volume = 0.0;
    rt.state.amount = 0;
    rt.state.pre_auth_preset = Some(shelf_preset_label(&preset, position_unit(&fp, cfg)));
    rt.set_last_preset(preset);
    rt.pre_auth = Some(PreAuthContext {
        nozzle_index,
        product_id,
    });
    rt.pre_auth_started_at = Some(Utc::now().timestamp_millis());
    drop(map);
    info!(
        address,
        "SHELF software reservation created; waiting for selected nozzle"
    );
    broadcast_status(address, runtimes, events).await;
}

async fn expire_reservation(
    address: u8,
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
) -> bool {
    let mut map = runtimes.write().await;
    let Some(rt) = map.get_mut(&address) else {
        return false;
    };
    if cfg.ui.preauth_timeout_seconds == 0
        || rt.pre_auth.is_none()
        || rt.shelf.start_attempted
        || rt.current_tx.is_some()
        || rt.shelf.cancel_requested
        || !rt.pre_auth_started_at.is_some_and(|start| {
            Utc::now().timestamp_millis().saturating_sub(start).max(0) as u64
                >= cfg.ui.preauth_timeout_seconds.saturating_mul(1000)
        })
    {
        return false;
    }
    rt.cancel_pre_auth();
    rt.shelf = Default::default();
    let _ = events.send(WsEvent::PreAuthTimeout {
        fp_id: rt.state.fp_id.clone(),
    });
    true
}

async fn request_cancel(
    address: u8,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
    indices: &mut HashMap<u8, u8>,
) {
    let mut map = runtimes.write().await;
    let Some(rt) = map.get_mut(&address) else {
        return;
    };
    rt.shelf.cancel_requested = false; // the queued operator command is now consumed
    if !rt.shelf.start_attempted && rt.current_tx.is_none() {
        if rt.pre_auth.is_some() {
            rt.cancel_pre_auth();
            rt.shelf = Default::default();
            let _ = events.send(WsEvent::PreAuthCancelled {
                fp_id: rt.state.fp_id.clone(),
            });
        }
    } else {
        rt.shelf.stop_requested = true;
        rt.pre_auth_started_at = None;
        rt.state.status = FpStatus::Finalizing;
    }
    drop(map);
    send_pending_stop(address, backend, runtimes, indices).await;
    broadcast_status(address, runtimes, events).await;
}

async fn send_pending_stop(
    address: u8,
    backend: &SerialBackend,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    indices: &mut HashMap<u8, u8>,
) {
    let mut map = runtimes.write().await;
    let Some(rt) = map.get_mut(&address) else {
        return;
    };
    let now = Instant::now();
    if !rt.shelf.stop_requested
        || rt.shelf.final_sale.is_some()
        || rt.shelf.next_stop_attempt.is_some_and(|next| now < next)
    {
        return;
    }
    rt.shelf.next_stop_attempt = Some(now + Duration::from_millis(500));
    let wire_address = rt.shelf.wire_address.unwrap_or(address);
    drop(map);
    // A status/ACK is not a final meter confirmation; ownership stays intact.
    let response = exchange(wire_address, STOP_REPLIES, indices, backend, |index| {
        shelf_v22::stop(wire_address, index)
    });
    if let Some(final_sale) = response.as_ref().and_then(shelf_v22::parse_final_sale) {
        if let Some(rt) = runtimes.write().await.get_mut(&address) {
            rt.shelf.final_sale = Some(final_sale);
        }
    }
}

fn exchange(
    address: u8,
    expected_commands: &[u8],
    indices: &mut HashMap<u8, u8>,
    backend: &SerialBackend,
    build: impl Fn(u8) -> Vec<u8>,
) -> Option<shelf_v22::Response> {
    exchange_with_attempts(address, expected_commands, indices, backend, build).0
}

fn exchange_with_attempts(
    address: u8,
    expected_commands: &[u8],
    indices: &mut HashMap<u8, u8>,
    backend: &SerialBackend,
    build: impl Fn(u8) -> Vec<u8>,
) -> (Option<shelf_v22::Response>, usize) {
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
                return (Some(response), attempt + 1);
            }
        }
        debug!(
            address,
            index, attempt, "SHELF: no valid response, retrying same index"
        );
    }
    (None, EXCHANGE_RETRIES)
}

fn command_ok(response: &shelf_v22::Response) -> bool {
    response.command == 0x00 || response.command == 0x84
}

fn sync_configured_prices(
    cfg: &SiteConfig,
    backend: &SerialBackend,
    indices: &mut HashMap<u8, u8>,
) {
    for side in cfg.active_positions() {
        for n in side.nozzles.iter().filter(|n| n.active) {
            let fp = gun_position(side, Some(n.index)).expect("active gun");
            // Captured liquid-fuel authorization embeds the price in command 0x05.
            // Do not require a separate startup write for that flow.
            if is_liquid_position(&fp, cfg) {
                continue;
            }
            let Some(nozzle) = fp.nozzles.iter().find(|nozzle| nozzle.active) else {
                continue;
            };
            let address = gun_address(&fp);
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
}

fn position_unit<'a>(fp: &FuelingPositionConfig, cfg: &'a SiteConfig) -> &'a str {
    fp.nozzles
        .iter()
        .find(|n| n.active)
        .and_then(|n| cfg.product(n.product_id))
        .map(|product| product.unit.as_str())
        .unwrap_or("m³")
}

fn is_liquid_position(fp: &FuelingPositionConfig, cfg: &SiteConfig) -> bool {
    matches!(
        position_unit(fp, cfg).trim().to_lowercase().as_str(),
        "l" | "litre" | "liter" | "litres" | "liters" | "л" | "литр"
    )
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
        let Some(rt) = map.get_mut(&fp.address_byte) else {
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
            rt.shelf.wire_address = Some(address);
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
    let Some(rt) = map.get_mut(&fp.address_byte) else {
        return;
    };
    let price = rt.shelf.order_price.unwrap_or_else(|| {
        rt.nozzle_prices
            .get(&nozzle_index)
            .copied()
            .unwrap_or(configured_price)
    });
    let volume = status.volume_steps.unwrap_or(0) as f64 / shelf_v22::VOLUME_STEPS_PER_UNIT;
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
    rt.shelf.wire_address = Some(address);
    rt.state.status = if rt.shelf.stop_requested {
        FpStatus::Finalizing
    } else {
        FpStatus::Delivering
    };
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
        let volume = volume_steps as f64 / shelf_v22::VOLUME_STEPS_PER_UNIT;
        rt.state.volume = volume;
        rt.state.amount = (volume * rt.state.price as f64).round() as u64;
    }
}

async fn idle_lane(address: u8, runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>) {
    let mut map = runtimes.write().await;
    let Some(rt) = map.get_mut(&address) else {
        return;
    };
    if rt.pre_auth.is_some() || rt.current_tx.is_some() || rt.shelf.start_attempted {
        return;
    }
    // The idle poll reaches here after the selected nozzle is returned.
    // A committed sale may leave Done; its durable record is kept separately.
    if !matches!(rt.state.status, FpStatus::Stopped { .. }) {
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
        let Some(rt) = map.get(&fp.address_byte) else {
            return false;
        };
        (
            rt.current_tx.clone(),
            rt.continuation.clone(),
            rt.last_preset.clone(),
            rt.state.price,
        )
    };
    let volume = final_sale.volume_steps as f64 / shelf_v22::VOLUME_STEPS_PER_UNIT;
    if volume <= 0.0 && context.is_none() {
        if let Some(rt) = runtimes.write().await.get_mut(&fp.address_byte) {
            rt.shelf.final_sale = None;
        }
        idle_lane(fp.address_byte, runtimes).await;
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
    let preset_label = Some(shelf_preset_label(&preset, position_unit(fp, cfg)));
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
    if let Some(rt) = map.get_mut(&fp.address_byte) {
        rt.state.status = FpStatus::Done;
        rt.state.volume = volume;
        rt.state.amount = combined_amount;
        rt.state.price = price;
        rt.state.nozzle_index = Some(context.nozzle_index);
        rt.current_tx = None;
        rt.continuation = None;
        rt.pre_auth = None;
        rt.pre_auth_started_at = None;
        let cancel_requested = rt.shelf.cancel_requested;
        rt.shelf = Default::default();
        rt.shelf.cancel_requested = cancel_requested;
    }
    info!(
        address,
        volume,
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
    liquid: bool,
) -> Result<Vec<u8>, &'static str> {
    if liquid && matches!(preset,
        Preset::Volume(volume) if *volume < 2.0
    ) || liquid && matches!(preset,
        Preset::Amount(amount) if *amount < u64::from(price) * 2
    ) {
        return Err("SHELF petrol minimum dose is 2 litres");
    }
    match preset {
        Preset::Volume(volume) => {
            let steps = (volume * shelf_v22::VOLUME_STEPS_PER_UNIT).round() as u32;
            shelf_v22::write_volume(address, index, steps, price)
                .ok_or("SHELF volume/price is outside the wire range")
        }
        Preset::Amount(amount) => {
            let amount =
                u32::try_from(*amount).map_err(|_| "SHELF amount is outside the wire range")?;
            if liquid {
                if amount == 0 || amount > shelf_v22::MAX_DOSE || price == 0 {
                    return Err("SHELF amount/price is outside the wire range");
                }
                // Temporary petrol workaround: integer division floors the dose.
                // Keep the original money preset in runtime/history metadata.
                let steps = (u64::from(amount) * 100) / u64::from(price);
                let steps = u32::try_from(steps)
                    .map_err(|_| "SHELF converted volume is outside the wire range")?;
                shelf_v22::write_volume(address, index, steps, price)
                    .ok_or("SHELF converted volume/price is outside the wire range")
            } else {
                shelf_v22::write_money(address, index, amount)
                    .ok_or("SHELF amount is outside the wire range")
            }
        }
        Preset::Str(value) if value.eq_ignore_ascii_case("full") => {
            let by_amount = FULL_FILL_AMOUNT_LIMIT
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
    if !runtimes.read().await.get(&address).is_some_and(|rt| {
        rt.pre_auth.is_some()
            && !rt.shelf.start_attempted
            && !rt.shelf.cancel_requested
            && rt.current_tx.is_none()
    }) {
        return;
    }
    let Some(fp) = cfg.position_by_address(address) else {
        return;
    };
    let selected = requested_nozzle.or(runtimes
        .read()
        .await
        .get(&address)
        .and_then(|rt| rt.state.nozzle_index));
    let Some(fp) = gun_position(fp, selected) else {
        return;
    };
    let wire_address = gun_address(&fp);
    let Some((nozzle_index, product_id, product_name, _, _)) = primary_nozzle(&fp, cfg) else {
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
        warn!(address, price, "SHELF authorize price outside 1..=65535");
        return;
    }
    if let Err(error) = dose_frame(address, 0, &preset, price, is_liquid_position(&fp, cfg)) {
        warn!(
            address,
            ?preset,
            error,
            "SHELF dose rejected before wire send"
        );
        return;
    }
    // Every liquid preset now uses priced Write Volume, including money requests.
    // Gas keeps its existing separate price exchange and native money command.
    if !is_liquid_position(&fp, cfg) {
        let price_response = exchange(wire_address, COMMAND_REPLIES, indices, backend, |index| {
            shelf_v22::write_price(wire_address, index, price).expect("validated SHELF price")
        });
        if !price_response.as_ref().is_some_and(command_ok) {
            warn!(address, "SHELF price write rejected; authorization aborted");
            request_cancel(address, backend, runtimes, events, indices).await;
            return;
        }
    }
    {
        let mut map = runtimes.write().await;
        let Some(rt) = map.get_mut(&address) else {
            return;
        };
        // This is the point after which a lost reply cannot be cancelled locally.
        if rt.pre_auth.is_none() || rt.shelf.start_attempted || rt.shelf.cancel_requested {
            return;
        }
        rt.shelf.start_attempted = true;
        rt.shelf.wire_address = Some(wire_address);
        rt.shelf.order_price = Some(price);
        rt.state.price = price;
        rt.state.status = FpStatus::Authorizing;
        rt.pre_auth_started_at = None;
        rt.current_tx = Some(CurrentTx {
            id: uuid::Uuid::new_v4().to_string(),
            started_at: Utc::now().timestamp_millis(),
            product_id,
            product_name,
            nozzle_index,
        });
    }
    let (response, attempts) = exchange_with_attempts(wire_address, COMMAND_REPLIES, indices, backend, |index| {
        dose_frame(wire_address, index, &preset, price, is_liquid_position(&fp, cfg)).expect("SHELF dose was prevalidated")
    });
    if attempts == 1 && response.as_ref().is_some_and(|r| r.command == 0xFF) {
        // A direct refusal is not a lost acknowledgement. No sale started, so
        // querying AmountInfo here would import the dispenser's previous sale.
        warn!(address, "SHELF authorization explicitly rejected; clearing unsent sale");
        if let Some(rt) = runtimes.write().await.get_mut(&address) {
            rt.cancel_pre_auth();
            rt.shelf = Default::default();
            let _ = events.send(WsEvent::PreAuthCancelled {
                fp_id: rt.state.fp_id.clone(),
            });
        }
    } else if !response.as_ref().is_some_and(command_ok) {
        // A retry may follow an accepted start whose acknowledgement was lost.
        warn!(
            address,
            "SHELF start unconfirmed; stopping without discarding sale ownership"
        );
        request_cancel(address, backend, runtimes, events, indices).await;
    }
    broadcast_status(address, runtimes, events).await;
}

fn shelf_preset_label(preset: &Preset, unit: &str) -> String {
    match preset {
        Preset::Str(value) if value.eq_ignore_ascii_case("full") => "Full tank".into(),
        Preset::Volume(volume) => format!("{volume:.2} {unit}"),
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
    let volume = total.volume_steps as f64 / shelf_v22::VOLUME_STEPS_PER_UNIT;
    let mut map = runtimes.write().await;
    if let Some(rt) = map.get_mut(&fp.address_byte) {
        rt.state.pump_total_nozzle_index = Some(nozzle_index);
        rt.state.pump_total_volume = Some(volume);
        rt.state
            .pump_totals
            .retain(|total| total.nozzle_index != nozzle_index);
        rt.state.pump_totals.push(PumpNozzleTotals {
            nozzle_index,
            volume,
            amount: 0,
            price: 0,
        });
        rt.state.pump_totals.sort_by_key(|total| total.nozzle_index);
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
            reserve(cfg, runtimes, events, byte, price, preset, None).await;
        }
        DispatchCommand::Preauthorize {
            byte,
            price,
            preset,
            nozzle_index,
        } => {
            reserve(
                cfg,
                runtimes,
                events,
                byte,
                price,
                preset,
                Some(nozzle_index),
            )
            .await;
        }
        DispatchCommand::Stop { byte } | DispatchCommand::CancelPreauth { byte } => {
            request_cancel(byte, backend, runtimes, events, indices).await;
        }
        DispatchCommand::EStop => {
            for fp in cfg.active_positions() {
                let active_address = runtimes
                    .read()
                    .await
                    .get(&fp.address_byte)
                    .filter(|rt| rt.shelf.start_attempted || rt.current_tx.is_some())
                    .and_then(|rt| rt.shelf.wire_address);
                request_cancel(fp.address_byte, backend, runtimes, events, indices).await;
                // Cover every gun, including physical fills not yet seen by polling.
                for nozzle in fp.nozzles.iter().filter(|n| n.active) {
                    let gun = gun_position(fp, Some(nozzle.index)).expect("active gun");
                    let address = gun_address(&gun);
                    if Some(address) != active_address {
                        let _ = exchange(address, STOP_REPLIES, indices, backend, |index| {
                            shelf_v22::stop(address, index)
                        });
                    }
                }
            }
        }
        DispatchCommand::ResetLane { byte } => {
            if let Some(fp) = cfg.position_by_address(byte) {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&byte) {
                    if rt.pre_auth.is_none()
                        && rt.current_tx.is_none()
                        && !rt.shelf.start_attempted
                        && !rt.shelf.cancel_requested
                        && rt.shelf.final_sale.is_none()
                    {
                        rt.reset_for_operator(fp);
                        rt.shelf = Default::default();
                    }
                }
                drop(map);
                broadcast_status(byte, runtimes, events).await;
            }
        }
        DispatchCommand::ResetAll => {
            for fp in cfg.active_positions() {
                let mut map = runtimes.write().await;
                if let Some(rt) = map.get_mut(&fp.address_byte) {
                    if rt.pre_auth.is_none()
                        && rt.current_tx.is_none()
                        && !rt.shelf.start_attempted
                        && !rt.shelf.cancel_requested
                        && rt.shelf.final_sale.is_none()
                    {
                        rt.reset_for_operator(fp);
                        rt.shelf = Default::default();
                    }
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
                let Some(gun) = gun_position(fp, Some(update.nozzle_index)) else {
                    continue;
                };
                let address = gun_address(&gun);
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
                    map.get_mut(&fp.address_byte)
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
                broadcast_status(fp.address_byte, runtimes, events).await;
            }
        }
        DispatchCommand::RefreshTotals => {
            for fp in cfg.active_positions() {
                if !can_read_side_totals(fp.address_byte, runtimes).await {
                    continue;
                }
                for nozzle in fp.nozzles.iter().filter(|n| n.active) {
                    let gun = gun_position(fp, Some(nozzle.index)).expect("active gun");
                    let _ =
                        sync_totalizer(gun_address(&gun), &gun, backend, runtimes, indices).await;
                }
                broadcast_status(fp.address_byte, runtimes, events).await;
            }
        }
    }
}

#[cfg(test)]
#[path = "shelf_tests.rs"]
mod replay_tests;

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
        let frame = dose_frame(0x0F, 1, &Preset::Volume(12.34), 162, false).unwrap();
        assert_eq!(&frame[7..10], &[0xD2, 0x04, 0x00]);
    }

    #[test]
    fn petrol_money_conversion_floors_and_rejects_unrepresentable_doses() {
        for price in [11600, 17000, 16000] {
            for amount in [40000, 100000, 999999] {
                let frame = dose_frame(26, 1, &Preset::Amount(amount), price, true).unwrap();
                assert_eq!(frame[4], 0x05);
                let steps = u32::from_le_bytes([frame[7], frame[8], frame[9], 0]);
                assert!(u64::from(steps) * u64::from(price) <= amount * 100);
                assert!(u64::from(steps + 1) * u64::from(price) > amount * 100);
                assert_eq!(u16::from_le_bytes([frame[10], frame[11]]) as u32, price);
            }
        }
        for (amount, price) in [(0, 11600), (100, 11600), (20000, 0), (1000000, 11600), (999999, 1)] {
            assert!(dose_frame(26, 1, &Preset::Amount(amount), price, true).is_err());
        }
        assert_eq!(
            dose_frame(26, 1, &Preset::Amount(20000), 11600, false).unwrap(),
            shelf_v22::write_money(26, 1, 20000).unwrap()
        );
    }

    #[test]
    fn full_fill_stays_within_selected_money_ceiling_at_petrol_prices() {
        for (price, expected_steps) in [(17000, 5882), (11600, 8620), (16000, 6249)] {
            let frame = dose_frame(21, 1, &Preset::Str("full".into()), price, true).unwrap();
            assert_eq!(frame[4], 0x05);
            let steps = u32::from_le_bytes([frame[7], frame[8], frame[9], 0]);
            assert_eq!(steps, expected_steps);
            assert_eq!(u16::from_le_bytes([frame[10], frame[11]]) as u32, price);
            assert!(steps * price <= 999_999 * 100);
            assert!((steps + 1) * price > 999_999 * 100);
        }
    }

    #[test]
    fn shipped_shelf_config_is_valid() {
        for source in [
            include_str!("../../../site.config.shelf.json"),
            include_str!("../../../site.config.shelf-petrol.json"),
        ] {
            let cfg: SiteConfig = serde_json::from_str(source).expect("parse shipped SHELF config");
            cfg.validate().expect("validate shipped SHELF config");
            assert_eq!(cfg.connection.protocol, site_config::Protocol::ShelfV22);
        }
    }
}
