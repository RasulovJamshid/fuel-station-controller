//! ATG (Automatic Tank Gauge) Modbus TCP polling and integration posting.
//!
//! After each successful poll the task:
//! 1. Updates the shared `TankLevels` map (product_id keyed).
//! 2. Broadcasts a `WsEvent::TankUpdated` with a full `TankSnapshot` slice so
//!    the dispenser-service can push real data to all connected clients.
//! 3. POSTs integration payloads to the configured external API.

mod integration;
mod modbus;
mod poster;

pub use site_config::{AtgAuth, AtgBranch, AtgConfig, AtgSlot};

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{broadcast, RwLock};
use tracing::{info, warn};

use site_config::SiteConfig;
use types::{TankLiveLevel, TankSnapshot, WsEvent};

/// Shared live-level store: product_id → `TankLiveLevel`.
/// Pass the same `Arc` to `AppState` so the HTTP snapshot can overlay live data.
pub type TankLevels = Arc<RwLock<HashMap<u8, TankLiveLevel>>>;

// ── Slot field indices (6 floats per slot, in Modbus register order) ──────
const IDX_PRODUCT_HEIGHT: usize = 0;
const IDX_TEMPERATURE: usize = 2;
// 3 = product_and_water_volume
const IDX_PRODUCT_VOLUME: usize = 4;
const IDX_WATER_VOLUME: usize = 5;

/// Extract the live fields we care about for one 1-based slot from the float slice.
/// Returns `None` if the slot is out of range or the reading looks invalid.
fn read_slot(floats: &[f32], slot_1based: u8) -> Option<(f64, f64, f64, f64)> {
    let base = ((slot_1based - 1) as usize) * 6;
    if base + 5 >= floats.len() {
        return None;
    }
    let current_l = floats[base + IDX_PRODUCT_VOLUME] as f64;
    if current_l <= 0.0 {
        return None; // bad Modbus read
    }
    let temperature_c = floats[base + IDX_TEMPERATURE] as f64;
    let water_l = floats[base + IDX_WATER_VOLUME] as f64;
    let product_height = floats[base + IDX_PRODUCT_HEIGHT] as f64;
    let _ = (water_l, product_height); // may be used in future metrics
    Some((current_l, temperature_c, water_l, product_height))
}

/// Run the ATG polling loop indefinitely. Call from `tokio::spawn`.
pub async fn run(
    cfg: Arc<RwLock<SiteConfig>>,
    tank_levels: TankLevels,
    events: broadcast::Sender<WsEvent>,
) {
    loop {
        let current = {
            let cfg = cfg.read().await;
            cfg.atg.clone().map(|atg| (atg, cfg.tanks.clone()))
        };
        let Some((atg_cfg, tank_configs)) = current else {
            warn!("ATG: config disabled — sleeping");
            tokio::time::sleep(Duration::from_secs(300)).await;
            continue;
        };

        if atg_cfg.branches.is_empty() {
            warn!("ATG: no branches configured — task will do nothing");
        }
        if atg_cfg.api_url.is_empty() {
            warn!("ATG: api_url not set — payloads built but not POSTed");
        }

        let interval = Duration::from_secs(atg_cfg.poll_interval_secs);
        let modbus_timeout = Duration::from_secs_f64(atg_cfg.modbus_timeout_secs);
        let poster = poster::Poster::new(atg_cfg.api_url.clone(), atg_cfg.auth.clone());

        let now_ms = chrono::Utc::now().timestamp_millis();
        let collected_at = {
            use chrono::Utc;
            Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string()
        };

        let total = atg_cfg.branches.len();
        let mut ok_count = 0usize;
        let mut all_payloads = Vec::new();
        // product_id → (current_l, temperature_c, water_l)
        let mut level_updates: HashMap<u8, TankLiveLevel> = HashMap::new();

        for branch in &atg_cfg.branches {
            match modbus::read_branch(branch, modbus_timeout).await {
                Ok(floats) => {
                    ok_count += 1;

                    // Collect live readings for every slot that names a product_id.
                    for slot in &branch.slots {
                        if let Some(pid) = slot.product_id {
                            match read_slot(&floats, slot.slot) {
                                Some((current_l, temperature_c, water_l, _)) => {
                                    level_updates.insert(
                                        pid,
                                        TankLiveLevel {
                                            product_id: pid,
                                            current_l,
                                            temperature_c,
                                            water_l,
                                            updated_at_ms: now_ms,
                                        },
                                    );
                                }
                                None => warn!(
                                    branch_id = branch.id,
                                    slot = slot.slot,
                                    "ATG slot out of range or product_volume=0"
                                ),
                            }
                        }
                    }

                    match integration::build_payloads(branch, &floats, &collected_at) {
                        Ok(bodies) => all_payloads.extend(bodies),
                        Err(e) => warn!(branch_id = branch.id, ?e, "ATG payload build error"),
                    }
                }
                Err(e) => warn!(
                    branch_id = branch.id,
                    branch_name = %branch.name,
                    host = %branch.host,
                    port = branch.port,
                    ?e,
                    "ATG Modbus read failed"
                ),
            }
        }

        info!(
            ok = ok_count,
            total = total,
            payloads = all_payloads.len(),
            live_updates = level_updates.len(),
            "ATG poll round complete"
        );

        // Merge updates into the shared map and broadcast a full snapshot.
        if !level_updates.is_empty() {
            {
                let mut map = tank_levels.write().await;
                for (pid, level) in level_updates {
                    map.insert(pid, level);
                }
            }

            let live = tank_levels.read().await;
            let tanks: Vec<TankSnapshot> = tank_configs
                .iter()
                .map(|t| {
                    if let Some(l) = live.get(&t.product_id) {
                        TankSnapshot {
                            product_id: t.product_id,
                            label: t.label.clone(),
                            capacity_l: t.capacity_l,
                            current_l: l.current_l,
                            temperature_c: Some(l.temperature_c),
                            water_l: Some(l.water_l),
                            updated_at_ms: Some(l.updated_at_ms),
                        }
                    } else {
                        TankSnapshot {
                            product_id: t.product_id,
                            label: t.label.clone(),
                            capacity_l: t.capacity_l,
                            current_l: t.current_l,
                            temperature_c: None,
                            water_l: None,
                            updated_at_ms: None,
                        }
                    }
                })
                .collect();
            drop(live);

            let _ = events.send(WsEvent::TankUpdated { tanks });
        }

        for payload in all_payloads {
            poster.post(payload).await;
        }

        tokio::time::sleep(interval).await;
    }
}
