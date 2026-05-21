//! Active shift lifecycle (SHIFT_MANAGEMENT.md).

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use chrono::{Local, Timelike};
use site_config::{ShiftMode, SiteConfig};
use sqlx::SqlitePool;
use tokio::sync::RwLock;
use types::{EndShiftCmd, HandoverCmd, Shift, ShiftStatus, StartShiftCmd, Transaction, WsEvent};
use uuid::Uuid;

use crate::db::shift_queries;

#[derive(Clone)]
pub struct ShiftCoordinator {
    pool: SqlitePool,
    cfg: Arc<SiteConfig>,
    active: Arc<RwLock<Option<Shift>>>,
}

impl ShiftCoordinator {
    pub fn new(pool: SqlitePool, cfg: Arc<SiteConfig>) -> Self {
        Self {
            pool,
            cfg,
            active: Arc::new(RwLock::new(None)),
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

    pub async fn active_id(&self) -> Option<String> {
        self.active.read().await.as_ref().map(|s| s.id.clone())
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
        let started_at = chrono::Utc::now().timestamp_millis();
        let shift = Shift {
            id,
            operator_id: None,
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
        };
        shift_queries::persist_new_shift(&self.pool, &shift).await?;
        *self.active.write().await = Some(shift.clone());
        Ok(shift)
    }

    pub async fn end(&self, cmd: EndShiftCmd) -> Result<Shift> {
        if self.cfg.shifts.mode == ShiftMode::Disabled {
            return Err(anyhow!("shift tracking is disabled for this site"));
        }
        shift_queries::validate_end(&cmd)?;
        let ended_at = chrono::Utc::now().timestamp_millis();
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
                pin: cmd.incoming_pin.clone(),
                notes: cmd.notes.clone(),
            })
            .await?;
        Ok((outgoing, incoming))
    }

    pub async fn on_transaction_recorded(&self, tx: &Transaction) -> Result<()> {
        if !tx.status.counts_toward_revenue() {
            return Ok(());
        }
        if let Some(ref sid) = tx.shift_id {
            let vol = if tx.combined_volume > 0.0 {
                tx.combined_volume
            } else {
                tx.volume
            };
            let amt = if tx.combined_amount > 0 {
                tx.combined_amount
            } else {
                tx.amount
            };
            shift_queries::bump_shift_totals(&self.pool, sid, vol, amt).await?;
            let mut g = self.active.write().await;
            if let Some(cur) = g.as_mut() {
                if cur.id == *sid {
                    cur.total_transactions = cur.total_transactions.saturating_add(1);
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
