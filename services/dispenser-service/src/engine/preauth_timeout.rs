//! Auto-cancel pre-authorizations when the customer never lifts the nozzle.

use std::sync::Arc;
use std::time::Duration;

use site_config::SiteConfig;
use tokio::sync::{broadcast, mpsc, RwLock};
use types::{FpStatus, WsEvent};

use super::poll_loop::DispatchCommand;
use super::state::RuntimeFp;

fn timeout_started_at_for(status: &FpStatus, pre_auth_started_at: Option<i64>) -> Option<i64> {
    // Only holstered pre-auth should auto-cancel.  Once the customer has lifted
    // and the lane is Authorizing, Wayne can legitimately sit at zero volume for
    // several seconds before first meter data; cancelling there loses preset/nozzle.
    if matches!(status, FpStatus::PreAuthorized) {
        pre_auth_started_at
    } else {
        None
    }
}

fn timeout_started_at(rt: &RuntimeFp) -> Option<i64> {
    timeout_started_at_for(&rt.state.status, rt.pre_auth_started_at)
}

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
                        let started = timeout_started_at(rt)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_only_applies_to_holstered_preauth() {
        assert_eq!(
            timeout_started_at_for(&FpStatus::PreAuthorized, Some(1000)),
            Some(1000)
        );
        assert_eq!(
            timeout_started_at_for(&FpStatus::Authorizing, Some(1000)),
            None
        );
        assert_eq!(
            timeout_started_at_for(&FpStatus::NozzleUp, Some(1000)),
            None
        );
    }
}
