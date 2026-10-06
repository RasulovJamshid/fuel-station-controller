//! Physical tank polling, live status and durable delivery.
mod integration;
mod modbus;
mod outbox;
mod poster;
#[cfg(test)]
mod tests;
pub use site_config::{AtgAuth, AtgBranch, AtgConfig, AtgSlot};
use site_config::{AtgHeightUnit, SiteConfig};
use sqlx::SqlitePool;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{broadcast, RwLock};
use types::{TankLiveLevel, TankSnapshot, WsEvent};

pub type TankLevels = Arc<RwLock<HashMap<String, TankLiveLevel>>>;

/// The same validation governs discovery, local readings and external totals.
fn slot_values(floats: &[f32], slot: u16) -> Option<&[f32]> {
    let start = usize::from(slot.checked_sub(1)?) * 6;
    let values = floats.get(start..start + 6)?;
    if values
        .iter()
        .enumerate()
        .any(|(i, v)| !v.is_finite() || (i != 2 && *v < 0.0))
    {
        return None;
    }
    Some(values)
}

pub fn snapshots(
    cfg: &SiteConfig,
    levels: &HashMap<String, TankLiveLevel>,
    now: i64,
) -> Vec<TankSnapshot> {
    let stale_after = cfg.atg.as_ref().map(|a| a.stale_after_ms()).unwrap_or(0);
    cfg.tanks
        .iter()
        .map(|t| {
            let mapped = cfg
                .atg
                .iter()
                .filter(|a| a.enabled)
                .flat_map(|a| &a.branches)
                .flat_map(|b| &b.slots)
                .any(|s| {
                    cfg.tank_for_slot(s)
                        .is_some_and(|target| target.id() == t.id())
                });
            let live = mapped.then(|| levels.get(&t.id())).flatten();
            let status = if !mapped {
                "disabled"
            } else if let Some(l) = live {
                if l.last_error.is_some() {
                    "offline"
                } else if now - l.updated_at_ms > stale_after {
                    "stale"
                } else {
                    "fresh"
                }
            } else {
                "waiting"
            };
            let sampled = live.filter(|l| l.updated_at_ms > 0);
            TankSnapshot {
                tank_id: t.id(),
                product_id: t.product_id,
                label: t.label.clone(),
                capacity_l: t.capacity_l,
                current_l: sampled.map(|l| l.current_l).unwrap_or(t.current_l),
                temperature_c: sampled.map(|l| l.temperature_c),
                water_l: sampled.map(|l| l.water_l),
                updated_at_ms: sampled.map(|l| l.updated_at_ms),
                reading_status: status.into(),
                stale_after_ms: stale_after,
                last_error: live.and_then(|l| l.last_error.clone()),
            }
        })
        .collect()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiscoveredTankSlot {
    pub slot: u16,
    pub product_height: f64,
    pub water_height: f64,
    pub temperature_c: f64,
    pub product_and_water_volume: f64,
    pub product_volume: f64,
    pub water_volume: f64,
}
pub async fn discover_host_tanks(
    host: &str,
    port: u16,
    unit_id: u8,
    start_register: u16,
    address_base: u16,
    register_count: u16,
    timeout: Duration,
) -> anyhow::Result<Vec<DiscoveredTankSlot>> {
    let start = start_register
        .checked_sub(address_base)
        .ok_or_else(|| anyhow::anyhow!("start_register must be >= address_base"))?;
    let floats = modbus::read_host(host, port, unit_id, start, register_count, timeout).await?;
    Ok((1..=register_count / 12)
        .filter_map(|slot| {
            let v = slot_values(&floats, slot)?;
            Some(DiscoveredTankSlot {
                slot,
                product_height: v[0] as f64,
                water_height: v[1] as f64,
                temperature_c: v[2] as f64,
                product_and_water_volume: v[3] as f64,
                product_volume: v[4] as f64,
                water_volume: v[5] as f64,
            })
        })
        .collect())
}

pub async fn discover_branch(
    branch: &AtgBranch,
    timeout: Duration,
) -> anyhow::Result<Vec<DiscoveredTankSlot>> {
    let floats = modbus::read_branch(branch, timeout).await?;
    Ok((1..=branch.register_count / 12)
        .filter_map(|slot| {
            let v = slot_values(&floats, slot)?;
            Some(DiscoveredTankSlot {
                slot,
                product_height: v[0] as f64,
                water_height: v[1] as f64,
                temperature_c: v[2] as f64,
                product_and_water_volume: v[3] as f64,
                product_volume: v[4] as f64,
                water_volume: v[5] as f64,
            })
        })
        .collect())
}

pub fn effective_api_url(cfg: &AtgConfig) -> String {
    if !cfg.export_enabled {
        return String::new();
    }
    std::env::var("API_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| cfg.api_url.clone())
        .trim()
        .into()
}

pub async fn run(
    cfg: Arc<RwLock<SiteConfig>>,
    levels: TankLevels,
    events: broadcast::Sender<WsEvent>,
    pool: SqlitePool,
) {
    tokio::spawn(outbox::deliver(cfg.clone(), pool.clone()));
    let mut previous = serde_json::Value::Null;
    let mut next = tokio::time::Instant::now();
    loop {
        let snapshot = cfg.read().await.clone();
        let identity = serde_json::json!({"atg":snapshot.atg,"tanks":snapshot.tanks,"products":snapshot.products});
        if previous != identity {
            levels.write().await.clear();
            // Keep this change pending until the catalog is durable.
            if let Err(e) = outbox::catalog(&pool, &snapshot).await {
                tracing::error!(?e, "ATG catalog persistence failed");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            previous = identity;
            next = tokio::time::Instant::now();
            let tanks = snapshots(
                &snapshot,
                &*levels.read().await,
                chrono::Utc::now().timestamp_millis(),
            );
            let _ = events.send(WsEvent::TankUpdated { tanks });
        }
        if let Some(atg) = &snapshot.atg {
            if atg.enabled && tokio::time::Instant::now() >= next {
                let started = tokio::time::Instant::now();
                poll_round(&snapshot, &cfg, &levels, &events, &pool).await;
                next = started + Duration::from_secs(atg.poll_interval_secs);
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn poll_round(
    cfg: &SiteConfig,
    current: &Arc<RwLock<SiteConfig>>,
    levels: &TankLevels,
    events: &broadcast::Sender<WsEvent>,
    pool: &SqlitePool,
) {
    let Some(atg) = &cfg.atg else {
        return;
    };
    let mut readings = HashMap::new();
    let mut sync = Vec::new();
    for branch in &atg.branches {
        let result =
            modbus::read_branch(branch, Duration::from_secs_f64(atg.modbus_timeout_secs)).await;
        let guard = current.read().await;
        if serde_json::json!([guard.atg, guard.tanks]) != serde_json::json!([cfg.atg, cfg.tanks]) {
            return;
        }
        let now = chrono::Utc::now().timestamp_millis();
        for slot in &branch.slots {
            let Some(tank) = cfg.tank_for_slot(slot) else {
                continue;
            };
            let values = result.as_ref().ok().and_then(|v| slot_values(v, slot.slot));
            if let Some(v) = values {
                let scale = if branch.height_unit == AtgHeightUnit::M {
                    1000.0
                } else {
                    1.0
                };
                levels.write().await.insert(
                    tank.id(),
                    TankLiveLevel {
                        tank_id: tank.id(),
                        product_id: tank.product_id,
                        current_l: v[4] as f64,
                        temperature_c: v[2] as f64,
                        water_l: v[5] as f64,
                        updated_at_ms: now,
                        last_error: None,
                    },
                );
                sync.push(serde_json::json!({"tank_id":tank.id(),"product_id":tank.product_id,
                    "product_name":cfg.product(tank.product_id).map(|p|p.name.as_str()).unwrap_or(""),
                    "volume_litres":v[4],"temperature_c":v[2],"level_mm":f64::from(v[0])*scale,
                    "water_mm":f64::from(v[1])*scale,"fill_percent":f64::from(v[4])/tank.capacity_l*100.0,"reading_at":now}));
            } else {
                let error = result
                    .as_ref()
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "Invalid tank measurements".into());
                tracing::warn!(tank_id=%tank.id(),%error,"ATG tank unavailable");
                levels
                    .write()
                    .await
                    .entry(tank.id())
                    .and_modify(|l| l.last_error = Some(error.clone()))
                    .or_insert(TankLiveLevel {
                        tank_id: tank.id(),
                        product_id: tank.product_id,
                        current_l: tank.current_l,
                        temperature_c: 0.0,
                        water_l: 0.0,
                        updated_at_ms: 0,
                        last_error: Some(error),
                    });
            }
        }
        if let Ok(values) = result {
            readings.insert(branch.id, values);
        }
    }
    let now = chrono::Utc::now();
    let external = integration::build_round(
        cfg,
        &readings,
        &now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    );
    let target = effective_api_url(atg);
    // Never discard a successfully sampled batch because a database write failed.
    loop {
        match outbox::persist(pool, &sync, &external, &target).await {
            Ok(()) => break,
            Err(e) => {
                tracing::error!(?e, "ATG batch persistence failed; retrying");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
    let guard = current.read().await;
    if serde_json::json!([guard.atg, guard.tanks]) != serde_json::json!([cfg.atg, cfg.tanks]) {
        return;
    }
    let tanks = snapshots(cfg, &*levels.read().await, now.timestamp_millis());
    let _ = events.send(WsEvent::TankUpdated { tanks });
}
