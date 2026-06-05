use anyhow::Result;
use sqlx::{QueryBuilder, SqlitePool};
use types::{Transaction, TxStatus, TxSummary};

/// SQL fragment: statuses that count toward revenue / shift totals.
#[allow(dead_code)]
pub const REVENUE_STATUS_SQL: &str = "('COMPLETED', 'STOPPED', 'CONTINUED_FROM')";

fn status_str(status: &TxStatus) -> String {
    match status {
        TxStatus::Completed => "COMPLETED".into(),
        TxStatus::Aborted => "ABORTED".into(),
        TxStatus::Stopped => "STOPPED".into(),
        TxStatus::ContinuedFrom(_) => "CONTINUED_FROM".into(),
    }
}

pub async fn insert_transaction(pool: &SqlitePool, tx: &Transaction) -> Result<()> {
    sqlx::query(
        r#"INSERT INTO transactions
        (id, fp_id, label, address_byte, started_at, completed_at, volume, amount, price, nozzle_index, product_id, product_name, status, shift_id, parent_tx_id, combined_volume, combined_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&tx.id)
    .bind(&tx.fp_id)
    .bind(&tx.label)
    .bind(tx.address_byte as i64)
    .bind(tx.started_at)
    .bind(tx.completed_at)
    .bind(tx.volume)
    .bind(tx.amount as i64)
    .bind(tx.price as i64)
    .bind(tx.nozzle_index as i64)
    .bind(tx.product_id as i64)
    .bind(&tx.product_name)
    .bind(status_str(&tx.status))
    .bind(&tx.shift_id)
    .bind(&tx.parent_tx_id)
    .bind(tx.combined_volume)
    .bind(tx.combined_amount as i64)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn abort_stopped_transaction(pool: &SqlitePool, stopped_tx_id: &str) -> Result<bool> {
    let r = sqlx::query(
        r#"UPDATE transactions
           SET status = 'ABORTED', completed_at = COALESCE(completed_at, ?)
           WHERE id = ? AND status = 'STOPPED'"#,
    )
    .bind(chrono::Utc::now().timestamp_millis())
    .bind(stopped_tx_id)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

/// Touch a paused (`STOPPED`) row when the sale ends without changing status (fuel was dispensed).
pub async fn touch_stopped_transaction(pool: &SqlitePool, tx: &Transaction) -> Result<bool> {
    let r = sqlx::query(
        r#"UPDATE transactions
           SET completed_at = COALESCE(completed_at, ?),
               volume = ?,
               amount = ?,
               combined_volume = ?,
               combined_amount = ?
           WHERE id = ? AND status = 'STOPPED'"#,
    )
    .bind(chrono::Utc::now().timestamp_millis())
    .bind(tx.volume)
    .bind(tx.amount as i64)
    .bind(tx.combined_volume)
    .bind(tx.combined_amount as i64)
    .bind(&tx.id)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

/// Merge a completed continuation into its parent STOPPED row.
/// Updates the parent to COMPLETED with the combined totals so history shows
/// a single entry rather than a STOPPED + CONTINUED_FROM pair.
pub async fn merge_continuation_into_parent(
    pool: &SqlitePool,
    parent_tx_id: &str,
    combined_volume: f64,
    combined_amount: u64,
) -> Result<bool> {
    let r = sqlx::query(
        r#"UPDATE transactions
           SET status         = 'COMPLETED',
               completed_at   = ?,
               volume         = ?,
               amount         = ?,
               combined_volume = ?,
               combined_amount = ?
           WHERE id = ? AND status = 'STOPPED'"#,
    )
    .bind(chrono::Utc::now().timestamp_millis())
    .bind(combined_volume)
    .bind(combined_amount as i64)
    .bind(combined_volume)
    .bind(combined_amount as i64)
    .bind(parent_tx_id)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn persist_closed_transaction(pool: &SqlitePool, tx: &Transaction) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    match &tx.status {
        TxStatus::Aborted => {
            if abort_stopped_transaction(pool, &tx.id).await? {
                return Ok(());
            }
        }
        TxStatus::Stopped => {
            if touch_stopped_transaction(pool, tx).await? {
                return Ok(());
            }
        }
        TxStatus::Completed => {
            if finalize_stopped_transaction(pool, &tx.id).await? {
                return Ok(());
            }
        }
        TxStatus::ContinuedFrom(parent_id) => {
            // Merge the combined totals into the parent STOPPED row → single history entry.
            if merge_continuation_into_parent(
                pool,
                parent_id,
                tx.combined_volume,
                tx.combined_amount,
            )
            .await?
            {
                return Ok(());
            }
            // Parent not found / not STOPPED — fall back to inserting a new row.
        }
    }
    let _ = now;
    insert_transaction(pool, tx).await
}

pub async fn finalize_stopped_transaction(pool: &SqlitePool, stopped_tx_id: &str) -> Result<bool> {
    let r = sqlx::query(
        r#"UPDATE transactions
           SET status = 'COMPLETED', completed_at = COALESCE(completed_at, ?)
           WHERE id = ? AND status = 'STOPPED'"#,
    )
    .bind(chrono::Utc::now().timestamp_millis())
    .bind(stopped_tx_id)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn list_transactions(
    pool: &SqlitePool,
    limit: i64,
    offset: i64,
    fp_id: Option<&str>,
    shift_id: Option<&str>,
    statuses: &[&str],
    from_ms: Option<i64>,
    until_ms: Option<i64>,
) -> Result<Vec<Transaction>> {
    let select = r#"SELECT id, fp_id, label, address_byte, started_at, completed_at, volume, amount, price, nozzle_index, product_id, product_name, status, shift_id, operator_name, parent_tx_id, combined_volume, combined_amount FROM transactions WHERE 1=1"#;
    let mut qb: QueryBuilder<sqlx::Sqlite> = QueryBuilder::new(select);
    if let Some(fp) = fp_id {
        qb.push(" AND fp_id = ").push_bind(fp);
    }
    if let Some(sid) = shift_id {
        qb.push(" AND shift_id = ").push_bind(sid);
    }
    if !statuses.is_empty() {
        qb.push(" AND status IN (");
        {
            let mut sep = qb.separated(", ");
            for s in statuses {
                sep.push_bind(*s);
            }
        }
        qb.push(")");
    }
    if let Some(from) = from_ms {
        qb.push(" AND started_at >= ").push_bind(from);
    }
    if let Some(until) = until_ms {
        qb.push(" AND started_at < ").push_bind(until);
    }
    qb.push(" ORDER BY started_at DESC LIMIT ").push_bind(limit);
    qb.push(" OFFSET ").push_bind(offset);
    let rows = qb.build_query_as::<TxRow>().fetch_all(pool).await?;
    Ok(rows.into_iter().map(|r| r.into_transaction()).collect())
}

pub async fn summarize_transactions(
    pool: &SqlitePool,
    fp_id: Option<&str>,
    shift_id: Option<&str>,
    statuses: &[&str],
    from_ms: Option<i64>,
    until_ms: Option<i64>,
) -> Result<TxSummary> {
    #[derive(sqlx::FromRow)]
    struct SummaryRow {
        count: i64,
        total_volume: f64,
        total_amount: i64,
    }
    let mut qb: QueryBuilder<sqlx::Sqlite> = QueryBuilder::new(
        "SELECT COUNT(*) as count, COALESCE(SUM(volume), 0.0) as total_volume, COALESCE(SUM(amount), 0) as total_amount FROM transactions WHERE 1=1",
    );
    if let Some(fp) = fp_id {
        qb.push(" AND fp_id = ").push_bind(fp);
    }
    if let Some(sid) = shift_id {
        qb.push(" AND shift_id = ").push_bind(sid);
    }
    if !statuses.is_empty() {
        qb.push(" AND status IN (");
        {
            let mut sep = qb.separated(", ");
            for s in statuses {
                sep.push_bind(*s);
            }
        }
        qb.push(")");
    }
    if let Some(from) = from_ms {
        qb.push(" AND started_at >= ").push_bind(from);
    }
    if let Some(until) = until_ms {
        qb.push(" AND started_at < ").push_bind(until);
    }
    let row = qb.build_query_as::<SummaryRow>().fetch_one(pool).await?;
    Ok(TxSummary {
        count: row.count,
        total_volume: row.total_volume,
        total_amount: row.total_amount,
    })
}

pub async fn get_transaction(pool: &SqlitePool, id: &str) -> Result<Option<Transaction>> {
    let row = sqlx::query_as::<_, TxRow>(
        r#"SELECT id, fp_id, label, address_byte, started_at, completed_at, volume, amount, price, nozzle_index, product_id, product_name, status, shift_id, operator_name, parent_tx_id, combined_volume, combined_amount
           FROM transactions WHERE id = ?"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.into_transaction()))
}

#[derive(sqlx::FromRow)]
struct TxRow {
    id: String,
    fp_id: String,
    label: String,
    address_byte: i64,
    started_at: i64,
    completed_at: Option<i64>,
    volume: f64,
    amount: i64,
    price: i64,
    nozzle_index: i64,
    product_id: i64,
    product_name: String,
    status: String,
    shift_id: Option<String>,
    operator_name: Option<String>,
    parent_tx_id: Option<String>,
    combined_volume: f64,
    combined_amount: i64,
}

impl TxRow {
    fn into_transaction(self) -> Transaction {
        let st = match self.status.as_str() {
            "ABORTED" => TxStatus::Aborted,
            "STOPPED" => TxStatus::Stopped,
            "CONTINUED_FROM" => TxStatus::ContinuedFrom(
                self.parent_tx_id
                    .clone()
                    .unwrap_or_else(|| "unknown".into()),
            ),
            _ => TxStatus::Completed,
        };
        Transaction {
            id: self.id,
            fp_id: self.fp_id,
            label: self.label,
            address_byte: self.address_byte as u8,
            started_at: self.started_at,
            completed_at: self.completed_at,
            volume: self.volume,
            amount: self.amount as u64,
            price: self.price as u32,
            nozzle_index: self.nozzle_index as u8,
            product_id: self.product_id as u8,
            product_name: self.product_name,
            status: st,
            shift_id: self.shift_id,
            operator_name: self.operator_name,
            parent_tx_id: self.parent_tx_id,
            combined_volume: self.combined_volume,
            combined_amount: self.combined_amount as u64,
        }
    }
}
