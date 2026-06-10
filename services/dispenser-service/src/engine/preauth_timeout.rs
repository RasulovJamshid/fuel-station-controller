//! Auto-cancel pre-authorizations when the customer never lifts the nozzle.

use std::sync::Arc;
use std::time::Duration;

use site_config::SiteConfig;
use tokio::sync::{broadcast, mpsc, RwLock};
use types::{FpStatus, WsEvent};

use super::poll_loop::DispatchCommand;
use super::state::RuntimeFp;

pub fn spawn_preauth_timeout_task(
    cfg: Arc<SiteConfig>,
    runtimes: Arc<RwLock<std::collections::HashMap<u8, RuntimeFp>>>,
    commands: mpsc::Sender<DispatchCommand>,
    events: broadcast::Sender<WsEvent>,
) {
    let timeout_secs = cfg.ui.preauth_timeout_seconds;
    if timeout_secs == 0 {
        return;
    }
    let timeout_ms = timeout_secs.saturating_mul(1000);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        loop {
            interval.tick().await;
            let now = chrono::Utc::now().timestamp_millis();
            let expired: Vec<(u8, String)> = {
                let map = runtimes.read().await;
                map.iter()
                    .filter_map(|(&byte, rt)| {
                        // Primary case: holstered preauth waiting for customer lift.
                        let started = if matches!(rt.state.status, FpStatus::PreAuthorized) {
                            rt.pre_auth_started_at?
                        } else if matches!(rt.state.status, FpStatus::Authorizing | FpStatus::NozzleUp)
                            && rt.preauth_config_on_wire
                            && rt.state.volume < 0.01
                            && rt.state.amount == 0
                        {
                            // CONFIG is on wire but no fuel has flowed — the arm-phase
                            // firmware-artifact guard in apply_nozzle_holstered now keeps
                            // the lane in Authorizing on spurious holster frames.  If the
                            // customer genuinely holstered, time it out the same way so
                            // the lane does not stay armed forever.
                            rt.auth_session_started_at?
                        } else {
                            return None;
                        };
                        if now.saturating_sub(started) >= timeout_ms as i64 {
                            Some((byte, rt.state.fp_id.clone()))
                        } else {
                            None
                        }
                    })
                    .collect()
            };
            for (byte, fp_id) in expired {
                tracing::info!(%fp_id, "pre-authorization timed out");
                let _ = events.send(WsEvent::PreAuthTimeout {
                    fp_id: fp_id.clone(),
                });
                let _ = commands.send(DispatchCommand::CancelPreauth { byte }).await;
            }
        }
    });
}
