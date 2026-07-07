use anyhow::{anyhow, Result};
use sqlx::SqlitePool;
use types::{
    CreateOperatorCmd, EndShiftCmd, HandoverCmd, Operator, Shift, ShiftPositionTotal, ShiftStatus,
    StartShiftCmd,
};

#[derive(sqlx::FromRow)]
struct ShiftRow {
    id: String,
    operator_id: Option<String>,
    operator_name: String,
    shift_name: Option<String>,
    scheduled_start: Option<String>,
    scheduled_end: Option<String>,
    started_at: i64,
    ended_at: Option<i64>,
    total_transactions: i64,
    total_volume: f64,
    total_amount: i64,
    status: String,
    notes: Option<String>,
}

fn row_status(s: &str) -> ShiftStatus {
    if s.eq_ignore_ascii_case("CLOSED") {
        ShiftStatus::Closed
    } else {
        ShiftStatus::Active
    }
}

impl ShiftRow {
    fn into_shift(self, position_totals: Vec<ShiftPositionTotal>) -> Shift {
        Shift {
            id: self.id,
            operator_id: self.operator_id,
            operator_name: self.operator_name,
            shift_name: self.shift_name,
            scheduled_start: self.scheduled_start,
            scheduled_end: self.scheduled_end,
            started_at: self.started_at,
            ended_at: self.ended_at,
            total_transactions: self.total_transactions.clamp(0, i64::from(u32::MAX)) as u32,
            total_volume: self.total_volume,
            total_amount: self.total_amount.max(0) as u64,
            status: row_status(&self.status),
            notes: self.notes,
            position_totals,
        }
    }
}

pub async fn load_active_shift(pool: &SqlitePool) -> Result<Option<Shift>> {
    let row = sqlx::query_as::<_, ShiftRow>(
        r#"SELECT id, operator_id, operator_name, shift_name, scheduled_start, scheduled_end,
                  started_at, ended_at, total_transactions, total_volume, total_amount, status, notes
           FROM shifts WHERE status = 'ACTIVE' AND ended_at IS NULL
           ORDER BY started_at DESC LIMIT 1"#,
    )
    .fetch_optional(pool)
    .await?;
    Ok(match row {
        Some(r) => {
            let id = r.id.clone();
            Some(r.into_shift(position_totals_for_shift(pool, &id).await?))
        }
        None => None,
    })
}

pub async fn get_shift(pool: &SqlitePool, id: &str) -> Result<Option<Shift>> {
    let row = sqlx::query_as::<_, ShiftRow>(
        r#"SELECT id, operator_id, operator_name, shift_name, scheduled_start, scheduled_end,
                  started_at, ended_at, total_transactions, total_volume, total_amount, status, notes
           FROM shifts WHERE id = ?"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(match row {
        Some(r) => {
            let sid = r.id.clone();
            Some(r.into_shift(position_totals_for_shift(pool, &sid).await?))
        }
        None => None,
    })
}

pub async fn list_shifts(
    pool: &SqlitePool,
    limit: i64,
    offset: i64,
    status: Option<&str>,
) -> Result<Vec<Shift>> {
    let rows: Vec<ShiftRow> = if let Some(st) = status {
        sqlx::query_as::<_, ShiftRow>(
            r#"SELECT id, operator_id, operator_name, shift_name, scheduled_start, scheduled_end,
                      started_at, ended_at, total_transactions, total_volume, total_amount, status, notes
               FROM shifts WHERE status = ? ORDER BY started_at DESC LIMIT ? OFFSET ?"#,
        )
        .bind(st)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, ShiftRow>(
            r#"SELECT id, operator_id, operator_name, shift_name, scheduled_start, scheduled_end,
                      started_at, ended_at, total_transactions, total_volume, total_amount, status, notes
               FROM shifts ORDER BY started_at DESC LIMIT ? OFFSET ?"#,
        )
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?
    };
    let mut out = Vec::new();
    for r in rows {
        let sid = r.id.clone();
        out.push(r.into_shift(position_totals_for_shift(pool, &sid).await?));
    }
    Ok(out)
}

