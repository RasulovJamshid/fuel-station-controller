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
        Err(e) => { tracing::warn!("sync: shift serialize error: {e}"); return; }
    };
    if let Err(e) = crate::sync::enqueue(pool, "shift", &shift.id, &payload).await {
        tracing::warn!("sync: enqueue shift {} failed: {e}", shift.id);
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
    Ok(())
}

pub async fn close_all_active_shifts(pool: &SqlitePool, ended_at: i64) -> Result<u64> {
    let r = sqlx::query(
        r#"UPDATE shifts SET ended_at = ?, status = 'CLOSED' WHERE status = 'ACTIVE' AND ended_at IS NULL"#,
    )
    .bind(ended_at)
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
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

    tracing::info!(shift_id, count, "backfilled unassigned transactions to shift");
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

    tracing::info!(from_shift_id, to_shift_id, count, "reassigned transactions between shifts");
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
