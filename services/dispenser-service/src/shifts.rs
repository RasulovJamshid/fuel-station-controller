//! Active shift lifecycle (SHIFT_MANAGEMENT.md).

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use chrono::{Local, Timelike};
use site_config::{ShiftMode, SiteConfig};
use sqlx::SqlitePool;
use tokio::sync::RwLock;
use types::{
    EndShiftCmd, HandoverCmd, Shift, ShiftStatus, StartShiftCmd, Transaction, TxStatus, WsEvent,
};
use uuid::Uuid;

use crate::db::shift_queries;
use crate::engine::RuntimeFp;

/// Lane runtimes, read at shift boundaries to snapshot pump totalizers.
pub type RuntimeMap = Arc<RwLock<std::collections::HashMap<u8, RuntimeFp>>>;

/// One nozzle's meter reading at a shift boundary. `volume`/`amount` are `None`
/// when the protocol has no totalizer or the lane was unreachable.
struct TotalizerSnapshot {
    fp_id: String,
    label: String,
    nozzle_index: u8,
    product_id: u8,
    product_name: String,
    volume: Option<f64>,
    amount: Option<u64>,
}

#[derive(Clone)]
pub struct ShiftCoordinator {
    pool: SqlitePool,
    cfg: Arc<SiteConfig>,
    active: Arc<RwLock<Option<Shift>>>,
    /// Absent in tests that exercise shift bookkeeping without a poll loop; the
    /// totalizer capture is then simply skipped.
    runtimes: Option<RuntimeMap>,
}

impl ShiftCoordinator {
    pub fn new(pool: SqlitePool, cfg: Arc<SiteConfig>) -> Self {
        Self {
            pool,
            cfg,
            active: Arc::new(RwLock::new(None)),
            runtimes: None,
        }
    }

    /// Attach lane runtimes so shift open/close can snapshot pump totalizers.
    pub fn with_runtimes(mut self, runtimes: RuntimeMap) -> Self {
        self.runtimes = Some(runtimes);
        self
    }

    /// Snapshot every configured nozzle's electronic totalizer into the shift record.
    ///
    /// Best effort by design: protocols without a totalizer (Wayne Europump) and
    /// lanes that are offline at the boundary contribute a row with a NULL reading,
    /// which is more useful than no row at all — it shows the reading was attempted.
    async fn capture_totalizers(&self, shift_id: &str, closing: bool) {
        let Some(runtimes) = self.runtimes.as_ref() else {
            return;
        };
        let now = chrono::Utc::now().timestamp_millis();
        let snapshot: Vec<TotalizerSnapshot> = {
            let map = runtimes.read().await;
            self.cfg
                .active_positions()
                .into_iter()
                .flat_map(|fp| {
                    let rt = map.get(&fp.address_byte);
                    fp.nozzles
                        .iter()
                        .filter(|n| n.active)
                        .map(|n| {
                            let totals = rt
                                .and_then(|rt| {
                                    rt.state
                                        .pump_totals
                                        .iter()
                                        .find(|t| t.nozzle_index == n.index)
                                })
                                .map(|t| (t.volume, t.amount));
                            TotalizerSnapshot {
                                fp_id: fp.id.clone(),
                                label: fp.label.clone(),
                                nozzle_index: n.index,
                                product_id: n.product_id,
                                product_name: self
                                    .cfg
                                    .product(n.product_id)
                                    .map(|p| p.name.clone())
                                    .unwrap_or_default(),
                                volume: totals.map(|(v, _)| v),
                                amount: totals.map(|(_, a)| a),
                            }
                        })
                        .collect::<Vec<_>>()
                })
                .collect()
        };
        for s in snapshot {
            if let Err(e) = shift_queries::upsert_nozzle_totalizer(
                &self.pool,
                shift_id,
                &s.fp_id,
                &s.label,
                s.nozzle_index,
                s.product_id,
                &s.product_name,
                s.volume,
                s.amount,
                now,
                closing,
            )
            .await
            {
                let (fp_id, nozzle_index) = (&s.fp_id, s.nozzle_index);
                tracing::warn!(%fp_id, nozzle_index, ?e, "shift totalizer capture failed");
            }
        }
    }