async fn position_totals_for_shift(
    pool: &SqlitePool,
    shift_id: &str,
) -> Result<Vec<ShiftPositionTotal>> {
    let rows: Vec<(String, String, i64, f64, i64)> = sqlx::query_as(
        // CONTINUED_FROM rows credit segment volume only (STOPPED parent already
        // counted the base). COMPLETED/STOPPED use combined_volume for accurate totals.
        r#"SELECT fp_id, label,
                  COUNT(*) as c,
                  COALESCE(SUM(CASE
                    WHEN status = 'CONTINUED_FROM' THEN volume
                    WHEN combined_volume > 0 THEN combined_volume
                    ELSE volume
                  END), 0) as vol,
                  COALESCE(SUM(CASE
                    WHEN status = 'CONTINUED_FROM' THEN amount
                    WHEN combined_amount > 0 THEN combined_amount
                    ELSE amount
                  END), 0) as amt
           FROM transactions
           WHERE shift_id = ? AND status IN ('COMPLETED', 'STOPPED', 'CONTINUED_FROM')
           GROUP BY fp_id, label"#,
    )
    .bind(shift_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(fp_id, label, c, vol, amt)| ShiftPositionTotal {
            fp_id,
            label,
            transactions_count: c.clamp(0, i64::from(u32::MAX)) as u32,
            total_volume: vol,
            total_amount: amt.max(0) as u64,
        })
        .collect())
}

async fn aggregate_totals_for_shift(pool: &SqlitePool, shift_id: &str) -> Result<(i64, f64, i64)> {
    sqlx::query_as(
        r#"SELECT COUNT(CASE WHEN status != 'CONTINUED_FROM' THEN 1 END),
                  COALESCE(SUM(CASE
                    WHEN status = 'CONTINUED_FROM' THEN volume
                    WHEN combined_volume > 0 THEN combined_volume
                    ELSE volume
                  END), 0.0),
                  COALESCE(SUM(CASE
                    WHEN status = 'CONTINUED_FROM' THEN amount
                    WHEN combined_amount > 0 THEN combined_amount
                    ELSE amount
                  END), 0)
           FROM transactions
           WHERE shift_id = ? AND status IN ('COMPLETED', 'STOPPED', 'CONTINUED_FROM')"#,
    )
    .bind(shift_id)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn insert_shift(pool: &SqlitePool, shift: &Shift) -> Result<()> {
    let st = match shift.status {
        ShiftStatus::Active => "ACTIVE",
        ShiftStatus::Closed => "CLOSED",
    };
    sqlx::query(
        r#"INSERT INTO shifts (
            id, operator_id, operator_name, shift_name, scheduled_start, scheduled_end,
            started_at, ended_at, total_transactions, total_volume, total_amount, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&shift.id)
    .bind(&shift.operator_id)
    .bind(&shift.operator_name)
    .bind(&shift.shift_name)
    .bind(&shift.scheduled_start)
    .bind(&shift.scheduled_end)
    .bind(shift.started_at)
    .bind(shift.ended_at)
    .bind(shift.total_transactions as i64)
    .bind(shift.total_volume)
    .bind(shift.total_amount as i64)
    .bind(st)
    .bind(&shift.notes)
    .execute(pool)
    .await?;
    enqueue_shift(pool, shift).await;
    Ok(())
}

pub async fn close_shift(
    pool: &SqlitePool,
    id: &str,
    ended_at: i64,
    notes: Option<&str>,
) -> Result<()> {
    sqlx::query(
        r#"UPDATE shifts SET ended_at = ?, status = 'CLOSED', notes = COALESCE(?, notes) WHERE id = ?"#,
    )
    .bind(ended_at)
    .bind(notes)
    .bind(id)
    .execute(pool)
    .await?;
    // Re-fetch and enqueue the closed shift so the backend gets the final state.
    if let Ok(Some(shift)) = get_shift(pool, id).await {
        enqueue_shift(pool, &shift).await;
    }
    Ok(())
}

/// Fire-and-forget sync enqueue for a shift.
async fn enqueue_shift(pool: &SqlitePool, shift: &Shift) {
    let payload = match serde_json::to_value(shift) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("sync: shift serialize error: {e}");
            return;
        }
    };
    if let Err(e) = crate::sync::enqueue(pool, "shift", &shift.id, &payload).await {
        tracing::warn!("sync: enqueue shift {} failed: {e}", shift.id);
    }
}

