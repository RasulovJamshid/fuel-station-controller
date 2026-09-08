//! Applies future-dated price changes when their effective time arrives.

use std::time::Duration;

use crate::api::routes::AppState;
use crate::db::price_schedule_queries as sched;

/// How often to look for changes that have come due.
///
/// Fuel prices are set to the minute, not the second, so a half-minute tick is
/// ample and keeps the DB quiet.
const TICK: Duration = Duration::from_secs(30);

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            run_once(&state).await;
        }
    });
}

/// Apply every change whose time has come. Each is claimed atomically before any
/// wire work, so a slow apply cannot be picked up twice by the next tick.
pub async fn run_once(state: &AppState) {
    let now = chrono::Utc::now().timestamp_millis();
    let due = match sched::claim_due(&state.pool, now).await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(?e, "price scheduler: claiming due changes failed");
            return;
        }
    };
    for change in due {
        let updates = crate::api::admin::updates_for_product(
            state,
            change.product_id,
            change.new_price,
        )
        .await;
        if updates.is_empty() {
            let msg = format!(
                "no active nozzle carries product {} ({})",
                change.product_id, change.product_name
            );
            tracing::warn!(id = %change.id, "price scheduler: {msg}");
            let _ = sched::mark_failed(&state.pool, &change.id, &msg).await;
            continue;
        }
        let who = format!("schedule:{}", change.created_by);
        match crate::api::admin::apply_price_updates(state, updates, &who).await {
            Ok(n) => tracing::info!(
                id = %change.id,
                product = %change.product_name,
                price = change.new_price,
                nozzles = n,
                "scheduled price change applied"
            ),
            Err((status, msg)) => {
                tracing::warn!(id = %change.id, %status, %msg, "scheduled price change failed");
                let _ = sched::mark_failed(&state.pool, &change.id, &msg).await;
            }
        }
    }
}
