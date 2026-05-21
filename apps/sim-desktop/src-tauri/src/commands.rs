use crate::client::{ServiceClient, SimClient};

#[tauri::command]
pub async fn probe_sim(sim: tauri::State<'_, SimClient>) -> Result<bool, String> {
    Ok(sim.probe().await)
}

#[tauri::command]
pub async fn get_sim_state(
    sim: tauri::State<'_, SimClient>,
) -> Result<Vec<crate::client::SimDispenserInfo>, String> {
    sim.get_state().await
}

#[tauri::command]
pub async fn get_site_layout(
    service: tauri::State<'_, ServiceClient>,
) -> Result<Option<crate::client::SiteLayout>, String> {
    match service.get_site_layout().await {
        Ok(layout) => Ok(Some(layout)),
        Err(_) => Ok(None),
    }
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
pub async fn sim_go_offline(sim: tauri::State<'_, SimClient>, fp_id: String) -> Result<(), String> {
    sim.go_offline(fp_id).await
}

#[tauri::command]
pub async fn sim_go_online(
    sim: tauri::State<'_, SimClient>,
    fp_id: String,
    flush: Option<bool>,
) -> Result<(), String> {
    sim.go_online(fp_id, flush.unwrap_or(false)).await
}

#[tauri::command]
pub async fn sim_prepare_preauth(
    sim: tauri::State<'_, SimClient>,
    fp_id: String,
    nozzle: u8,
    product: u8,
    product_name: Option<String>,
) -> Result<(), String> {
    sim.prepare_preauth(fp_id, nozzle, product, product_name)
        .await
}

#[tauri::command]
pub async fn sim_estop_all(sim: tauri::State<'_, SimClient>) -> Result<(), String> {
    sim.estop_all().await
}

#[tauri::command]
pub async fn sim_reset_all(sim: tauri::State<'_, SimClient>) -> Result<(), String> {
    sim.reset_all().await
}

#[tauri::command]
pub async fn sim_run_scenario(
    sim: tauri::State<'_, SimClient>,
    name: String,
) -> Result<String, String> {
    sim.run_scenario(name).await
}