async fn enqueue_shift_by_id(pool: &SqlitePool, shift_id: &str) {
    if let Ok(Some(shift)) = get_shift(pool, shift_id).await {
        enqueue_shift(pool, &shift).await;
    }
}

pub async fn bump_shift_totals(
    pool: &SqlitePool,
    shift_id: &str,
    volume: f64,
    amount: u64,
    count_transaction: bool,
) -> Result<()> {
    if count_transaction {
        sqlx::query(
            r#"UPDATE shifts SET
                total_transactions = total_transactions + 1,
                total_volume = total_volume + ?,
                total_amount = total_amount + ?
            WHERE id = ?"#,
        )
        .bind(volume)
        .bind(amount as i64)
        .bind(shift_id)
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            r#"UPDATE shifts SET
                total_volume = total_volume + ?,
                total_amount = total_amount + ?
            WHERE id = ?"#,
        )
        .bind(volume)
        .bind(amount as i64)
        .bind(shift_id)
        .execute(pool)
        .await?;
    }
    enqueue_shift_by_id(pool, shift_id).await;
    Ok(())
}

/// Recompute stored shift totals from transaction rows and enqueue changed shifts.
/// Safe on every startup; repairs older DBs where Gilbarco transactions were saved
/// with shift_id but the shift aggregate row stayed at zero.
pub async fn recompute_shift_totals_from_transactions(pool: &SqlitePool) -> Result<u64> {
    let rows: Vec<(String, i64, f64, i64)> =
        sqlx::query_as(r#"SELECT id, total_transactions, total_volume, total_amount FROM shifts"#)
            .fetch_all(pool)
            .await?;

    let mut repaired = 0u64;
    for (id, old_count, old_volume, old_amount) in rows {
        let (count, volume, amount) = aggregate_totals_for_shift(pool, &id).await?;
        let changed =
            old_count != count || old_amount != amount || (old_volume - volume).abs() > 0.000_001;
        if !changed {
            continue;
        }

        sqlx::query(
            r#"UPDATE shifts SET
                   total_transactions = ?,
                   total_volume       = ?,
                   total_amount       = ?
               WHERE id = ?"#,
        )
        .bind(count)
        .bind(volume)
        .bind(amount)
        .bind(&id)
        .execute(pool)
        .await?;

        enqueue_shift_by_id(pool, &id).await;
        repaired += 1;
    }

    Ok(repaired)
}

pub async fn close_all_active_shifts(pool: &SqlitePool, ended_at: i64) -> Result<u64> {
    // Capture the ids first so we can enqueue each closed shift for sync after the
    // bulk update — otherwise these closes never reach the backend and the shifts
    // stay ACTIVE on the server admin (unlike the single-shift `close_shift` path).
    let ids: Vec<String> =
        sqlx::query_scalar(r#"SELECT id FROM shifts WHERE status = 'ACTIVE' AND ended_at IS NULL"#)
            .fetch_all(pool)
            .await?;

    let r = sqlx::query(
        r#"UPDATE shifts SET ended_at = ?, status = 'CLOSED' WHERE status = 'ACTIVE' AND ended_at IS NULL"#,
    )
    .bind(ended_at)
    .execute(pool)
    .await?;

    // Re-fetch and enqueue each closed shift so the backend gets the final CLOSED state.
    for id in &ids {
        if let Ok(Some(shift)) = get_shift(pool, id).await {
            enqueue_shift(pool, &shift).await;
        }
    }

    Ok(r.rows_affected())
}

/// Re-enqueue every shift that is CLOSED locally but has no confirmed-synced CLOSED sync
/// record, so the backend receives the final state and flips the shift off "ACTIVE".
///
/// One-time, self-healing recovery for shifts that were closed while the enqueue was missing
/// (or whose CLOSED record exhausted its retries): the `enqueue` upsert resets
/// `synced_at`/`retries`, so this revives both cases. Idempotent and self-limiting — once a
/// shift's CLOSED record actually syncs, the `NOT EXISTS` clause excludes it on later runs.
/// Touches only the sync queue and shift reads; no protocol/poll-loop interaction.
pub async fn backfill_unsynced_closed_shifts(pool: &SqlitePool) -> Result<u64> {
    let ids: Vec<String> = sqlx::query_scalar(
        r#"SELECT s.id FROM shifts s
           WHERE s.status = 'CLOSED'
             AND NOT EXISTS (
                 SELECT 1 FROM sync_queue q
                 WHERE q.entity_id = s.id AND q.entity_type = 'shift'
                   AND q.synced_at IS NOT NULL
                   AND q.payload_json LIKE '%"status":"CLOSED"%'
             )"#,
    )
    .fetch_all(pool)
    .await?;

    let mut enqueued = 0u64;
    for id in &ids {
        if let Ok(Some(shift)) = get_shift(pool, id).await {
            enqueue_shift(pool, &shift).await;
            enqueued += 1;
        }
    }
    Ok(enqueued)
}

/// Start shift row (business rules live in `shifts::ShiftCoordinator`).
pub async fn persist_new_shift(pool: &SqlitePool, shift: &Shift) -> Result<()> {
    insert_shift(pool, shift).await
}

/// Assign all unshifted completed/stopped transactions that started at or after
/// `since_ms` to `shift_id`, and update the shift's running totals.
pub async fn backfill_unassigned_to_shift(
    pool: &SqlitePool,
    shift_id: &str,
    since_ms: i64,
) -> Result<()> {
    let (count, vol, amt): (i64, f64, i64) = sqlx::query_as(
        r#"SELECT COUNT(*),
                  COALESCE(SUM(CASE
                    WHEN status = 'CONTINUED_FROM' THEN volume
                    WHEN combined_volume > 0 THEN combined_volume
                    ELSE volume
                  END), 0.0),
                  COALESCE(SUM(CASE
                    WHEN status = 'CONTINUED_FROM' THEN amount
                    WHEN combined_amount > 0 THEN combined_amount
                    ELSE amount
                  END), 0)
           FROM transactions
           WHERE shift_id IS NULL AND started_at >= ? AND status IN ('COMPLETED', 'STOPPED', 'CONTINUED_FROM')"#,
    )
    .bind(since_ms)
    .fetch_one(pool)
    .await?;

    if count == 0 {
        return Ok(());
    }

    sqlx::query(
        r#"UPDATE transactions SET shift_id = ?
           WHERE shift_id IS NULL AND started_at >= ? AND status IN ('COMPLETED', 'STOPPED', 'CONTINUED_FROM')"#,
    )
    .bind(shift_id)
    .bind(since_ms)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"UPDATE shifts SET
               total_transactions = total_transactions + ?,
               total_volume       = total_volume + ?,
               total_amount       = total_amount + ?
           WHERE id = ?"#,
    )
    .bind(count)
    .bind(vol)
    .bind(amt)
    .bind(shift_id)
    .execute(pool)
    .await?;

    tracing::info!(
        shift_id,
        count,
        "backfilled unassigned transactions to shift"
    );
    enqueue_shift_by_id(pool, shift_id).await;
    Ok(())
}

/// Move completed/stopped transactions that belong to `from_shift_id` and
/// started at or after `since_ms` into `to_shift_id`, adjusting both shifts'
/// running totals. Used when a handover is backdated.
pub async fn reassign_from_shift_since(
    pool: &SqlitePool,
    from_shift_id: &str,
    to_shift_id: &str,
    since_ms: i64,
) -> Result<()> {
    let (count, vol, amt): (i64, f64, i64) = sqlx::query_as(
        r#"SELECT COUNT(*),
                  COALESCE(SUM(CASE
                    WHEN status = 'CONTINUED_FROM' THEN volume
                    WHEN combined_volume > 0 THEN combined_volume
                    ELSE volume
                  END), 0.0),
                  COALESCE(SUM(CASE
                    WHEN status = 'CONTINUED_FROM' THEN amount
                    WHEN combined_amount > 0 THEN combined_amount
                    ELSE amount
                  END), 0)
           FROM transactions
           WHERE shift_id = ? AND started_at >= ? AND status IN ('COMPLETED', 'STOPPED', 'CONTINUED_FROM')"#,
    )
    .bind(from_shift_id)
    .bind(since_ms)
    .fetch_one(pool)
    .await?;

    if count == 0 {
        return Ok(());
    }

    sqlx::query(
        r#"UPDATE transactions SET shift_id = ?
           WHERE shift_id = ? AND started_at >= ? AND status IN ('COMPLETED', 'STOPPED', 'CONTINUED_FROM')"#,
    )
    .bind(to_shift_id)
    .bind(from_shift_id)
    .bind(since_ms)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"UPDATE shifts SET
               total_transactions = MAX(0, total_transactions - ?),
               total_volume       = MAX(0.0, total_volume - ?),
               total_amount       = MAX(0, total_amount - ?)
           WHERE id = ?"#,
    )
    .bind(count)
    .bind(vol)
    .bind(amt)
    .bind(from_shift_id)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"UPDATE shifts SET
               total_transactions = total_transactions + ?,
               total_volume       = total_volume + ?,
               total_amount       = total_amount + ?
           WHERE id = ?"#,
    )
    .bind(count)
    .bind(vol)
    .bind(amt)
    .bind(to_shift_id)
    .execute(pool)
    .await?;

    tracing::info!(
        from_shift_id,
        to_shift_id,
        count,
        "reassigned transactions between shifts"
    );
    enqueue_shift_by_id(pool, from_shift_id).await;
    enqueue_shift_by_id(pool, to_shift_id).await;
    Ok(())
}

