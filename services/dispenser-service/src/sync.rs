//! Outbound sync: pushes queued records to the central backend.
//!
//! Design goals:
//!   • Offline-first — the dispenser keeps working with no backend at all.
//!   • Retry with backoff — network / server errors increment a counter; records
//!     that exceed `max_retries` are skipped (not dropped — they stay in the DB).
//!   • Idempotent — every record has a deterministic UUID so re-sending the same
//!     entity is safe (backend uses ProcessedSyncRecord for dedup).
//!   • Observable — callers read `SharedSyncStatus` to show connection state.

use std::path::PathBuf;
use std::sync::Arc;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use site_config::SiteConfig;
use sqlx::SqlitePool;
use tokio::sync::{mpsc, Mutex, RwLock};
use types::UpdatePriceCmd;

use crate::engine::DispatchCommand;

// ── Public status (shared with the HTTP status endpoint) ─────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SyncStatus {
    pub enabled: bool,
    pub backend_url: String,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub pending_count: i64,
    pub total_synced: u64,
    pub connected: bool,
    pub last_price_pull_at: Option<i64>,
    pub prices_updated: u64,
    pub price_pull_interval_hours: u64,
}

pub type SharedSyncStatus = Arc<Mutex<SyncStatus>>;

pub fn new_status(cfg: &site_config::SyncConfig) -> SharedSyncStatus {
    Arc::new(Mutex::new(SyncStatus {
        enabled: cfg.enabled,
        backend_url: cfg.backend_url.clone(),
        last_sync_at: None,
        last_error: None,
        pending_count: 0,
        total_synced: 0,
        connected: false,
        last_price_pull_at: None,
        prices_updated: 0,
        price_pull_interval_hours: cfg.price_pull_interval_hours,
    }))
}

// ── DB row type ───────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct QueueRow {
    id: String,
    entity_type: String,
    entity_id: String,
    payload_json: String,
    created_at: i64,
}

// ── Backend response ──────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
struct SyncResponse {
    #[serde(default)]
    accepted: Vec<String>,
    #[serde(default)]
    rejected: Vec<String>,
}

// ── Public enqueue helpers (called from db layer) ─────────────────────────────

/// Upsert a sync queue record.  A conflict on `id` resets the record so it
/// will be re-sent with the latest payload (e.g. STOPPED → COMPLETED update).
pub async fn enqueue(
    pool: &SqlitePool,
    entity_type: &str,
    entity_id: &str,
    payload: &serde_json::Value,
) -> anyhow::Result<()> {
    let sync_id = deterministic_id(entity_type, entity_id);
    let json = serde_json::to_string(payload)?;
    let now = chrono::Utc::now().timestamp_millis();

    sqlx::query(
        r#"INSERT INTO sync_queue (id, entity_type, entity_id, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
               payload_json = excluded.payload_json,
               synced_at    = NULL,
               retries      = 0,
               last_error   = NULL"#,
    )
    .bind(sync_id)
    .bind(entity_type)
    .bind(entity_id)
    .bind(json)
    .bind(now)
    .execute(pool)
    .await?;

    Ok(())
}

fn deterministic_id(entity_type: &str, entity_id: &str) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!("{entity_type}:{entity_id}").as_bytes(),
    )
    .to_string()
}

// ── Worker loop ───────────────────────────────────────────────────────────────

