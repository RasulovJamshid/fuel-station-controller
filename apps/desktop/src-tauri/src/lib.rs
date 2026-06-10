mod client;
mod commands;

use client::{ServiceClient, SimClient};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServiceClient::default())
        .manage(SimClient::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_health,
            commands::get_all_status,
            commands::get_site_config,
            commands::probe_sim,
            commands::sim_nozzle_up,
            commands::sim_nozzle_down,
            commands::sim_set_preauth_expectation,
            commands::sim_prepare_preauth,
            commands::authorize,
            commands::preauthorize,
            commands::cancel_preauth,
            commands::stop_dispenser,
            commands::continue_fill,
            commands::resume_fill,
            commands::close_stopped_transaction,
            commands::dismiss_sale,
            commands::emergency_stop_all,
            commands::reset_all_lanes,
            commands::update_prices,
            commands::get_transactions,
            commands::get_transactions_summary,
            commands::get_current_shift,
            commands::start_shift,
            commands::end_shift,
            commands::handover_shift,
            commands::list_shifts,
            commands::get_shift_report,
            commands::list_operators,
            commands::admin_login,
            commands::admin_get_prices,
            commands::admin_update_prices,
            commands::admin_apply_prices_now,
            commands::admin_get_price_history,
            commands::admin_list_operators,
            commands::admin_create_operator,
            commands::admin_update_operator,
            commands::admin_delete_operator,
            commands::admin_get_settings,
            commands::admin_save_settings,
            commands::admin_shift_schedule,
            commands::admin_get_catalog,
            commands::admin_save_products,
            commands::admin_save_position_nozzles,
            commands::admin_change_pin,
            commands::get_sync_status,
            commands::update_sync_config,
            commands::admin_atg_discover,
            commands::admin_get_atg_config,
            commands::admin_save_atg_config,
        ])
        .setup(|app| {
            let ws = app.state::<ServiceClient>().ws_url();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(commands::ws_forward_loop(handle, ws));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
