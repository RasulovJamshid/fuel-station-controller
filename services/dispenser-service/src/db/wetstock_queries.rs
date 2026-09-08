//! Wetstock: fuel deliveries and book-vs-measured reconciliation.
//!
//! Book stock is `opening + deliveries − sales`. Comparing it against the measured
//! (ATG) volume is what surfaces leaks, unrecorded draw-off, and meter drift. Without
//! delivery records the book only ever falls, so the comparison is meaningless — which
//! is why deliveries and reconciliation live together in this module.

use anyhow::{anyhow, Result};
use sqlx::SqlitePool;
use types::{FuelDelivery, VarianceStatus, WetstockReconciliation};
use uuid::Uuid;

/// Variance beyond this fraction of throughput is a warning.
pub const VARIANCE_WARN_PCT: f64 = 0.5;
/// Variance beyond this fraction of throughput is an alarm (investigate for a leak).
pub const VARIANCE_ALARM_PCT: f64 = 1.0;
/// Below this throughput a percentage is statistically meaningless, so only the
/// absolute litre figure drives the status.
const MIN_THROUGHPUT_FOR_PCT_L: f64 = 200.0;
/// Absolute tolerance applied on low-throughput periods.
const LOW_THROUGHPUT_TOLERANCE_L: f64 = 20.0;

fn status_str(s: VarianceStatus) -> &'static str {
    match s {
        VarianceStatus::Ok => "OK",
        VarianceStatus::Warn => "WARN",
        VarianceStatus::Alarm => "ALARM",
    }
}

fn parse_status(s: &str) -> VarianceStatus {
    match s {
        "ALARM" => VarianceStatus::Alarm,
        "WARN" => VarianceStatus::Warn,
        _ => VarianceStatus::Ok,
    }
}

/// Classify a variance against throughput.
///
/// Percentage thresholds only apply once enough fuel has moved to make a percentage
/// meaningful; small periods fall back to a flat litre tolerance so that a quiet tank
/// doesn't alarm on rounding.
pub fn classify_variance(variance_l: f64, throughput_l: f64) -> (f64, VarianceStatus) {
    let abs = variance_l.abs();
    if throughput_l < MIN_THROUGHPUT_FOR_PCT_L {
        let status = if abs > LOW_THROUGHPUT_TOLERANCE_L {
            VarianceStatus::Warn
        } else {
            VarianceStatus::Ok
        };
        return (0.0, status);
    }
    let pct = variance_l / throughput_l * 100.0;
    let status = if pct.abs() >= VARIANCE_ALARM_PCT {
        VarianceStatus::Alarm
    } else if pct.abs() >= VARIANCE_WARN_PCT {
        VarianceStatus::Warn
    } else {
        VarianceStatus::Ok
    };
    (pct, status)
}

// ── Deliveries ────────────────────────────────────────────────────────────

pub async fn insert_delivery(pool: &SqlitePool, d: &FuelDelivery) -> Result<()> {
    if d.delivered_l <= 0.0 {
        return Err(anyhow!("delivered_l must be greater than zero"));
    }
    sqlx::query(
        r#"INSERT INTO fuel_deliveries (
               id, product_id, product_name, tank_label, delivered_at, document_ref, supplier,
               ordered_l, delivered_l, tank_before_l, tank_after_l, temperature_c,
               price_per_l, shift_id, operator_name, notes, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&d.id)
    .bind(d.product_id as i64)
    .bind(&d.product_name)
    .bind(&d.tank_label)
    .bind(d.delivered_at)
    .bind(&d.document_ref)
    .bind(&d.supplier)
    .bind(d.ordered_l)
    .bind(d.delivered_l)
    .bind(d.tank_before_l)
    .bind(d.tank_after_l)
    .bind(d.temperature_c)
    .bind(d.price_per_l as i64)
    .bind(&d.shift_id)
    .bind(&d.operator_name)
    .bind(&d.notes)
    .bind(d.created_at)
    .execute(pool)
    .await?;
    enqueue_delivery(pool, d).await;
    Ok(())
}

