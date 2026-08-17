use types::{Preset, StopSource};

/// Wayne-only wire/session state attached to a fueling-position runtime.
///
/// Keeping these fields outside `RuntimeFp` prevents Wayne CONFIG, hose-code,
/// ghost-recovery, and deceleration mechanics from becoming part of the common
/// runtime contract used by AZT and Gilbarco.
#[derive(Debug, Clone)]
pub(in crate::engine) struct WayneRuntimeState {
    pub(in crate::engine) stopped_nozzle_up: bool,
    pub(in crate::engine) preauth_nozzle_confirmed: bool,
    pub(in crate::engine) preauth_mismatch_active: bool,
    pub(in crate::engine) preauth_cancel_pending: bool,
    pub(in crate::engine) unauthorized_alerted: bool,
    pub(in crate::engine) ghost_recovery: bool,
    pub(in crate::engine) consecutive_idle_polls: u8,
    pub(in crate::engine) pending_authorize_config: bool,
    pub(in crate::engine) pending_authorize_config_repeat: bool,
    pub(in crate::engine) preauth_config_on_wire: bool,
    pub(in crate::engine) config_on_wire_at: Option<i64>,
    pub(in crate::engine) last_wire_hose_code: Option<u8>,
    pub(in crate::engine) last_wire_hose_at_ms: i64,
    pub(in crate::engine) pending_holster_close: bool,
    pub(in crate::engine) pump_sale_complete: bool,
    pub(in crate::engine) decel_stop_sent_at: Option<i64>,
    pub(in crate::engine) decel_vol_snapshot: f64,
    pub(in crate::engine) decel_frozen_count: u8,
    pub(in crate::engine) decel_pending_preset: Option<Preset>,
    pub(in crate::engine) decel_pending_stop_source: StopSource,
    pub(in crate::engine) startup_ghost_last_meter: Option<(f64, u64)>,
    pub(in crate::engine) startup_ghost_frozen_count: u8,
    pub(in crate::engine) stop_reflow_resent: bool,
}

impl Default for WayneRuntimeState {
    fn default() -> Self {
        Self {
            stopped_nozzle_up: false,
            preauth_nozzle_confirmed: false,
            preauth_mismatch_active: false,
            preauth_cancel_pending: false,
            unauthorized_alerted: false,
            ghost_recovery: false,
            consecutive_idle_polls: 0,
            pending_authorize_config: false,
            pending_authorize_config_repeat: false,
            preauth_config_on_wire: false,
            config_on_wire_at: None,
            last_wire_hose_code: None,
            last_wire_hose_at_ms: 0,
            pending_holster_close: false,
            pump_sale_complete: false,
            decel_stop_sent_at: None,
            decel_vol_snapshot: 0.0,
            decel_frozen_count: 0,
            decel_pending_preset: None,
            decel_pending_stop_source: StopSource::App,
            startup_ghost_last_meter: None,
            startup_ghost_frozen_count: 0,
            stop_reflow_resent: false,
        }
    }
}