pub async fn run(
    pool: SqlitePool,
    cfg: Arc<RwLock<SiteConfig>>,
    config_path: PathBuf,
    status: SharedSyncStatus,
    commands: mpsc::Sender<DispatchCommand>,
) {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("sync reqwest client");

    let mut last_price_pull: Option<std::time::Instant> = None;

    loop {
        let (
            enabled,
            backend_url,
            api_key,
            station_id,
            interval,
            batch_size,
            max_retries,
            price_pull_interval_hours,
        ) = {
            let r = cfg.read().await;
            (
                r.sync.enabled,
                r.sync.backend_url.clone(),
                r.sync.api_key.clone(),
                r.site.id.clone(),
                r.sync.retry_interval_secs,
                r.sync.batch_size,
                r.sync.max_retries,
                r.sync.price_pull_interval_hours,
            )
        };

        // Reflect config into status even when disabled
        {
            let mut s = status.lock().await;
            s.enabled = enabled;
            s.backend_url = backend_url.clone();
            s.price_pull_interval_hours = price_pull_interval_hours;
        }

        let skip = !enabled || backend_url.is_empty() || api_key.is_empty();
        if !skip {
            // Push pending local records to the backend
            match do_batch(
                &pool,
                &client,
                &backend_url,
                &api_key,
                &station_id,
                batch_size,
                max_retries,
            )
            .await
            {
                Ok(synced) => {
                    let mut s = status.lock().await;
                    s.last_sync_at = Some(chrono::Utc::now().timestamp_millis());
                    s.last_error = None;
                    s.connected = true;
                    s.total_synced += synced as u64;
                    tracing::debug!(synced, "sync batch ok");
                }
                Err(err) => {
                    let mut s = status.lock().await;
                    s.last_error = Some(err.clone());
                    s.connected = false;
                    tracing::warn!(%err, "sync batch failed — will retry");
                }
            }

            // Update the pending counter regardless of success/failure
            if let Ok(n) = pending_count(&pool).await {
                status.lock().await.pending_count = n;
            }

            // Pull prices only on startup (last_price_pull is None) or after the configured interval.
            // price_pull_interval_hours == 0 means startup-only (no scheduled re-pull).
            let should_pull = match last_price_pull {
                None => true,
                Some(t) if price_pull_interval_hours > 0 => {
                    t.elapsed() >= std::time::Duration::from_secs(price_pull_interval_hours * 3600)
                }
                _ => false,
            };

            if should_pull {
                match pull_prices(
                    &pool,
                    &client,
                    &backend_url,
                    &api_key,
                    &station_id,
                    &cfg,
                    &config_path,
                    &commands,
                )
                .await
                {
                    Ok(updated) if updated > 0 => {
                        last_price_pull = Some(std::time::Instant::now());
                        let mut s = status.lock().await;
                        s.last_price_pull_at = Some(chrono::Utc::now().timestamp_millis());
                        s.prices_updated += updated as u64;
                        tracing::info!(updated, "price pull: applied remote price changes");
                    }
                    Ok(_) => {
                        last_price_pull = Some(std::time::Instant::now());
                        status.lock().await.last_price_pull_at =
                            Some(chrono::Utc::now().timestamp_millis());
                    }
                    Err(err) => {
                        tracing::warn!(%err, "price pull failed — will retry next tick");
                        // Don't advance last_price_pull so we retry on the next tick.
                    }
                }
            }
        }

        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
    }
}

async fn do_batch(
    pool: &SqlitePool,
    client: &Client,
    backend_url: &str,
    api_key: &str,
    station_id: &str,
    batch_size: usize,
    max_retries: u32,
) -> Result<usize, String> {
    let rows = sqlx::query_as::<_, QueueRow>(
        r#"SELECT id, entity_type, entity_id, payload_json, created_at
           FROM sync_queue
           WHERE synced_at IS NULL AND retries < ?
           ORDER BY created_at ASC
           LIMIT ?"#,
    )
    .bind(max_retries)
    .bind(batch_size as i64)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    if rows.is_empty() {
        return Ok(0);
    }

    let records: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let payload: serde_json::Value =
                serde_json::from_str(&r.payload_json).unwrap_or(serde_json::Value::Null);
            serde_json::json!({
                "id":          r.id,
                "entity_type": r.entity_type,
                "entity_id":   r.entity_id,
                "payload":     payload,
                "created_at":  r.created_at,
            })
        })
        .collect();

    let url = format!(
        "{}/api/v1/sync/{}",
        backend_url.trim_end_matches('/'),
        station_id
    );

    let http_resp = client
        .post(&url)
        .header("X-Api-Key", api_key)
        .json(&serde_json::json!({ "records": records }))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    if !http_resp.status().is_success() {
        let code = http_resp.status();
        let body = http_resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {code}: {body}"));
    }

    let resp: SyncResponse = http_resp.json().await.unwrap_or_default();
    let now = chrono::Utc::now().timestamp_millis();

    let accepted_set: std::collections::HashSet<_> = resp.accepted.iter().collect();
    let rejected_set: std::collections::HashSet<_> = resp.rejected.iter().collect();

    for row in &rows {
        if accepted_set.contains(&row.id) {
            let _ = sqlx::query("UPDATE sync_queue SET synced_at = ? WHERE id = ?")
                .bind(now)
                .bind(&row.id)
                .execute(pool)
                .await;
        } else if rejected_set.contains(&row.id) {
            let _ = sqlx::query(
                "UPDATE sync_queue SET retries = retries + 1, last_error = 'rejected by server' WHERE id = ?",
            )
            .bind(&row.id)
            .execute(pool)
            .await;
        } else {
            // Record was sent but server gave no verdict — count as a retry
            let _ = sqlx::query(
                "UPDATE sync_queue SET retries = retries + 1, last_error = 'no server verdict' WHERE id = ?",
            )
            .bind(&row.id)
            .execute(pool)
            .await;
        }
    }

    Ok(resp.accepted.len())
}