/// Deliveries are a final-state mutation, so they must reach the sync queue or the
/// backend's stock figures silently drift from the station's.
async fn enqueue_delivery(pool: &SqlitePool, d: &FuelDelivery) {
    match serde_json::to_value(d) {
        Ok(payload) => {
            if let Err(e) = crate::sync::enqueue(pool, "fuel_delivery", &d.id, &payload).await {
                tracing::warn!(id = %d.id, ?e, "sync: enqueue fuel_delivery failed");
            }
        }
        Err(e) => tracing::warn!(id = %d.id, ?e, "sync: fuel_delivery serialize failed"),
    }
}

#[derive(sqlx::FromRow)]
struct DeliveryRow {
    id: String,
    product_id: i64,
    product_name: String,
    tank_label: String,
    delivered_at: i64,
    document_ref: Option<String>,
    supplier: Option<String>,
    ordered_l: f64,
    delivered_l: f64,
    tank_before_l: Option<f64>,
    tank_after_l: Option<f64>,
    temperature_c: Option<f64>,
    price_per_l: i64,
    shift_id: Option<String>,
    operator_name: Option<String>,
    notes: Option<String>,
    created_at: i64,
}

impl From<DeliveryRow> for FuelDelivery {
    fn from(r: DeliveryRow) -> Self {
        // Measured gain minus documented volume: positive means the tank rose more
        // than the paperwork claims, negative is a short delivery.
        let variance_l = match (r.tank_before_l, r.tank_after_l) {
            (Some(before), Some(after)) => Some((after - before) - r.delivered_l),
            _ => None,
        };
        FuelDelivery {
            id: r.id,
            product_id: r.product_id.clamp(0, 255) as u8,
            product_name: r.product_name,
            tank_label: r.tank_label,
            delivered_at: r.delivered_at,
            document_ref: r.document_ref,
            supplier: r.supplier,
            ordered_l: r.ordered_l,
            delivered_l: r.delivered_l,
            tank_before_l: r.tank_before_l,
            tank_after_l: r.tank_after_l,
            variance_l,
            temperature_c: r.temperature_c,
            price_per_l: r.price_per_l.max(0) as u32,
            shift_id: r.shift_id,
            operator_name: r.operator_name,
            notes: r.notes,
            created_at: r.created_at,
        }
    }
}

const DELIVERY_COLS: &str = r#"id, product_id, product_name, tank_label, delivered_at,
    document_ref, supplier, ordered_l, delivered_l, tank_before_l, tank_after_l,
    temperature_c, price_per_l, shift_id, operator_name, notes, created_at"#;

pub async fn list_deliveries(
    pool: &SqlitePool,
    product_id: Option<u8>,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    limit: i64,
) -> Result<Vec<FuelDelivery>> {
    let sql = format!(
        r#"SELECT {DELIVERY_COLS} FROM fuel_deliveries
           WHERE (?1 IS NULL OR product_id = ?1)
             AND (?2 IS NULL OR delivered_at >= ?2)
             AND (?3 IS NULL OR delivered_at <= ?3)
           ORDER BY delivered_at DESC LIMIT ?4"#
    );
    let rows: Vec<DeliveryRow> = sqlx::query_as(&sql)
        .bind(product_id.map(|p| p as i64))
        .bind(from_ms)
        .bind(to_ms)
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn get_delivery(pool: &SqlitePool, id: &str) -> Result<Option<FuelDelivery>> {
    let sql = format!("SELECT {DELIVERY_COLS} FROM fuel_deliveries WHERE id = ?");
    let row: Option<DeliveryRow> = sqlx::query_as(&sql).bind(id).fetch_optional(pool).await?;
    Ok(row.map(Into::into))
}

/// Total litres delivered into one tank over a period (inclusive bounds).
pub async fn delivered_litres_between(
    pool: &SqlitePool,
    product_id: u8,
    from_ms: i64,
    to_ms: i64,
) -> Result<f64> {
    let (total,): (f64,) = sqlx::query_as(
        r#"SELECT COALESCE(SUM(delivered_l), 0.0) FROM fuel_deliveries
           WHERE product_id = ? AND delivered_at >= ? AND delivered_at <= ?"#,
    )
    .bind(product_id as i64)
    .bind(from_ms)
    .bind(to_ms)
    .fetch_one(pool)
    .await?;
    Ok(total)
}

/// Total litres sold for one product over a period, counted the same way shift
/// totals count them (CONTINUED_FROM contributes its segment only).
pub async fn sold_litres_between(
    pool: &SqlitePool,
    product_id: u8,
    from_ms: i64,
    to_ms: i64,
) -> Result<f64> {
    let (total,): (f64,) = sqlx::query_as(
        r#"SELECT COALESCE(SUM(CASE
                    WHEN status = 'CONTINUED_FROM' THEN volume
                    WHEN combined_volume > 0 THEN combined_volume
                    ELSE volume
                  END), 0.0)
           FROM transactions
           WHERE product_id = ?
             AND status IN ('COMPLETED', 'STOPPED', 'CONTINUED_FROM')
             AND COALESCE(completed_at, started_at) >= ?
             AND COALESCE(completed_at, started_at) <= ?"#,
    )
    .bind(product_id as i64)
    .bind(from_ms)
    .bind(to_ms)
    .fetch_one(pool)
    .await?;
    Ok(total)
}

