//! Build `/api/integration/fuel-levels` payloads from decoded Modbus floats.
//!
//! Mirrors the logic in the Python reference's `integration.py`.

use std::collections::HashMap;

use serde_json::{json, Value};

use site_config::SiteConfig;

/// Six legacy metadata field names in Modbus register order (6 floats per slot).
const SLOT_FIELDS: [&str; 6] = [
    "product_height",
    "water_height",
    "product_temperature",
    "product_and_water_volume",
    "product_volume",
    "water_volume",
];

/// Extract the 6 float fields for one 1-based slot from the full float slice.
fn extract_slot_meta(floats: &[f32], slot: u16) -> anyhow::Result<HashMap<String, f64>> {
    let values =
        crate::slot_values(floats, slot).ok_or_else(|| anyhow::anyhow!("Invalid tank reading"))?;
    Ok(SLOT_FIELDS
        .iter()
        .zip(values.iter())
        .map(|(k, v)| (k.to_string(), f64::from(*v)))
        .collect())
}

/// Combine multiple physical slots into one logical metadata object.
///
/// - Volumes: summed
/// - Heights: max
/// - Temperature: volume-weighted average (falls back to simple average if total weight is 0)
fn aggregate_metas(metas: &[HashMap<String, f64>]) -> HashMap<String, f64> {
    if metas.len() == 1 {
        return metas[0].clone();
    }
    let mut out = HashMap::new();
    for &field in SLOT_FIELDS.iter() {
        let vals: Vec<f64> = metas
            .iter()
            .map(|m| m.get(field).copied().unwrap_or(0.0))
            .collect();

        let agg = match field {
            "product_height" | "water_height" => {
                vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
            }
            "product_temperature" => {
                let weights: Vec<f64> = metas
                    .iter()
                    .map(|m| m.get("product_volume").copied().unwrap_or(0.0).max(0.0))
                    .collect();
                let total_w: f64 = weights.iter().sum();
                if total_w > 0.0 {
                    weights
                        .iter()
                        .zip(vals.iter())
                        .map(|(w, t)| w * t)
                        .sum::<f64>()
                        / total_w
                } else {
                    vals.iter().sum::<f64>() / vals.len() as f64
                }
            }
            _ => vals.iter().sum(), // all volume fields and any others
        };
        out.insert(field.to_string(), agg);
    }
    out
}

/// Sum per-key maxima across all slots in a fuel-type group.
fn sum_maxima<'a>(maxima_list: &[&'a HashMap<String, f64>]) -> HashMap<String, f64> {
    let mut out: HashMap<String, f64> = HashMap::new();
    for m in maxima_list {
        for (k, &v) in m.iter() {
            *out.entry(k.clone()).or_insert(0.0) += v;
        }
    }
    out
}

/// Add `{key}_percent` fields and `max_product_volume` when maxima are configured.
fn apply_percentages(meta: &mut HashMap<String, f64>, maxima: &HashMap<String, f64>) {
    let mut additions: Vec<(String, f64)> = Vec::new();
    for (k, &max_val) in maxima {
        if max_val <= 0.0 {
            continue;
        }
        if let Some(&curr) = meta.get(k.as_str()) {
            additions.push((format!("{}_percent", k), curr / max_val * 100.0));
        }
    }
    for (k, v) in additions {
        meta.insert(k, v);
    }
    if let Some(&mv) = maxima.get("product_volume") {
        meta.insert("max_product_volume".to_string(), mv);
    }
}

/// Aggregate a complete external station/fuel group across all its controllers.
/// A failed member suppresses the whole group; never publish a partial total.
pub fn build_round(
    cfg: &SiteConfig,
    readings: &HashMap<u32, Vec<f32>>,
    timestamp: &str,
) -> Vec<Value> {
    struct Group {
        metas: Vec<HashMap<String, f64>>,
        maxima: Vec<HashMap<String, f64>>,
        complete: bool,
    }
    let mut groups: std::collections::BTreeMap<(u32, String), Group> =
        std::collections::BTreeMap::new();
    for branch in cfg.atg.iter().flat_map(|a| &a.branches) {
        for slot in &branch.slots {
            let group = groups
                .entry((
                    branch.external_station_id.unwrap_or(branch.id),
                    slot.fuel_type.clone(),
                ))
                .or_insert_with(|| Group {
                    metas: vec![],
                    maxima: vec![],
                    complete: true,
                });
            let meta = readings
                .get(&branch.id)
                .and_then(|f| extract_slot_meta(f, slot.slot).ok());
            if let Some(meta) = meta {
                group.metas.push(meta);
                let mut maxima = slot.maxima.clone();
                if let Some(capacity) = cfg
                    .tank_for_slot(slot)
                    .map(|t| t.capacity_l)
                    .or(slot.capacity_l)
                {
                    maxima.insert("product_volume".into(), capacity);
                    maxima.insert("product_and_water_volume".into(), capacity);
                }
                group.maxima.push(maxima);
            } else {
                group.complete = false;
            }
        }
    }
    groups.into_iter().filter_map(|((station,fuel),g)| {
        if !g.complete || g.metas.is_empty() { return None; }
        let mut meta = aggregate_metas(&g.metas);
        // A percentage is only meaningful if every member supplied its denominator.
        let refs: Vec<_> = g.maxima.iter().collect();
        let mut maxima = sum_maxima(&refs);
        maxima.retain(|key,_| g.maxima.iter().all(|m| m.contains_key(key)));
        apply_percentages(&mut meta,&maxima);
        Some(json!({"ayoqshMdmId":station,"type":fuel,"sourceTimestamp":timestamp,"metadata":meta}))
    }).collect()
}
