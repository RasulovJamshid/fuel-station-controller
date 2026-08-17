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
    preset_metadata, write_serial, SerialBackend,
};
use crate::engine::poll_loop::DispatchCommand;
use crate::engine::state::{CurrentTx, PreAuthContext, RuntimeFp};
use crate::shifts::ShiftCoordinator;

const GBR_RESET_CLOSE_RETRIES: usize = 5;
const GBR_RESET_CLOSE_RETRY_DELAY_MS: u64 = 750;

// ── Gilbarco Two-Wire Protocol (TWOTP-IS-1.0-S) poll loop ────────────────────

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
                    mark_missed(
                        byte,
                        fp_cfg,
                        cfg.polling.offline_threshold_polls,
                        &runtimes,
                        &events,
                    )
                    .await;
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
                    mark_missed(
                        byte,
                        fp_cfg,
                        cfg.polling.offline_threshold_polls,
                        &runtimes,
                        &events,
                    )
                    .await;
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
