//! Build `/api/integration/fuel-levels` payloads from decoded Modbus floats.
//!
//! Mirrors the logic in the Python reference's `integration.py`.

use std::collections::HashMap;

use anyhow::bail;
use serde_json::{json, Value};
use tracing::warn;

use site_config::{AtgBranch, AtgSlot};

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
fn extract_slot_meta(floats: &[f32], slot_1based: u8) -> anyhow::Result<HashMap<String, f64>> {
    let start = ((slot_1based - 1) as usize) * 6;
    if start + 6 > floats.len() {
        bail!(
            "slot {}: need floats[{}..{}], only {} available",
            slot_1based,
            start,
            start + 6,
            floats.len()
        );
    }
    Ok(SLOT_FIELDS
        .iter()
        .enumerate()
        .map(|(i, &name)| (name.to_string(), floats[start + i] as f64))
        .collect())
}

/// A slot whose product_volume is <= 0 is treated as a bad Modbus transfer.
fn is_unusable(meta: &HashMap<String, f64>) -> bool {
    meta.get("product_volume").copied().unwrap_or(0.0) <= 0.0
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

/// Build one POST body per distinct fuel type on this branch.
///
/// Multiple slots with the same `fuel_type` are aggregated. Slots whose
/// `product_volume <= 0` are skipped (bad Modbus transfer).
pub fn build_payloads(
    branch: &AtgBranch,
    floats: &[f32],
    source_timestamp: &str,
) -> anyhow::Result<Vec<Value>> {
    if floats.len() < branch.float_count() {
        bail!(
            "branch {}: need {} floats (register_count={}), got {}",
            branch.id,
            branch.float_count(),
            branch.register_count,
            floats.len()
        );
    }
    if branch.slots.is_empty() {
        bail!("branch {}: no slots configured", branch.id);
    }

    // Group slots by fuel type in first-seen order.
    let mut order: Vec<&str> = Vec::new();
    let mut groups: HashMap<&str, Vec<&AtgSlot>> = HashMap::new();
    for slot in &branch.slots {
        let ft = slot.fuel_type.as_str();
        if !groups.contains_key(ft) {
            order.push(ft);
        }
        groups.entry(ft).or_default().push(slot);
    }

    let mut bodies = Vec::new();

    for fuel_type in order {
        let slot_group = &groups[fuel_type];
        let mut slot_metas: Vec<HashMap<String, f64>> = Vec::new();
        let mut maxima_list: Vec<&HashMap<String, f64>> = Vec::new();

        for sc in slot_group {
            match extract_slot_meta(floats, sc.slot) {
                Ok(meta) => {
                    if is_unusable(&meta) {
                        warn!(
                            branch = branch.id,
                            slot = sc.slot,
                            fuel_type = fuel_type,
                            "skipping slot: product_volume <= 0 (likely bad Modbus read)"
                        );
                        continue;
                    }
                    slot_metas.push(meta);
                    maxima_list.push(&sc.maxima);
                }
                Err(e) => warn!(
                    branch = branch.id,
                    slot = sc.slot,
                    ?e,
                    "slot extraction failed"
                ),
            }
        }

        if slot_metas.is_empty() {
            warn!(
                branch = branch.id,
                fuel_type = fuel_type,
                "no usable slots; skipping POST"
            );
            continue;
        }

        let mut meta = aggregate_metas(&slot_metas);
        let combined_maxima = sum_maxima(&maxima_list);
        apply_percentages(&mut meta, &combined_maxima);

        // Build metadata JSON object with sorted keys for stable output.
        let mut keys: Vec<_> = meta.keys().cloned().collect();
        keys.sort();
        let meta_obj: serde_json::Map<String, Value> = keys
            .into_iter()
            .map(|k| {
                let v = json!(meta[&k]);
                (k, v)
            })
            .collect();

        bodies.push(json!({
            "ayoqshMdmId": branch.id,
            "metadata": Value::Object(meta_obj),
            "sourceTimestamp": source_timestamp,
            "type": fuel_type,
        }));
    }

    Ok(bodies)
}
