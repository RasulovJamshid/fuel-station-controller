use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::client::{ServiceClient, SimClient};

#[tauri::command]
pub async fn get_health(
    client: tauri::State<'_, ServiceClient>,
) -> Result<serde_json::Value, String> {
    client.health().await
}

#[tauri::command]
pub async fn get_all_status(
    client: tauri::State<'_, ServiceClient>,
) -> Result<Vec<types::FpState>, String> {
    client.get_all_status().await
}

#[tauri::command]
pub async fn get_site_config(
    client: tauri::State<'_, ServiceClient>,
) -> Result<types::SiteSnapshot, String> {
    client.get_site_config().await
}

#[tauri::command]
pub async fn probe_sim(sim: tauri::State<'_, SimClient>) -> Result<bool, String> {
    Ok(sim.probe().await)
}

#[tauri::command]
pub async fn sim_nozzle_up(
    sim: tauri::State<'_, SimClient>,
    fp_id: String,
    nozzle: Option<u8>,
    product: Option<u8>,
    product_name: Option<String>,
) -> Result<(), String> {
    sim.nozzle_up(fp_id, nozzle, product, product_name).await
}

#[tauri::command]
pub async fn sim_nozzle_down(
    sim: tauri::State<'_, SimClient>,
    fp_id: String,
) -> Result<(), String> {
    sim.nozzle_down(fp_id).await
}

#[tauri::command]
pub async fn sim_set_preauth_expectation(
    sim: tauri::State<'_, SimClient>,
    fp_id: String,
    nozzle: u8,
    product: u8,
    product_name: Option<String>,
) -> Result<(), String> {
    sim.set_preauth_expectation(fp_id, nozzle, product, product_name)
        .await
}

#[tauri::command]
pub async fn sim_prepare_preauth(
    sim: tauri::State<'_, SimClient>,
    fp_id: String,
    nozzle: u8,
    product: u8,
    product_name: Option<String>,
) -> Result<(), String> {
    sim.prepare_preauth_lane(fp_id, nozzle, product, product_name)
        .await
}

#[tauri::command]
pub async fn authorize(
    client: tauri::State<'_, ServiceClient>,
    fp_id: String,
    nozzle_index: Option<u8>,
    preset_kind: String,
    preset_value: Option<f64>,
    price_override: Option<u32>,
) -> Result<(), String> {
    use types::{AuthorizeCmd, Preset};
    let preset = match preset_kind.to_lowercase().as_str() {
        "full" => Preset::Str("full".into()),
        "volume" => {
            let v = preset_value
                .ok_or_else(|| "preset_value required: litres for volume preset".to_string())?;
            if v <= 0.0 || v > 10_000.0 {
                return Err("volume must be in (0, 10000] L".into());
            }
            Preset::Volume(v)
        }
        "amount" => {
            let v = preset_value.ok_or_else(|| {
                "preset_value required: total sum (minor units) for amount preset".to_string()
            })?;
            if v <= 0.0 || v > 500_000_000_000.0 {
                return Err("amount out of allowed range".into());
            }
            let a = v.round() as u64;
            if (a as f64 - v).abs() > 1e-3 {
                return Err("amount must be a whole number (minor currency units)".into());
            }
            Preset::Amount(a)
        }
        _ => return Err("preset_kind must be \"full\", \"volume\", or \"amount\"".into()),
    };
    client
        .authorize(AuthorizeCmd {
            fp_id,
            nozzle_index,
            preset,
            price_override,
        })
        .await
}

#[tauri::command]
pub async fn preauthorize(
    client: tauri::State<'_, ServiceClient>,
    fp_id: String,
    nozzle_index: Option<u8>,
    preset_kind: String,
    preset_value: Option<f64>,
    price_override: Option<u32>,
) -> Result<(), String> {
    use types::{AuthorizeCmd, Preset};
    let preset = match preset_kind.to_lowercase().as_str() {
        "full" => Preset::Str("full".into()),
        "volume" => {
            let v = preset_value
                .ok_or_else(|| "preset_value required: litres for volume preset".to_string())?;
            if v <= 0.0 || v > 10_000.0 {
                return Err("volume must be in (0, 10000] L".into());
            }
            Preset::Volume(v)
        }
        "amount" => {
            let v = preset_value.ok_or_else(|| {
                "preset_value required: total sum (minor units) for amount preset".to_string()
            })?;
            if v <= 0.0 || v > 500_000_000_000.0 {
                return Err("amount out of allowed range".into());
            }
            let a = v.round() as u64;
            if (a as f64 - v).abs() > 1e-3 {
                return Err("amount must be a whole number (minor currency units)".into());
            }
            Preset::Amount(a)
        }
        _ => return Err("preset_kind must be \"full\", \"volume\", or \"amount\"".into()),
    };
    client
        .preauthorize(AuthorizeCmd {
            fp_id,
            nozzle_index,
            preset,
            price_override,
        })
        .await
}