    pub async fn restore(&self) -> Result<()> {
        if self.cfg.shifts.mode == ShiftMode::Disabled {
            *self.active.write().await = None;
            return Ok(());
        }
        if self.cfg.shifts.auto_close_on_restart {
            let now = chrono::Utc::now().timestamp_millis();
            let n = shift_queries::close_all_active_shifts(&self.pool, now).await?;
            if n > 0 {
                tracing::info!(rows = n, "auto-closed active shift(s) on service restart");
            }
            *self.active.write().await = None;
            return Ok(());
        }
        if let Some(s) = shift_queries::load_active_shift(&self.pool).await? {
            tracing::info!(shift_id = %s.id, "restored active shift from database");
            *self.active.write().await = Some(s);
        } else {
            *self.active.write().await = None;
        }
        Ok(())
    }

    pub async fn current(&self) -> Option<Shift> {
        self.active.read().await.clone()
    }

    /// Returns (shift_id, operator_name) for the currently active shift in a single lock acquire.
    pub async fn active_info(&self) -> (Option<String>, Option<String>) {
        let g = self.active.read().await;
        if let Some(s) = g.as_ref() {
            (Some(s.id.clone()), Some(s.operator_name.clone()))
        } else {
            (None, None)
        }
    }

    pub async fn start(&self, cmd: StartShiftCmd) -> Result<Shift> {
        if self.cfg.shifts.mode == ShiftMode::Disabled {
            return Err(anyhow!("shift tracking is disabled for this site"));
        }
        shift_queries::validate_start(&cmd, self.cfg.shifts.require_operator_pin)?;
        if self.active.read().await.is_some() {
            return Err(anyhow!(
                "a shift is already active — end it or hand over before starting another"
            ));
        }
        let now = Local::now();
        let mins = now.hour() * 60 + now.minute() as u32;
        let (shift_name, scheduled_start, scheduled_end) = match self.cfg.shifts.mode {
            ShiftMode::Scheduled => {
                if let Some(slot) = self.cfg.shifts.current_slot(mins) {
                    (
                        Some(slot.name.clone()),
                        Some(slot.start.clone()),
                        Some(slot.end.clone()),
                    )
                } else {
                    (None, None, None)
                }
            }
            _ => (None, None, None),
        };
        let id = Uuid::new_v4().to_string();
        let started_at = cmd
            .started_at_override
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        let shift = Shift {
            id,
            operator_id: cmd.operator_id.clone(),
            operator_name: cmd.operator_name.trim().to_string(),
            shift_name,
            scheduled_start,
            scheduled_end,
            started_at,
            ended_at: None,
            total_transactions: 0,
            total_volume: 0.0,
            total_amount: 0,
            status: ShiftStatus::Active,
            notes: cmd.notes.clone(),
            position_totals: vec![],
            product_totals: vec![],
            nozzle_totalizers: vec![],
        };
        shift_queries::persist_new_shift(&self.pool, &shift).await?;
        // Opening meter readings must be taken before any fuel moves on this shift.
        self.capture_totalizers(&shift.id, false).await;

        // When a backdated start time is provided, pull in any completed/stopped
        // transactions that happened after that time but have no shift yet.
        if let Some(since_ms) = cmd.started_at_override {
            shift_queries::backfill_unassigned_to_shift(&self.pool, &shift.id, since_ms).await?;
            if let Some(updated) = shift_queries::get_shift(&self.pool, &shift.id).await? {
                *self.active.write().await = Some(updated.clone());
                return Ok(updated);
            }
        }

        *self.active.write().await = Some(shift.clone());
        Ok(shift)
    }

    pub async fn end(&self, cmd: EndShiftCmd) -> Result<Shift> {
        if self.cfg.shifts.mode == ShiftMode::Disabled {
            return Err(anyhow!("shift tracking is disabled for this site"));
        }
        shift_queries::validate_end(&cmd)?;
        let ended_at = chrono::Utc::now().timestamp_millis();
        // Closing meter readings first, so the persisted shift already carries them.
        self.capture_totalizers(&cmd.shift_id, true).await;
        shift_queries::close_shift(&self.pool, &cmd.shift_id, ended_at, cmd.notes.as_deref())
            .await?;
        let shift = shift_queries::get_shift(&self.pool, &cmd.shift_id)
            .await?
            .ok_or_else(|| anyhow!("shift not found"))?;
        {
            let mut g = self.active.write().await;
            if g.as_ref().map(|s| s.id.as_str()) == Some(cmd.shift_id.as_str()) {
                *g = None;
            }
        }
        Ok(shift)
    }