async fn pending_count(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE synced_at IS NULL")
        .fetch_one(pool)
        .await
}

#[derive(Deserialize)]
struct RemotePrice {
    fp_id: String,
    nozzle_index: u8,
    product_id: u8,
    product_name: String,
    price: u32,
}

/// Fetch current prices from the backend and apply any that differ from the local config.
/// Returns the number of nozzle prices that were updated.
async fn pull_prices(
    pool: &SqlitePool,
    client: &Client,
    backend_url: &str,
    api_key: &str,
    station_id: &str,
    cfg: &Arc<RwLock<SiteConfig>>,
    config_path: &PathBuf,
    commands: &mpsc::Sender<DispatchCommand>,
) -> Result<usize, String> {
    let url = format!(
        "{}/api/v1/sync/{}/prices",
        backend_url.trim_end_matches('/'),
        station_id
    );

    let resp = client
        .get(&url)
        .header("X-Api-Key", api_key)
        .send()
        .await
        .map_err(|e| format!("price pull network: {e}"))?;

    if !resp.status().is_success() {
        let code = resp.status();
        // 404 means no prices recorded yet on the backend — not an error
        if code == reqwest::StatusCode::NOT_FOUND {
            return Ok(0);
        }
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("price pull HTTP {code}: {body}"));
    }

    let remote: Vec<RemotePrice> = resp
        .json()
        .await
        .map_err(|e| format!("price pull parse: {e}"))?;
    if remote.is_empty() {
        return Ok(0);
    }

    // Collect what actually changed: (cmd, product_id, product_name)
    let mut updates: Vec<(UpdatePriceCmd, u8, String)> = Vec::new();
    {
        let cfg_r = cfg.read().await;
        for rp in &remote {
            let nozzle = cfg_r
                .fueling_positions
                .iter()
                .find(|fp| fp.id == rp.fp_id)
                .and_then(|fp| fp.nozzles.iter().find(|n| n.index == rp.nozzle_index));

            if nozzle.map(|n| n.price) != Some(rp.price) {
                let product_id = nozzle.map(|n| n.product_id).unwrap_or(rp.product_id);
                let product_name = cfg_r
                    .product(product_id)
                    .map(|p| p.name.clone())
                    .unwrap_or_else(|| rp.product_name.clone());
                updates.push((
                    UpdatePriceCmd {
                        fp_id: rp.fp_id.clone(),
                        nozzle_index: rp.nozzle_index,
                        price: rp.price,
                    },
                    product_id,
                    product_name,
                ));
            }
        }
    }

    if updates.is_empty() {
        return Ok(0);
    }

    // Apply to in-memory config + disk
    let count = updates.len();
    let cmds: Vec<UpdatePriceCmd> = updates.iter().map(|(u, _, _)| u.clone()).collect();
    {
        let mut cfg_w = cfg.write().await;
        for (u, _, _) in &updates {
            cfg_w.set_nozzle_price(&u.fp_id, u.nozzle_index, u.price);
        }
        if let Err(e) = crate::config::save(&cfg_w, config_path) {
            tracing::warn!(?e, "price pull: failed to persist config to disk");
        }
    }

    // Update the runtime prices (live dispensers pick these up immediately)
    let _ = commands.try_send(DispatchCommand::UpdatePrices {
        updates: cmds,
        changed_by: "server".into(),
    });

    // Persist to the local DB price history (0 for old_price — server-push, previous value unknown)
    for (u, product_id, product_name) in &updates {
        if let Err(e) = crate::db::admin_queries::insert_price_change(
            pool,
            &u.fp_id,
            u.nozzle_index,
            *product_id,
            product_name,
            0,
            u.price,
            "server",
        )
        .await
        {
            tracing::warn!(?e, "price pull: history insert failed");
        }
        if let Err(e) = crate::db::admin_queries::update_nozzle_price_in_db(
            pool,
            &u.fp_id,
            u.nozzle_index,
            u.price,
            "server",
        )
        .await
        {
            tracing::warn!(?e, "price pull: nozzle DB update failed");
        }
    }

    Ok(count)
}