pub async fn list_operators(pool: &SqlitePool) -> Result<Vec<Operator>> {
    #[derive(sqlx::FromRow)]
    struct OpRow {
        id: String,
        name: String,
        pin_hash: Option<String>,
        active: i64,
        created_at: i64,
    }
    let rows: Vec<OpRow> = sqlx::query_as(
        r#"SELECT id, name, pin_hash, active, created_at FROM operators ORDER BY name"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Operator {
            id: r.id,
            name: r.name,
            has_pin: r.pin_hash.is_some(),
            active: r.active != 0,
            created_at: r.created_at,
        })
        .collect())
}

pub async fn insert_operator_stub(pool: &SqlitePool, cmd: &CreateOperatorCmd) -> Result<Operator> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let name = cmd.name.trim().to_string();
    if name.is_empty() {
        return Err(anyhow!("operator name is required"));
    }
    sqlx::query(r#"INSERT INTO operators (id, name, pin_hash, active, created_at) VALUES (?, ?, NULL, 1, ?)"#)
        .bind(&id)
        .bind(&name)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(Operator {
        id,
        name,
        has_pin: false,
        active: true,
        created_at: now,
    })
}

pub fn validate_start(cmd: &StartShiftCmd, require_pin: bool) -> Result<()> {
    if cmd.operator_name.trim().is_empty() {
        return Err(anyhow!("operator_name is required"));
    }
    if require_pin {
        let p = cmd.pin.as_deref().unwrap_or("");
        if p.trim().is_empty() {
            return Err(anyhow!("PIN is required for this site"));
        }
    }
    Ok(())
}