    pub async fn handover(&self, cmd: HandoverCmd) -> Result<(Shift, Shift)> {
        if self.cfg.shifts.mode == ShiftMode::Disabled {
            return Err(anyhow!("shift tracking is disabled for this site"));
        }
        shift_queries::validate_handover(&cmd)?;
        if self.cfg.shifts.require_operator_pin {
            let p = cmd.incoming_pin.as_deref().unwrap_or("");
            if p.trim().is_empty() {
                return Err(anyhow!("incoming operator PIN is required for this site"));
            }
        }
        let outgoing = self
            .end(EndShiftCmd {
                shift_id: cmd.outgoing_shift_id.clone(),
                notes: cmd.notes.clone(),
            })
            .await?;
        let incoming = self
            .start(StartShiftCmd {
                operator_name: cmd.incoming_operator.clone(),
                operator_id: cmd.incoming_operator_id.clone(),
                pin: cmd.incoming_pin.clone(),
                notes: cmd.notes.clone(),
                started_at_override: cmd.incoming_started_at_override,
            })
            .await?;

        // When the handover is backdated, also move transactions that were
        // already counted in the outgoing shift (because the old shift was
        // still active at that time) into the incoming shift.
        if let Some(since_ms) = cmd.incoming_started_at_override {
            shift_queries::reassign_from_shift_since(
                &self.pool,
                &outgoing.id,
                &incoming.id,
                since_ms,
            )
            .await?;
            let outgoing = shift_queries::get_shift(&self.pool, &outgoing.id)
                .await?
                .ok_or_else(|| anyhow!("outgoing shift not found after reassign"))?;
            let incoming = shift_queries::get_shift(&self.pool, &incoming.id)
                .await?
                .ok_or_else(|| anyhow!("incoming shift not found after reassign"))?;
            *self.active.write().await = Some(incoming.clone());
            return Ok((outgoing, incoming));
        }

        Ok((outgoing, incoming))
    }

    pub async fn on_transaction_recorded(&self, tx: &Transaction) -> Result<()> {
        if !tx.status.counts_toward_revenue() {
            return Ok(());
        }
        if let Some(ref sid) = tx.shift_id {
            // ContinuedFrom: credit segment volume only — the STOPPED parent already
            // counted the base. Do NOT increment total_transactions — the STOPPED row
            // already counted this as one transaction.
            let is_continuation = matches!(tx.status, TxStatus::ContinuedFrom(_));
            let (vol, amt) = if is_continuation {
                (tx.volume, tx.amount)
            } else {
                let v = if tx.combined_volume > 0.0 {
                    tx.combined_volume
                } else {
                    tx.volume
                };
                let a = if tx.combined_amount > 0 {
                    tx.combined_amount
                } else {
                    tx.amount
                };
                (v, a)
            };
            shift_queries::bump_shift_totals(&self.pool, sid, vol, amt, !is_continuation).await?;
            let mut g = self.active.write().await;
            if let Some(cur) = g.as_mut() {
                if cur.id == *sid {
                    if !is_continuation {
                        cur.total_transactions = cur.total_transactions.saturating_add(1);
                    }
                    cur.total_volume += vol;
                    cur.total_amount = cur.total_amount.saturating_add(amt);
                }
            }
        }
        Ok(())
    }
}

pub fn spawn_warning_task(
    coordinator: Arc<ShiftCoordinator>,
    events: tokio::sync::broadcast::Sender<WsEvent>,
) {
    if coordinator.cfg.shifts.mode != ShiftMode::Scheduled {
        return;
    }
    let warn_mins = coordinator.cfg.shifts.warn_before_end_minutes;
    let cfg = coordinator.cfg.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            let now = Local::now();
            let now_min = now.hour() * 60 + now.minute() as u32;
            if let Some(remaining) = cfg.shifts.minutes_until_slot_end(now_min) {
                if remaining == warn_mins {
                    if let Some(shift) = coordinator.current().await {
                        let _ = events.send(WsEvent::ShiftEndWarning {
                            shift_id: shift.id,
                            minutes_remaining: remaining,
                        });
                    }
                }
            }
        }
    });
}