#[tauri::command]
pub async fn cancel_preauth(
    client: tauri::State<'_, ServiceClient>,
    fp_id: String,
) -> Result<(), String> {
    client.cancel_preauth(fp_id).await
}

#[tauri::command]
pub async fn stop_dispenser(
    client: tauri::State<'_, ServiceClient>,
    fp_id: String,
) -> Result<(), String> {
    client.stop_dispenser(fp_id).await
}

#[tauri::command]
pub async fn continue_fill(
    client: tauri::State<'_, ServiceClient>,
    fp_id: String,
    stopped_tx_id: String,
) -> Result<(), String> {
    client.continue_fill(fp_id, stopped_tx_id).await
}

#[tauri::command]
pub async fn resume_fill(
    client: tauri::State<'_, ServiceClient>,
    fp_id: String,
    stopped_tx_id: String,
) -> Result<(), String> {
    client.resume_fill(fp_id, stopped_tx_id).await
}

#[tauri::command]
pub async fn close_stopped_transaction(
    client: tauri::State<'_, ServiceClient>,
    fp_id: String,
    stopped_tx_id: String,
) -> Result<(), String> {
    client.close_stopped_transaction(fp_id, stopped_tx_id).await
}

#[tauri::command]
pub async fn dismiss_sale(
    client: tauri::State<'_, ServiceClient>,
    fp_id: String,
) -> Result<types::FpState, String> {
    client.dismiss_sale(fp_id).await
}

#[tauri::command]
pub async fn emergency_stop_all(client: tauri::State<'_, ServiceClient>) -> Result<(), String> {
    client.emergency_stop_all().await
}