pub fn validate_end(cmd: &EndShiftCmd) -> Result<()> {
    if cmd.shift_id.trim().is_empty() {
        return Err(anyhow!("shift_id is required"));
    }
    Ok(())
}

pub fn validate_handover(cmd: &HandoverCmd) -> Result<()> {
    if cmd.outgoing_shift_id.trim().is_empty() || cmd.incoming_operator.trim().is_empty() {
        return Err(anyhow!(
            "outgoing_shift_id and incoming_operator are required"
        ));
    }
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

    fn active_shift(id: &str) -> Shift {
        Shift {
            id: id.to_string(),
            operator_id: None,
            operator_name: "op".to_string(),
            shift_name: None,
            scheduled_start: None,
            scheduled_end: None,
            started_at: 1_000,
            ended_at: None,
            total_transactions: 0,
            total_volume: 0.0,
            total_amount: 0,
            status: ShiftStatus::Active,
            notes: None,
            position_totals: Vec::new(),
        }
    }

    /// Regression: the bulk close-on-restart path must enqueue a CLOSED sync record
    /// for every shift it closes, so the backend admin flips them to CLOSED instead
    /// of leaving them stuck ACTIVE.
    #[tokio::test]
    async fn close_all_active_shifts_enqueues_closed_records() {
        let pool = memory_pool().await;
        insert_shift(&pool, &active_shift("shift-a")).await.unwrap();
        insert_shift(&pool, &active_shift("shift-b")).await.unwrap();

        let closed = close_all_active_shifts(&pool, 2_000).await.unwrap();
        assert_eq!(closed, 2, "both active shifts should be closed");

        // Local rows are CLOSED.
        for id in ["shift-a", "shift-b"] {
            let s = get_shift(&pool, id).await.unwrap().expect("shift exists");
            assert_eq!(s.status, ShiftStatus::Closed);
            assert_eq!(s.ended_at, Some(2_000));
        }

        // A CLOSED-payload sync row exists for each closed shift.
        for id in ["shift-a", "shift-b"] {
            let n: i64 = sqlx::query_scalar(
                r#"SELECT COUNT(*) FROM sync_queue
                   WHERE entity_type = 'shift' AND entity_id = ?
                     AND payload_json LIKE '%"status":"CLOSED"%'"#,
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(n, 1, "expected one CLOSED sync record for {id}");
        }
    }

    async fn closed_sync_rows(pool: &SqlitePool, id: &str) -> i64 {
        sqlx::query_scalar(
            r#"SELECT COUNT(*) FROM sync_queue
               WHERE entity_type = 'shift' AND entity_id = ?
                 AND payload_json LIKE '%"status":"CLOSED"%'"#,
        )
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    /// Recovery: backfill re-enqueues locally-CLOSED shifts that lack a synced CLOSED record,
    /// skips ones already synced, and leaves ACTIVE shifts alone.
    #[tokio::test]
    async fn backfill_recovers_only_unsynced_closed_shifts() {
        let pool = memory_pool().await;

        // stuck: closed locally, but no CLOSED sync record exists (H1 shape).
        insert_shift(&pool, &active_shift("stuck")).await.unwrap();
        close_shift(&pool, "stuck", 2_000, None).await.unwrap();
        // Simulate "never enqueued": drop the CLOSED sync row close_shift just created.
        sqlx::query(r#"DELETE FROM sync_queue WHERE payload_json LIKE '%"status":"CLOSED"%'"#)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(closed_sync_rows(&pool, "stuck").await, 0);

        // already-synced: closed with a CLOSED sync row marked synced_at.
        insert_shift(&pool, &active_shift("done")).await.unwrap();
        close_shift(&pool, "done", 2_000, None).await.unwrap();
        sqlx::query(
            r#"UPDATE sync_queue SET synced_at = 9999
               WHERE entity_id = 'done' AND payload_json LIKE '%"status":"CLOSED"%'"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        // still active: must be ignored.
        insert_shift(&pool, &active_shift("live")).await.unwrap();

        let n = backfill_unsynced_closed_shifts(&pool).await.unwrap();
        assert_eq!(n, 1, "only the stuck shift should be re-enqueued");

        assert_eq!(
            closed_sync_rows(&pool, "stuck").await,
            1,
            "stuck now has a CLOSED sync row"
        );
        // 'done' keeps exactly its one (already-synced) row — not duplicated.
        assert_eq!(closed_sync_rows(&pool, "done").await, 1);
        assert_eq!(
            closed_sync_rows(&pool, "live").await,
            0,
            "active shift untouched"
        );
    }
}
