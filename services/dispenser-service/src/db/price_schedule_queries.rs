//! Future-dated price changes.
//!
//! A scheduled row is inert until `effective_at` passes; the scheduler task then
//! claims it and pushes the new price through the normal `UpdatePrices` dispatch, so
//! a scheduled change goes to the wire and into `price_history` by exactly the same
//! path as a manual one.

use anyhow::{anyhow, Result};
use sqlx::SqlitePool;
use types::{ScheduledPrice, ScheduledPriceStatus};
use uuid::Uuid;

fn status_str(s: ScheduledPriceStatus) -> &'static str {
    match s {
        ScheduledPriceStatus::Pending => "PENDING",
        ScheduledPriceStatus::Applied => "APPLIED",
        ScheduledPriceStatus::Cancelled => "CANCELLED",
        ScheduledPriceStatus::Failed => "FAILED",
    }
}

fn parse_status(s: &str) -> ScheduledPriceStatus {
    match s {
        "APPLIED" => ScheduledPriceStatus::Applied,
        "CANCELLED" => ScheduledPriceStatus::Cancelled,
        "FAILED" => ScheduledPriceStatus::Failed,
        _ => ScheduledPriceStatus::Pending,
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    product_id: i64,
    product_name: String,
    new_price: i64,
    effective_at: i64,
    status: String,
    created_by: String,
    created_at: i64,
    applied_at: Option<i64>,
    error: Option<String>,
    notes: Option<String>,
}

impl From<Row> for ScheduledPrice {
    fn from(r: Row) -> Self {
        ScheduledPrice {
            id: r.id,
            product_id: r.product_id.clamp(0, 255) as u8,
            product_name: r.product_name,
            new_price: r.new_price.max(0) as u32,
            effective_at: r.effective_at,
            status: parse_status(&r.status),
            created_by: r.created_by,
            created_at: r.created_at,
            applied_at: r.applied_at,
            error: r.error,
            notes: r.notes,
        }
    }
}

const COLS: &str = r#"id, product_id, product_name, new_price, effective_at, status,
    created_by, created_at, applied_at, error, notes"#;

pub async fn insert(
    pool: &SqlitePool,
    product_id: u8,
    product_name: &str,
    new_price: u32,
    effective_at: i64,
    created_by: &str,
    notes: Option<&str>,
) -> Result<ScheduledPrice> {
    if new_price == 0 {
        return Err(anyhow!("price must be greater than zero"));
    }
    let now = chrono::Utc::now().timestamp_millis();
    if effective_at <= now {
        return Err(anyhow!("effective_at must be in the future"));
    }
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO scheduled_prices (
               id, product_id, product_name, new_price, effective_at, status,
               created_by, created_at, notes
           ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)"#,
    )
    .bind(&id)
    .bind(product_id as i64)
    .bind(product_name)
    .bind(new_price as i64)
    .bind(effective_at)
    .bind(created_by)
    .bind(now)
    .bind(notes)
    .execute(pool)
    .await?;
    get(pool, &id)
        .await?
        .ok_or_else(|| anyhow!("scheduled price vanished after insert"))
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<ScheduledPrice>> {
    let sql = format!("SELECT {COLS} FROM scheduled_prices WHERE id = ?");
    let row: Option<Row> = sqlx::query_as(&sql).bind(id).fetch_optional(pool).await?;
    Ok(row.map(Into::into))
}

pub async fn list(
    pool: &SqlitePool,
    status: Option<ScheduledPriceStatus>,
    limit: i64,
) -> Result<Vec<ScheduledPrice>> {
    let sql = format!(
        r#"SELECT {COLS} FROM scheduled_prices
           WHERE (?1 IS NULL OR status = ?1)
           ORDER BY effective_at DESC LIMIT ?2"#
    );
    let rows: Vec<Row> = sqlx::query_as(&sql)
        .bind(status.map(status_str))
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// Cancel a pending change. Applied rows are history and cannot be cancelled.
pub async fn cancel(pool: &SqlitePool, id: &str) -> Result<bool> {
    let r = sqlx::query(
        r#"UPDATE scheduled_prices SET status = 'CANCELLED'
           WHERE id = ? AND status = 'PENDING'"#,
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

/// Claim every change whose time has come.
///
/// The status flip to `APPLIED` happens in the same statement that selects the rows,
/// so a scheduler tick that overlaps the previous one cannot apply a change twice.
/// A row that then fails to reach the wire is moved to `FAILED` by [`mark_failed`].
pub async fn claim_due(pool: &SqlitePool, now_ms: i64) -> Result<Vec<ScheduledPrice>> {
    let sql = format!(
        r#"UPDATE scheduled_prices SET status = 'APPLIED', applied_at = ?1
           WHERE status = 'PENDING' AND effective_at <= ?1
           RETURNING {COLS}"#
    );
    let rows: Vec<Row> = sqlx::query_as(&sql).bind(now_ms).fetch_all(pool).await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn mark_failed(pool: &SqlitePool, id: &str, error: &str) -> Result<()> {
    sqlx::query(r#"UPDATE scheduled_prices SET status = 'FAILED', error = ? WHERE id = ?"#)
        .bind(error)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn memory_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite pool");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    fn future() -> i64 {
        chrono::Utc::now().timestamp_millis() + 60_000
    }

    #[tokio::test]
    async fn past_effective_at_is_rejected() {
        let pool = memory_pool().await;
        let past = chrono::Utc::now().timestamp_millis() - 1_000;
        assert!(insert(&pool, 1, "AI-92", 12_000, past, "admin", None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn zero_price_is_rejected() {
        let pool = memory_pool().await;
        assert!(insert(&pool, 1, "AI-92", 0, future(), "admin", None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn pending_change_is_not_claimed_before_its_time() {
        let pool = memory_pool().await;
        let s = insert(&pool, 1, "AI-92", 12_000, future(), "admin", None)
            .await
            .unwrap();
        assert_eq!(s.status, ScheduledPriceStatus::Pending);
        let due = claim_due(&pool, chrono::Utc::now().timestamp_millis())
            .await
            .unwrap();
        assert!(due.is_empty(), "a future change must not be applied early");
    }

    #[tokio::test]
    async fn due_change_is_claimed_exactly_once() {
        let pool = memory_pool().await;
        let effective = future();
        insert(&pool, 1, "AI-92", 12_000, effective, "admin", None)
            .await
            .unwrap();

        let first = claim_due(&pool, effective + 1).await.unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].new_price, 12_000);

        // A second tick (or an overlapping one) must find nothing left to apply.
        let second = claim_due(&pool, effective + 2).await.unwrap();
        assert!(second.is_empty(), "claiming twice would double-apply a price");
    }

    #[tokio::test]
    async fn cancelled_change_is_never_applied() {
        let pool = memory_pool().await;
        let effective = future();
        let s = insert(&pool, 1, "AI-92", 12_000, effective, "admin", None)
            .await
            .unwrap();
        assert!(cancel(&pool, &s.id).await.unwrap());

        let due = claim_due(&pool, effective + 1).await.unwrap();
        assert!(due.is_empty());
        assert_eq!(
            get(&pool, &s.id).await.unwrap().unwrap().status,
            ScheduledPriceStatus::Cancelled
        );
    }

    #[tokio::test]
    async fn applied_change_cannot_be_cancelled() {
        let pool = memory_pool().await;
        let effective = future();
        let s = insert(&pool, 1, "AI-92", 12_000, effective, "admin", None)
            .await
            .unwrap();
        claim_due(&pool, effective + 1).await.unwrap();
        assert!(
            !cancel(&pool, &s.id).await.unwrap(),
            "an applied price change is history, not a pending intent"
        );
    }

    #[tokio::test]
    async fn failed_claim_is_recorded_with_its_error() {
        let pool = memory_pool().await;
        let effective = future();
        let s = insert(&pool, 1, "AI-92", 12_000, effective, "admin", None)
            .await
            .unwrap();
        claim_due(&pool, effective + 1).await.unwrap();
        mark_failed(&pool, &s.id, "dispatch channel closed")
            .await
            .unwrap();
        let row = get(&pool, &s.id).await.unwrap().unwrap();
        assert_eq!(row.status, ScheduledPriceStatus::Failed);
        assert_eq!(row.error.as_deref(), Some("dispatch channel closed"));
    }
}
