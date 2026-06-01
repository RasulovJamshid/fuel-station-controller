mod client;
mod commands;

use client::{ServiceClient, SimClient};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SimClient::default())
        .manage(ServiceClient::default())
        .invoke_handler(tauri::generate_handler![
            commands::probe_sim,
            commands::get_sim_state,
            commands::get_site_layout,
            commands::sim_nozzle_up,
            commands::sim_nozzle_down,
            commands::sim_go_offline,
            commands::sim_go_online,
            commands::sim_prepare_preauth,
            commands::sim_set_fill_rate,
            commands::sim_estop_all,
            commands::sim_reset_all,
            commands::sim_run_scenario,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