/// Service: idle all lanes; sim: `POST /sim/reset` when the sim API is reachable (errors ignored).
#[tauri::command]
pub async fn reset_all_lanes(
    client: tauri::State<'_, ServiceClient>,
    sim: tauri::State<'_, SimClient>,
) -> Result<(), String> {
    client.reset_all().await?;
    if sim.probe().await {
        let _ = sim.reset_all().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn update_prices(
    client: tauri::State<'_, ServiceClient>,
    updates: Vec<types::UpdatePriceCmd>,
) -> Result<(), String> {
    client.update_prices(updates).await
}

#[tauri::command]
pub async fn get_transactions(
    client: tauri::State<'_, ServiceClient>,
    limit: Option<i64>,
    offset: Option<i64>,
    fp_id: Option<String>,
    shift_id: Option<String>,
    statuses: Option<String>,
    from_ms: Option<i64>,
    until_ms: Option<i64>,
) -> Result<Vec<types::Transaction>, String> {
    client
        .get_transactions(limit, offset, fp_id, shift_id, statuses, from_ms, until_ms)
        .await
}

#[tauri::command]
pub async fn get_transactions_summary(
    client: tauri::State<'_, ServiceClient>,
    fp_id: Option<String>,
    shift_id: Option<String>,
    statuses: Option<String>,
    from_ms: Option<i64>,
    until_ms: Option<i64>,
) -> Result<types::TxSummary, String> {
    client
        .get_transactions_summary(fp_id, shift_id, statuses, from_ms, until_ms)
        .await
}

#[tauri::command]
pub async fn list_operators(
    client: tauri::State<'_, ServiceClient>,
) -> Result<Vec<types::Operator>, String> {
    client.list_operators().await
}

#[tauri::command]
pub async fn get_current_shift(
    client: tauri::State<'_, ServiceClient>,
) -> Result<Option<types::Shift>, String> {
    client.get_current_shift().await
}

#[tauri::command]
pub async fn start_shift(
    client: tauri::State<'_, ServiceClient>,
    operator_name: String,
    operator_id: Option<String>,
    pin: Option<String>,
    notes: Option<String>,
    started_at_ms: Option<i64>,
) -> Result<types::Shift, String> {
    client
        .start_shift(types::StartShiftCmd {
            operator_name,
            operator_id,
            pin,
            notes,
            started_at_override: started_at_ms,
        })
        .await
}

#[tauri::command]
pub async fn end_shift(
    client: tauri::State<'_, ServiceClient>,
    shift_id: String,
    notes: Option<String>,
) -> Result<types::Shift, String> {
    client
        .end_shift(types::EndShiftCmd { shift_id, notes })
        .await
}

#[tauri::command]
pub async fn handover_shift(
    client: tauri::State<'_, ServiceClient>,
    outgoing_shift_id: String,
    incoming_operator: String,
    incoming_operator_id: Option<String>,
    incoming_pin: Option<String>,
    notes: Option<String>,
    incoming_started_at_ms: Option<i64>,
) -> Result<serde_json::Value, String> {
    client
        .handover_shift(types::HandoverCmd {
            outgoing_shift_id,
            incoming_operator,
            incoming_operator_id,
            incoming_pin,
            notes,
            incoming_started_at_override: incoming_started_at_ms,
        })
        .await
}

#[tauri::command]
pub async fn list_shifts(
    client: tauri::State<'_, ServiceClient>,
    limit: Option<i64>,
    offset: Option<i64>,
    status: Option<String>,
) -> Result<Vec<types::Shift>, String> {
    client.list_shifts(limit, offset, status).await
}

#[tauri::command]
pub async fn get_shift_report(
    client: tauri::State<'_, ServiceClient>,
    id: String,
) -> Result<types::Shift, String> {
    client.get_shift_report(id).await
}

#[tauri::command]
pub async fn admin_login(
    client: tauri::State<'_, ServiceClient>,
    pin: String,
) -> Result<types::AdminAuthResponse, String> {
    client.admin_login(pin).await
}

#[tauri::command]
pub async fn admin_get_prices(
    client: tauri::State<'_, ServiceClient>,
    token: String,
) -> Result<Vec<types::AdminPriceEntry>, String> {
    client.admin_get_prices(token).await
}

#[tauri::command]
pub async fn admin_update_prices(
    client: tauri::State<'_, ServiceClient>,
    token: String,
    updates: Vec<types::UpdatePriceCmd>,
) -> Result<serde_json::Value, String> {
    client.admin_update_prices(token, updates).await
}

#[tauri::command]
pub async fn admin_apply_prices_now(
    client: tauri::State<'_, ServiceClient>,
    token: String,
    fp_id: String,
) -> Result<(), String> {
    client.admin_apply_prices_now(token, fp_id).await
}

#[tauri::command]
pub async fn admin_get_price_history(
    client: tauri::State<'_, ServiceClient>,
    token: String,
    limit: Option<i64>,
) -> Result<Vec<types::PriceChange>, String> {
    client.admin_price_history(token, limit).await
}

#[tauri::command]
pub async fn admin_list_operators(
    client: tauri::State<'_, ServiceClient>,
    token: String,
) -> Result<Vec<types::Operator>, String> {
    client.admin_list_operators(token).await
}

#[tauri::command]
pub async fn admin_create_operator(
    client: tauri::State<'_, ServiceClient>,
    token: String,
    name: String,
    pin: Option<String>,
) -> Result<types::Operator, String> {
    client
        .admin_create_operator(token, types::CreateOperatorCmd { name, pin })
        .await
}

#[tauri::command]
pub async fn admin_update_operator(
    client: tauri::State<'_, ServiceClient>,
    token: String,
    id: String,
    active: Option<bool>,
    pin: Option<String>,
) -> Result<types::Operator, String> {
    client
        .admin_update_operator(token, id, types::AdminUpdateOperatorCmd { active, pin })
        .await
}

#[tauri::command]
pub async fn admin_delete_operator(
    client: tauri::State<'_, ServiceClient>,
    token: String,
    id: String,
) -> Result<(), String> {
    client.admin_delete_operator(token, id).await
}

#[tauri::command]
pub async fn admin_get_settings(
    client: tauri::State<'_, ServiceClient>,
    token: String,
) -> Result<types::AdminSettingsSnapshot, String> {
    client.admin_get_settings(token).await
}

#[tauri::command]
pub async fn admin_save_settings(
    client: tauri::State<'_, ServiceClient>,
    token: String,
    body: serde_json::Value,
) -> Result<(), String> {
    client.admin_save_settings(token, body).await
}

#[tauri::command]
pub async fn admin_shift_schedule(
    client: tauri::State<'_, ServiceClient>,
    token: String,
    mode: String,
    scheduled: Vec<types::ShiftSlot>,
) -> Result<(), String> {
    client
        .admin_shift_schedule(token, types::AdminShiftScheduleCmd { mode, scheduled })
        .await
}

#[tauri::command]
pub async fn admin_get_catalog(
    client: tauri::State<'_, ServiceClient>,
    token: String,
) -> Result<types::AdminCatalog, String> {
    client.admin_get_catalog(token).await
}

#[tauri::command]
pub async fn admin_save_products(
    client: tauri::State<'_, ServiceClient>,
    token: String,
    products: Vec<types::AdminProductInput>,
) -> Result<(), String> {
    client
        .admin_save_products(token, types::SaveProductsCmd { products })
        .await
}

#[tauri::command]
pub async fn admin_save_position_nozzles(
    client: tauri::State<'_, ServiceClient>,
    token: String,
    fp_id: String,
    nozzles: Vec<types::AdminNozzleInput>,
) -> Result<(), String> {
    client
        .admin_save_position_nozzles(token, fp_id, types::SavePositionNozzlesCmd { nozzles })
        .await
}

#[tauri::command]
pub async fn admin_change_pin(
    client: tauri::State<'_, ServiceClient>,
    token: Option<String>,
    current_pin: String,
    new_pin: String,
) -> Result<(), String> {
    client
        .admin_change_pin(
            token,
            types::AdminChangePinCmd {
                current_pin,
                new_pin,
            },
        )
        .await
}

#[tauri::command]
pub async fn get_sync_status(
    client: tauri::State<'_, ServiceClient>,
) -> Result<serde_json::Value, String> {
    client.get_sync_status().await
}

#[tauri::command]
pub async fn update_sync_config(
    client: tauri::State<'_, ServiceClient>,
    enabled: Option<bool>,
    backend_url: Option<String>,
    api_key: Option<String>,
    retry_interval_secs: Option<u64>,
    batch_size: Option<usize>,
    max_retries: Option<u32>,
    price_pull_interval_hours: Option<u64>,
) -> Result<(), String> {
    let mut body = serde_json::Map::new();
    if let Some(v) = enabled {
        body.insert("enabled".into(), serde_json::json!(v));
    }
    if let Some(v) = backend_url {
        body.insert("backend_url".into(), serde_json::json!(v));
    }
    if let Some(v) = api_key {
        body.insert("api_key".into(), serde_json::json!(v));
    }
    if let Some(v) = retry_interval_secs {
        body.insert("retry_interval_secs".into(), serde_json::json!(v));
    }
    if let Some(v) = batch_size {
        body.insert("batch_size".into(), serde_json::json!(v));
    }
    if let Some(v) = max_retries {
        body.insert("max_retries".into(), serde_json::json!(v));
    }
    if let Some(v) = price_pull_interval_hours {
        body.insert("price_pull_interval_hours".into(), serde_json::json!(v));
    }
    client
        .update_sync_config(serde_json::Value::Object(body))
        .await
}

#[tauri::command]
pub async fn admin_atg_discover(
    client: tauri::State<'_, ServiceClient>,
    port: Option<u16>,
    unit_id: Option<u8>,
    start_register: Option<u16>,
    address_base: Option<u16>,
    register_count: Option<u16>,
) -> Result<serde_json::Value, String> {
    client
        .admin_atg_discover(port, unit_id, start_register, address_base, register_count)
        .await
}

#[tauri::command]
pub async fn admin_get_atg_config(
    client: tauri::State<'_, ServiceClient>,
) -> Result<serde_json::Value, String> {
    client.admin_get_atg_config().await
}

#[tauri::command]
pub async fn admin_save_atg_config(
    client: tauri::State<'_, ServiceClient>,
    poll_interval_secs: Option<u64>,
    modbus_timeout_secs: Option<f64>,
    api_url: Option<String>,
    auth: Option<serde_json::Value>,
    branches: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut body = serde_json::Map::new();
    if let Some(v) = poll_interval_secs {
        body.insert("poll_interval_secs".into(), serde_json::json!(v));
    }
    if let Some(v) = modbus_timeout_secs {
        body.insert("modbus_timeout_secs".into(), serde_json::json!(v));
    }
    if let Some(v) = api_url {
        body.insert("api_url".into(), serde_json::json!(v));
    }
    if let Some(v) = auth {
        body.insert("auth".into(), v);
    }
    if let Some(v) = branches {
        body.insert("branches".into(), v);
    }
    client
        .admin_save_atg_config(serde_json::Value::Object(body))
        .await
}

pub async fn ws_forward_loop(app: AppHandle, ws_url: String) {
    loop {
        match connect_async(&ws_url).await {
            Ok((ws, _)) => {
                let (mut write, mut read) = ws.split();
                while let Some(msg) = read.next().await {
                    match msg {
                        Ok(Message::Text(t)) => {
                            let _ = app.emit("dispenser_event", t.to_string());
                        }
                        Ok(Message::Ping(payload)) => {
                            let _ = futures_util::SinkExt::send(&mut write, Message::Pong(payload))
                                .await;
                        }
                        Ok(Message::Close(_)) | Err(_) => break,
                        _ => {}
                    }
                }
            }
            Err(_) => {}
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}
