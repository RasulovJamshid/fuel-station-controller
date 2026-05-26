//! Repairs SQLite schemas when an older DB file is missing columns from later migrations.

use anyhow::Result;
use sqlx::SqlitePool;

/// Ensures `fp_nozzles` has `wayne_product_code` (migration 006).
/// Safe to call on every startup — no-op when column already exists.
pub async fn ensure_fp_nozzles_schema(pool: &SqlitePool) -> Result<()> {
    let cols: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_table_info('fp_nozzles')")
            .fetch_all(pool)
            .await?;
    if !cols.iter().any(|c| c == "wayne_product_code") {
        sqlx::query(
            "ALTER TABLE fp_nozzles ADD COLUMN wayne_product_code INTEGER NOT NULL DEFAULT 0",
        )
        .execute(pool)
        .await?;
        tracing::info!("repaired fp_nozzles: added wayne_product_code column");
    }
    Ok(())
}

/// Ensures `price_history` has admin audit columns (migration 005).
/// Safe to call on every startup — no-op when columns already exist.
pub async fn ensure_price_history_columns(pool: &SqlitePool) -> Result<()> {
    let cols: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_table_info('price_history')")
            .fetch_all(pool)
            .await?;

    if !cols.iter().any(|c| c == "product_name") {
        sqlx::query("ALTER TABLE price_history ADD COLUMN product_name TEXT NOT NULL DEFAULT ''")
            .execute(pool)
            .await?;
        tracing::info!("repaired price_history: added product_name column");
    }
    if !cols.iter().any(|c| c == "changed_by") {
        sqlx::query(
            "ALTER TABLE price_history ADD COLUMN changed_by TEXT NOT NULL DEFAULT 'system'",
        )
        .execute(pool)
        .await?;
        tracing::info!("repaired price_history: added changed_by column");
    }
    Ok(())
}
