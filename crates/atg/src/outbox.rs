use crate::{effective_api_url, poster::Poster};
use serde_json::{json, Value};
use site_config::SiteConfig;
use sqlx::{Row, SqlitePool};
use std::{sync::Arc, time::Duration};
use tokio::sync::RwLock;
use uuid::Uuid;

async fn enqueue(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    kind: &str,
    entity: &str,
    payload: &Value,
) -> anyhow::Result<()> {
    let json = serde_json::to_string(payload)?;
    let id = Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("{kind}:{entity}:{json}").as_bytes(),
    )
    .to_string();
    sqlx::query("INSERT OR IGNORE INTO sync_queue(id,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?)")
        .bind(id).bind(kind).bind(entity).bind(json).bind(chrono::Utc::now().timestamp_millis()).execute(&mut **tx).await?;
    Ok(())
}
pub async fn catalog(pool: &SqlitePool, cfg: &SiteConfig) -> anyhow::Result<()> {
    let tanks:Vec<_>=cfg.tanks.iter().map(|t| json!({"tank_id":t.id(),"product_id":t.product_id,
        "label":t.label,"capacity_l":t.capacity_l,"stale_after_secs":cfg.atg.as_ref().map(|a|a.stale_after_ms()/1000).unwrap_or(600),
        "monitoring_enabled":cfg.atg.iter().filter(|a|a.enabled).flat_map(|a|&a.branches).flat_map(|b|&b.slots).any(|s|cfg.tank_for_slot(s).is_some_and(|target|target.id()==t.id())),"product_name":cfg.product(t.product_id).map(|p| p.name.as_str()).unwrap_or("")})).collect();
    let payload = json!({"tanks":tanks,"updated_at":chrono::Utc::now().timestamp_millis()});
    let mut tx = pool.begin().await?;
    enqueue(&mut tx, "tank_catalog", &cfg.site.id, &payload).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn persist(
    pool: &SqlitePool,
    readings: &[Value],
    external: &[Value],
    target: &str,
) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    for reading in readings {
        let id = format!(
            "{}/{}",
            reading["tank_id"].as_str().unwrap_or(""),
            reading["reading_at"]
        );
        enqueue(&mut tx, "reservoir_reading", &id, reading).await?;
    }
    if !target.is_empty() {
        for payload in external {
            let json = serde_json::to_string(payload)?;
            let id = Uuid::new_v5(&Uuid::NAMESPACE_URL, format!("{target}:{json}").as_bytes())
                .to_string();
            sqlx::query("INSERT OR IGNORE INTO atg_outbox(id,target_url,payload_json,created_at) VALUES(?,?,?,?)")
                .bind(id).bind(target).bind(json).bind(chrono::Utc::now().timestamp_millis()).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}
pub async fn deliver(cfg: Arc<RwLock<SiteConfig>>, pool: SqlitePool) {
    let mut previous = serde_json::Value::Null;
    let mut poster = None;
    loop {
        let config = cfg.read().await.atg.clone().filter(|a| a.enabled);
        let Some(config) = config else {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        let target = effective_api_url(&config);
        let identity = json!({"url":target,"auth":config.auth});
        if identity != previous {
            poster = Some(Poster::new(target.clone(), config.auth.clone()));
            previous = identity;
        }
        let result: anyhow::Result<bool>=async {
            // Preserve order within a destination; a failed old reading cannot be overtaken.
            let row=sqlx::query("SELECT id,payload_json,next_attempt_at,attempts FROM atg_outbox WHERE target_url=? ORDER BY created_at,id LIMIT 1")
                .bind(&target).fetch_optional(&pool).await?;
            let Some(row)=row else { return Ok(false); };
            let now=chrono::Utc::now().timestamp_millis();
            if row.get::<i64,_>("next_attempt_at")>now { return Ok(false); }
            let id:String=row.get("id");
            let payload:Value=serde_json::from_str(&row.get::<String,_>("payload_json"))?;
            match poster.as_ref().expect("configured poster").post(payload).await {
                Ok(())=>{ sqlx::query("DELETE FROM atg_outbox WHERE id=?").bind(id).execute(&pool).await?; }
                Err(error)=>{
                    let attempts:i64=row.get("attempts");
                    let delay=2000i64.saturating_mul(1i64<<attempts.min(8)).min(300_000);
                    sqlx::query("UPDATE atg_outbox SET attempts=attempts+1,next_attempt_at=?,last_error=? WHERE id=?")
                        .bind(now+delay).bind(&error).bind(id).execute(&pool).await?;
                    tracing::warn!(%error,"ATG export retained for retry");
                }
            }
            Ok(true)
        }.await;
        match result {
            Ok(true) => {}
            Ok(false) => tokio::time::sleep(Duration::from_secs(1)).await,
            Err(e) => {
                tracing::error!(?e, "ATG outbox failure");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}