// ── Reconciliation ────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct ReconRow {
    id: String,
    product_id: i64,
    product_name: String,
    tank_label: String,
    period_start: i64,
    period_end: i64,
    opening_l: f64,
    deliveries_l: f64,
    sales_l: f64,
    book_closing_l: f64,
    measured_l: f64,
    variance_l: f64,
    variance_pct: f64,
    status: String,
    shift_id: Option<String>,
    measured_available: i64,
    created_at: i64,
}

impl From<ReconRow> for WetstockReconciliation {
    fn from(r: ReconRow) -> Self {
        WetstockReconciliation {
            id: r.id,
            product_id: r.product_id.clamp(0, 255) as u8,
            product_name: r.product_name,
            tank_label: r.tank_label,
            period_start: r.period_start,
            period_end: r.period_end,
            opening_l: r.opening_l,
            deliveries_l: r.deliveries_l,
            sales_l: r.sales_l,
            book_closing_l: r.book_closing_l,
            measured_l: r.measured_l,
            variance_l: r.variance_l,
            variance_pct: r.variance_pct,
            status: parse_status(&r.status),
            shift_id: r.shift_id,
            measured_available: r.measured_available != 0,
            created_at: r.created_at,
        }
    }
}

const RECON_COLS: &str = r#"id, product_id, product_name, tank_label, period_start, period_end,
    opening_l, deliveries_l, sales_l, book_closing_l, measured_l, variance_l, variance_pct,
    status, shift_id, measured_available, created_at"#;

/// Most recent reconciliation for a tank — the anchor for the next period's opening.
pub async fn last_reconciliation(
    pool: &SqlitePool,
    product_id: u8,
) -> Result<Option<WetstockReconciliation>> {
    let sql = format!(
        r#"SELECT {RECON_COLS} FROM wetstock_reconciliations
           WHERE product_id = ? ORDER BY period_end DESC LIMIT 1"#
    );
    let row: Option<ReconRow> = sqlx::query_as(&sql)
        .bind(product_id as i64)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(Into::into))
}

pub async fn list_reconciliations(
    pool: &SqlitePool,
    product_id: Option<u8>,
    limit: i64,
) -> Result<Vec<WetstockReconciliation>> {
    let sql = format!(
        r#"SELECT {RECON_COLS} FROM wetstock_reconciliations
           WHERE (?1 IS NULL OR product_id = ?1)
           ORDER BY period_end DESC LIMIT ?2"#
    );
    let rows: Vec<ReconRow> = sqlx::query_as(&sql)
        .bind(product_id.map(|p| p as i64))
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn insert_reconciliation(
    pool: &SqlitePool,
    r: &WetstockReconciliation,
    notes: Option<&str>,
) -> Result<()> {
    sqlx::query(
        r#"INSERT INTO wetstock_reconciliations (
               id, product_id, product_name, tank_label, period_start, period_end,
               opening_l, deliveries_l, sales_l, book_closing_l, measured_l,
               variance_l, variance_pct, status, shift_id, measured_available, notes, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&r.id)
    .bind(r.product_id as i64)
    .bind(&r.product_name)
    .bind(&r.tank_label)
    .bind(r.period_start)
    .bind(r.period_end)
    .bind(r.opening_l)
    .bind(r.deliveries_l)
    .bind(r.sales_l)
    .bind(r.book_closing_l)
    .bind(r.measured_l)
    .bind(r.variance_l)
    .bind(r.variance_pct)
    .bind(status_str(r.status))
    .bind(&r.shift_id)
    .bind(i64::from(r.measured_available))
    .bind(notes)
    .bind(r.created_at)
    .execute(pool)
    .await?;
    match serde_json::to_value(r) {
        Ok(payload) => {
            if let Err(e) =
                crate::sync::enqueue(pool, "wetstock_reconciliation", &r.id, &payload).await
            {
                tracing::warn!(id = %r.id, ?e, "sync: enqueue wetstock_reconciliation failed");
            }
        }
        Err(e) => tracing::warn!(id = %r.id, ?e, "sync: reconciliation serialize failed"),
    }
    Ok(())
}

/// Inputs the caller must supply because they come from config/ATG, not the DB.
pub struct TankContext {
    pub product_id: u8,
    pub product_name: String,
    pub tank_label: String,
    /// Live ATG volume. `None` when no probe reading is available.
    pub measured_l: Option<f64>,
    /// Fallback opening volume when the tank has never been reconciled — the
    /// configured `current_l`.
    pub configured_opening_l: f64,
}

/// Compute (without persisting) the reconciliation for one tank over a period.
///
/// The opening balance is the previous reconciliation's *measured* closing volume
/// when one exists, so each period is anchored to a real dip rather than compounding
/// book drift forward forever.
pub async fn compute_reconciliation(
    pool: &SqlitePool,
    ctx: &TankContext,
    period_start: Option<i64>,
    period_end: i64,
    shift_id: Option<String>,
) -> Result<WetstockReconciliation> {
    let previous = last_reconciliation(pool, ctx.product_id).await?;
    let start = period_start
        .or_else(|| previous.as_ref().map(|p| p.period_end))
        .unwrap_or(0);
    if start > period_end {
        return Err(anyhow!("period_start is after period_end"));
    }
    let opening_l = previous
        .as_ref()
        .filter(|p| p.measured_available)
        .map(|p| p.measured_l)
        .unwrap_or(ctx.configured_opening_l);

    let deliveries_l = delivered_litres_between(pool, ctx.product_id, start, period_end).await?;
    let sales_l = sold_litres_between(pool, ctx.product_id, start, period_end).await?;
    let book_closing_l = opening_l + deliveries_l - sales_l;

    let measured_available = ctx.measured_l.is_some();
    // With no probe reading there is nothing to compare against, so report a zero
    // variance and let `measured_available` tell the reader the check did not run.
    let measured_l = ctx.measured_l.unwrap_or(book_closing_l);
    let variance_l = measured_l - book_closing_l;
    let throughput = deliveries_l + sales_l;
    let (variance_pct, status) = if measured_available {
        classify_variance(variance_l, throughput)
    } else {
        (0.0, VarianceStatus::Ok)
    };

    Ok(WetstockReconciliation {
        id: Uuid::new_v4().to_string(),
        product_id: ctx.product_id,
        product_name: ctx.product_name.clone(),
        tank_label: ctx.tank_label.clone(),
        period_start: start,
        period_end,
        opening_l,
        deliveries_l,
        sales_l,
        book_closing_l,
        measured_l,
        variance_l,
        variance_pct,
        status,
        shift_id,
        measured_available,
        created_at: chrono::Utc::now().timestamp_millis(),
    })
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

    fn delivery(id: &str, product_id: u8, litres: f64, at: i64) -> FuelDelivery {
        FuelDelivery {
            id: id.into(),
            product_id,
            product_name: "AI-92".into(),
            tank_label: "T1".into(),
            delivered_at: at,
            document_ref: Some("WB-1".into()),
            supplier: Some("UNG".into()),
            ordered_l: litres,
            delivered_l: litres,
            tank_before_l: Some(1_000.0),
            tank_after_l: Some(1_000.0 + litres),
            variance_l: None,
            temperature_c: Some(15.0),
            price_per_l: 9_000,
            shift_id: None,
            operator_name: Some("op".into()),
            notes: None,
            created_at: at,
        }
    }

    fn ctx(measured: Option<f64>) -> TankContext {
        TankContext {
            product_id: 1,
            product_name: "AI-92".into(),
            tank_label: "T1".into(),
            measured_l: measured,
            configured_opening_l: 5_000.0,
        }
    }

    #[tokio::test]
    async fn delivery_variance_is_measured_gain_minus_document() {
        let pool = memory_pool().await;
        let mut d = delivery("d1", 1, 5_000.0, 1_000);
        // Tank only rose by 4,950 L against a 5,000 L waybill: 50 L short.
        d.tank_after_l = Some(5_950.0);
        insert_delivery(&pool, &d).await.unwrap();
        let stored = get_delivery(&pool, "d1").await.unwrap().unwrap();
        assert!((stored.variance_l.unwrap() - -50.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn delivery_is_enqueued_for_backend_sync() {
        let pool = memory_pool().await;
        insert_delivery(&pool, &delivery("d1", 1, 5_000.0, 1_000))
            .await
            .unwrap();
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'fuel_delivery'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(n, 1, "deliveries must reach the sync queue");
    }

    #[tokio::test]
    async fn book_stock_is_opening_plus_deliveries_minus_sales() {
        let pool = memory_pool().await;
        insert_delivery(&pool, &delivery("d1", 1, 5_000.0, 1_000))
            .await
            .unwrap();
        sqlx::query(
            r#"INSERT INTO transactions (id, fp_id, label, address_byte, started_at, completed_at,
                   volume, amount, price, nozzle_index, product_id, product_name, status,
                   combined_volume, combined_amount)
               VALUES ('t1','FP1','1',1,1500,1500,300.0,0,0,1,1,'AI-92','COMPLETED',300.0,0)"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        // Measured exactly matches the book: 5000 + 5000 - 300.
        let r = compute_reconciliation(&pool, &ctx(Some(9_700.0)), Some(0), 2_000, None)
            .await
            .unwrap();
        assert!((r.opening_l - 5_000.0).abs() < 1e-9);
        assert!((r.deliveries_l - 5_000.0).abs() < 1e-9);
        assert!((r.sales_l - 300.0).abs() < 1e-9);
        assert!((r.book_closing_l - 9_700.0).abs() < 1e-9);
        assert!(r.variance_l.abs() < 1e-9);
        assert_eq!(r.status, VarianceStatus::Ok);
    }

    #[tokio::test]
    async fn large_negative_variance_alarms() {
        let pool = memory_pool().await;
        insert_delivery(&pool, &delivery("d1", 1, 5_000.0, 1_000))
            .await
            .unwrap();
        // 100 L missing against 5,000 L throughput = 2%, past the 1% alarm line.
        let r = compute_reconciliation(&pool, &ctx(Some(9_900.0)), Some(0), 2_000, None)
            .await
            .unwrap();
        assert!((r.variance_l - -100.0).abs() < 1e-9);
        assert_eq!(r.status, VarianceStatus::Alarm);
    }

    #[tokio::test]
    async fn next_period_opens_from_previous_measured_dip() {
        let pool = memory_pool().await;
        let first = compute_reconciliation(&pool, &ctx(Some(4_800.0)), Some(0), 1_000, None)
            .await
            .unwrap();
        insert_reconciliation(&pool, &first, None).await.unwrap();

        // Opening must follow the measured 4,800 L, not the configured 5,000 L,
        // so book drift is not carried forward.
        let second = compute_reconciliation(&pool, &ctx(Some(4_800.0)), None, 2_000, None)
            .await
            .unwrap();
        assert!((second.opening_l - 4_800.0).abs() < 1e-9);
        assert_eq!(second.period_start, 1_000);
    }

    #[tokio::test]
    async fn missing_atg_reading_reports_unavailable_not_a_false_variance() {
        let pool = memory_pool().await;
        insert_delivery(&pool, &delivery("d1", 1, 5_000.0, 1_000))
            .await
            .unwrap();
        let r = compute_reconciliation(&pool, &ctx(None), Some(0), 2_000, None)
            .await
            .unwrap();
        assert!(!r.measured_available);
        assert!(r.variance_l.abs() < 1e-9, "no probe means no variance claim");
        assert_eq!(r.status, VarianceStatus::Ok);
    }

    #[test]
    fn small_throughput_uses_absolute_tolerance_not_percentage() {
        // 10 L on 50 L of throughput is 20%, but too small a sample to alarm on.
        let (pct, status) = classify_variance(-10.0, 50.0);
        assert_eq!(pct, 0.0);
        assert_eq!(status, VarianceStatus::Ok);
        // Past the flat tolerance it still warns.
        let (_, status) = classify_variance(-25.0, 50.0);
        assert_eq!(status, VarianceStatus::Warn);
    }
}
