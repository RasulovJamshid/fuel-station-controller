use chrono::Utc;
use site_config::{FuelingPositionConfig, SiteConfig};
use std::collections::HashMap;
use types::{preset_label, FpState, FpStatus, Preset, StopSource, Transaction, TxStatus};
use uuid::Uuid;
use wayne_europump::{decode_amount, decode_volume, Frame};

/// Idle polls required before accepting another reactive nozzle lift after ghost fill.
const GHOST_RECOVERY_IDLE_POLLS: u8 = 4;

/// Consecutive frozen-counter Data frames before committing to STOPPED during decel window.
const DECEL_FROZEN_FRAME_THRESHOLD: u8 = 6;
/// Wall-clock fallback: commit to STOPPED if the decel window stays open this long (ms).
pub(super) const DECEL_WINDOW_TIMEOUT_MS: i64 = 10_000;
/// Initial nonzero volume that can be a Wayne ghost pulse when the counter never advances.
const STARTUP_GHOST_MAX_VOLUME_L: f64 = 0.05;
/// Repeated tiny startup Data frames before aborting the ghost authorization.
const STARTUP_GHOST_FROZEN_FRAME_THRESHOLD: u8 = 6;
/// Minimum age of a stuck startup pulse before aborting; gives operators time to begin topping off.
const STARTUP_GHOST_MIN_AGE_MS: i64 = 15_000;
/// After CONFIG is put on the wire, the Wayne pump echoes a zero-volume holster frame
/// (`01 01 02` standalone or `03 04 … 0X` embedded) before the customer has done anything.
/// Within this window a zero-volume holster is treated as that echo and ignored, not as a real
/// customer holster — otherwise the pump gets de-authorized ~0.5 s after being armed.
const CONFIG_ECHO_GRACE_MS: i64 = 3_000;

#[derive(Debug, Clone)]
pub struct StoppedContext {
    pub stopped_tx_id: String,
    pub stopped_volume: f64,
    pub stopped_amount: u64,
    pub preset: Preset,
    pub stop_source: StopSource,
    pub price: u32,
    pub nozzle_index: u8,
}

#[derive(Debug, Clone)]
pub struct PreAuthContext {
    pub nozzle_index: u8,
    #[allow(dead_code)]
    pub product_id: u8,
}

#[derive(Debug, Clone)]
pub struct ContinuationContext {
    pub parent_tx_id: String,
    pub base_volume: f64,
    pub base_amount: u64,
    pub segment_volume: f64,
    pub segment_amount: u64,
}

#[derive(Debug, Clone)]
pub struct RuntimeFp {
    pub state: FpState,
    /// Effective price per nozzle index (overrides config after POST /prices).
    pub nozzle_prices: HashMap<u8, u32>,
    pub missed: u32,
    pub settle_after_reconnect: u32,
    pub current_tx: Option<CurrentTx>,
    /// Stop delivery as COMPLETED once live volume (L) reaches this value.
    pub cap_volume_liters: Option<f64>,
    /// Stop delivery once live amount (sum, same unit as `FpState.amount`) reaches this value.
    pub cap_amount: Option<u64>,
    /// In-memory E-stop state (lost on service restart).
    pub stopped_context: Option<StoppedContext>,
    /// True when the lane was stopped while the nozzle was physically up. The pump may report
    /// idle (`70 FA`) before the customer holsters; while this is set we keep showing the STOPPED
    /// sale (nozzle still up) and finalize only on the real NozzleReturned/holster frame.
    pub stopped_nozzle_up: bool,
    pub continuation: Option<ContinuationContext>,
    /// Last authorize preset (for E-stop continuation).
    pub last_preset: Preset,
    pub pre_auth: Option<PreAuthContext>,
    /// Wall-clock ms when pre-authorization was sent (for timeout).
    pub pre_auth_started_at: Option<i64>,
    /// Set when a matching nozzle-up frame is seen during pre-authorization.
    pub preauth_nozzle_confirmed: bool,
    /// Set when a nozzle mismatch is detected — blocks Data-frame transition to Authorizing.
    pub preauth_mismatch_active: bool,
    /// Set when a pre-auth was just cancelled: the pump may still be armed, so any delivery that
    /// arrives before the pump confirms idle is treated as unauthorized (STOP + alert), not a sale.
    /// Cleared once the pump reports idle (`70 FA`) or the operator resets the lane.
    pub preauth_cancel_pending: bool,
    /// Dedup guard so an ongoing unauthorized delivery raises the operator alert once per episode
    /// (the pump is still STOPed every poll). Cleared when the pump confirms idle / on reset.
    pub unauthorized_alerted: bool,
    /// Block stray NozzleUp re-AUTH until the dispenser has polled idle enough times.
    pub ghost_recovery: bool,
    pub consecutive_idle_polls: u8,
    /// When set, send CONFIG×2 after the first zero-volume Data frame (Wayne expects AUTH first).
    pub pending_authorize_config: bool,
    /// After the first CONFIG, wait for another poll response before sending the repeat.
    pub pending_authorize_config_repeat: bool,
    /// Holstered pre-auth already sent AUTH+CONFIG on the wire; lift only needs BUSY + delivery.
    pub preauth_config_on_wire: bool,
    /// Wall-clock ms when CONFIG was last put on the wire; used to ignore the pump's post-CONFIG
    /// zero-volume holster echo (see [`CONFIG_ECHO_GRACE_MS`]).
    pub config_on_wire_at: Option<i64>,
    /// Wall-clock ms when the current authorize session started (not reset by poll touch).
    pub auth_session_started_at: Option<i64>,
    /// Latest `03 04 … HH` hose byte from NozzleUp / Data / NozzleReturned.
    pub last_wire_hose_code: Option<u8>,
    pub last_wire_hose_at_ms: i64,
    /// Completed sale awaiting operator dismiss — blocks duplicate history on other nozzles.
    pub completed_sale: Option<CompletedSaleLatch>,

    // ── Holster close deferral ───────────────────────────────────────────────
    /// When true, the first NozzleReturned was seen but finalization is deferred by one
    /// poll cycle so the pump can deliver its final Data frame (with the true pump-counter
    /// reading) before the transaction is recorded.  Finalize on the next Data/idle frame.
    pub pending_holster_close: bool,
    /// The pump signalled `sale_complete` (hardware preset reached) while the nozzle was
    /// still in the tank.  Cleared when the sale is finalized.  Used by
    /// `holster_ends_sale_early()` to distinguish a BCD-rounding shortfall (not early)
    /// from a genuine operator-initiated early holster.
    pub pump_sale_complete: bool,

    // ── Decel window (old-app BUSY-after-stop) ──────────────────────────────
    /// Wall-clock ms when the STOP command was sent; `None` = no decel window active.
    pub decel_stop_sent_at: Option<i64>,
    /// Volume snapshot at STOP time — used to detect whether the counter advances.
    pub decel_vol_snapshot: f64,
    /// Consecutive Data frames with a frozen counter since STOP was sent.
    pub decel_frozen_count: u8,
    /// Preset captured at STOP time for forwarding to enter_stopped_state on expiry.
    pub decel_pending_preset: Option<Preset>,
    /// Stop source captured at STOP time (always App for this path).
    pub decel_pending_stop_source: StopSource,

    // -- Startup ghost-fill detection ---------------------------------------
    /// Last tiny startup meter value seen while waiting for a real delivery to progress.
    pub startup_ghost_last_meter: Option<(f64, u64)>,
    /// Consecutive tiny startup Data frames with the same counter.
    pub startup_ghost_frozen_count: u8,
}

/// Hose lift notifications older than this are ignored for "still up" guards.
const WIRE_LIFT_STALE_MS: i64 = 4_000;

#[derive(Debug, Clone)]
pub struct CurrentTx {
    pub id: String,
    pub started_at: i64,
    pub product_id: u8,
    pub product_name: String,
    pub nozzle_index: u8,
}

/// Last sale recorded on this lane until the operator dismisses the DONE screen.
#[derive(Debug, Clone)]
pub struct CompletedSaleLatch;

impl RuntimeFp {
    pub fn new(fp: &FuelingPositionConfig, cfg: &SiteConfig) -> Self {
        let now = Utc::now().timestamp_millis();
        let price = fp.default_price().unwrap_or(0);
        let nozzle_count = fp.nozzle_count().min(u8::MAX as usize) as u8;
        let mut nozzle_prices = HashMap::new();
        for n in fp.nozzles.iter().filter(|n| n.active) {
            nozzle_prices.insert(n.index, n.price);
        }
        Self {
            missed: 0,
            settle_after_reconnect: cfg.polling.reconnect_settle_rounds,
            current_tx: None,
            nozzle_prices,
            cap_volume_liters: None,
            cap_amount: None,
            stopped_context: None,
            stopped_nozzle_up: false,
            continuation: None,
            last_preset: Preset::Str("full".into()),
            pre_auth: None,
            pre_auth_started_at: None,
            preauth_nozzle_confirmed: false,
            preauth_mismatch_active: false,
            preauth_cancel_pending: false,
            unauthorized_alerted: false,
            ghost_recovery: false,
            consecutive_idle_polls: 0,
            pending_authorize_config: false,
            pending_authorize_config_repeat: false,
            preauth_config_on_wire: false,
            config_on_wire_at: None,
            auth_session_started_at: None,
            last_wire_hose_code: None,
            last_wire_hose_at_ms: 0,
            completed_sale: None,
            pending_holster_close: false,
            pump_sale_complete: false,
            decel_stop_sent_at: None,
            decel_vol_snapshot: 0.0,
            decel_frozen_count: 0,
            decel_pending_preset: None,
            decel_pending_stop_source: StopSource::App,
            startup_ghost_last_meter: None,
            startup_ghost_frozen_count: 0,
            state: FpState {
                fp_id: fp.id.clone(),
                label: fp.label.clone(),
                address_byte: fp.address_byte,
                status: FpStatus::Offline,
                volume: 0.0,
                amount: 0,
                price,
                nozzle_index: None,
                product_id: None,
                product_name: None,
                product_color: None,
                nozzle_count,
                seq: 0,
                missed_polls: 0,
                updated_at: now,
                stopped_tx_id: None,
                base_volume: None,
                base_amount: None,
                segment_volume: None,
                segment_amount: None,
                pump_total_nozzle_index: None,
                pump_total_volume: None,
                pump_total_amount: None,
                pump_total_price: None,
                pump_totals: Vec::new(),
                pre_auth_preset: None,
                stop_source: None,
            },
        }
    }

    fn touch(&mut self) {
        self.state.updated_at = Utc::now().timestamp_millis();
    }

    /// API/WS snapshot for UI. Holstered pre-auth shows `PRE_AUTHORIZED`; a physical
    /// lift stays `NOZZLE_UP` so the operator can assign volume/amount (lift-first flow).
    pub fn snapshot_state(&self) -> FpState {
        let mut s = self.state.clone();
        if self.pre_auth.is_some() {
            if s.status == FpStatus::Idle {
                s.status = FpStatus::PreAuthorized;
            }
            if s.pre_auth_preset.is_none() {
                s.pre_auth_preset = Some(preset_label(&self.last_preset));
            }
        }
        // Only fill pre_auth_preset from last_preset when there's an active preauth
        // session. Without this guard, a bare reactive lift after ghost abort would
        // re-surface a stale preset from the previous (failed) authorization.
        if matches!(s.status, FpStatus::Authorizing | FpStatus::Delivering)
            && s.pre_auth_preset.is_none()
            && (self.pre_auth.is_some() || self.preauth_config_on_wire)
        {
            s.pre_auth_preset = Some(preset_label(&self.last_preset));
        }
        s
    }

    pub fn clear_deliver_caps(&mut self) {
        self.cap_volume_liters = None;
        self.cap_amount = None;
    }

    pub fn in_decel_window(&self) -> bool {
        self.decel_stop_sent_at.is_some()
    }

    pub fn clear_decel_window(&mut self) {
        self.decel_stop_sent_at = None;
        self.decel_vol_snapshot = 0.0;
        self.decel_frozen_count = 0;
        self.decel_pending_preset = None;
    }

    pub fn set_deliver_caps_from_preset(&mut self, preset: &Preset) {
        self.clear_deliver_caps();
        match preset {
            Preset::Str(s) if s.eq_ignore_ascii_case("full") => {}
            Preset::Volume(v) if *v > 0.0 => {
                self.cap_volume_liters = Some(*v);
            }
            Preset::Amount(a) if *a > 0 => {
                self.cap_amount = Some(*a);
            }
            _ => {}
        }
    }

    /// Supervisor reset: lane is ready for a new session (use after E-stop, bad state, or tests).
    /// Does not insert a transaction row.
    fn clear_continuation_fields(&mut self) {
        self.state.stopped_tx_id = None;
        self.state.base_volume = None;
        self.state.base_amount = None;
        self.state.segment_volume = None;
        self.state.segment_amount = None;
    }

    /// Reset live meters for a new customer session (preauth lift / wire AUTH).
    fn zero_delivery_meters(&mut self) {
        self.clear_continuation_fields();
        self.state.volume = 0.0;
        self.state.amount = 0;
        self.clear_startup_ghost_watch();
    }

    /// Composite `02 08` frames often end with `03 04 … HH` holster while the hose is
    /// still hung up during holstered pre-auth — not a customer holster event.
    fn embedded_holster_is_customer_event(&self) -> bool {
        !matches!(
            self.state.status,
            FpStatus::PreAuthorized if !self.preauth_nozzle_confirmed
        )
    }

    fn note_wire_hose(&mut self, hose: u8) {
        self.last_wire_hose_code = Some(hose);
        self.last_wire_hose_at_ms = Utc::now().timestamp_millis();
    }

    /// Recent lift code (`HH >= 0x10`) — do not ghost-abort or treat as holstered.
    pub fn nozzle_physically_up(&self) -> bool {
        let age = Utc::now().timestamp_millis() - self.last_wire_hose_at_ms;
        if age > WIRE_LIFT_STALE_MS {
            return false;
        }
        self.last_wire_hose_code
            .is_some_and(Frame::is_nozzle_lift_code)
    }

    fn preauth_session_armed(&self) -> bool {
        self.preauth_config_on_wire
            || self.pending_authorize_config_repeat
            || self.state.pre_auth_preset.is_some()
    }

    fn owns_meter_data(&self) -> bool {
        self.current_tx.is_some()
            || self.pre_auth.is_some()
            || self.preauth_session_armed()
            || self.auth_session_started_at.is_some()
            || self.continuation.is_some()
    }

    /// Effective price for the currently active nozzle (falls back to state.price).
    fn active_nozzle_price(&self) -> u32 {
        let idx = self.state.nozzle_index.unwrap_or(1);
        self.nozzle_prices
            .get(&idx)
            .copied()
            .unwrap_or(self.state.price)
    }

    /// Amount computed from metered volume × actual price.
    ///
    /// Wayne hardware computes its own amount display using the truncated displayed price
    /// (e.g. 10500 → displayed as "0500"), so the pump's raw amount bytes are wrong by the
    /// leading digits.  We recompute from volume so both the UI and the software cap
    /// (`cap_amount`) use the correct sum.
    fn amount_from_volume(&self, vol: f64) -> u64 {
        let price = self.active_nozzle_price();
        (vol * price as f64).round() as u64
    }

    fn metered_amount(&self, vol: f64, pump_amount: u64) -> u64 {
        match self.last_preset {
            Preset::Amount(_) if pump_amount > 0 => pump_amount,
            _ => self.amount_from_volume(vol),
        }
    }

    fn apply_metering(&mut self, raw_vol: f64, raw_amt: u64) {
        if let Some(c) = self.continuation.as_mut() {
            c.segment_volume = raw_vol;
            c.segment_amount = raw_amt;
            self.state.segment_volume = Some(raw_vol);
            self.state.segment_amount = Some(raw_amt);
            self.state.base_volume = Some(c.base_volume);
            self.state.base_amount = Some(c.base_amount);
            self.state.volume = c.base_volume + raw_vol;
            self.state.amount = c.base_amount + raw_amt;
        } else {
            self.state.segment_volume = None;
            self.state.segment_amount = None;
            self.state.base_volume = None;
            self.state.base_amount = None;
            self.state.volume = raw_vol;
            self.state.amount = raw_amt;
        }
    }

    fn clear_startup_ghost_watch(&mut self) {
        self.startup_ghost_last_meter = None;
        self.startup_ghost_frozen_count = 0;
    }

    fn startup_ghost_frozen(&mut self, raw_vol: f64, raw_amt: u64) -> bool {
        if raw_vol <= 1e-6 || raw_vol > STARTUP_GHOST_MAX_VOLUME_L {
            self.clear_startup_ghost_watch();
            return false;
        }

        match self.startup_ghost_last_meter {
            Some((last_vol, last_amt))
                if (last_vol - raw_vol).abs() < 1e-6 && last_amt == raw_amt =>
            {
                self.startup_ghost_frozen_count = self.startup_ghost_frozen_count.saturating_add(1);
            }
            _ => {
                self.startup_ghost_last_meter = Some((raw_vol, raw_amt));
                self.startup_ghost_frozen_count = 1;
            }
        }

        self.startup_ghost_frozen_count >= STARTUP_GHOST_FROZEN_FRAME_THRESHOLD
    }

    fn startup_ghost_old_enough(&self) -> bool {
        self.auth_session_started_at.is_some_and(|started| {
            Utc::now().timestamp_millis() - started >= STARTUP_GHOST_MIN_AGE_MS
        })
    }

    fn combined_totals(&self) -> (f64, u64) {
        if let Some(c) = &self.continuation {
            (
                c.base_volume + c.segment_volume,
                c.base_amount + c.segment_amount,
            )
        } else {
            (self.state.volume, self.state.amount)
        }
    }

    fn segment_totals(&self) -> (f64, u64) {
        if let Some(c) = &self.continuation {
            (c.segment_volume, c.segment_amount)
        } else {
            (self.state.volume, self.state.amount)
        }
    }

    /// True when the authorized preset limit is reached (full-tank holster always completes).
    fn sale_target_met(&self) -> bool {
        if self.last_preset.is_full() {
            return true;
        }
        let (vol, amt) = self.combined_totals();
        if let Some(cap) = self.cap_volume_liters {
            return vol + 1e-6 >= cap;
        }
        if let Some(cap) = self.cap_amount {
            return amt >= cap;
        }
        true
    }

    /// Nozzle holstered before the preset cap — close the sale for operator review (no continue).
    fn holster_ends_sale_early(&self) -> bool {
        // If the pump hardware already signalled sale_complete, the preset was reached
        // (the shortfall vs cap_amount is only BCD rounding, ≤ price × 0.01 L).
        // Route to complete_sale_from_holster so pump-reported completion is preserved.
        if self.pump_sale_complete {
            return false;
        }
        let (vol, _) = self.combined_totals();
        vol > 0.01 && !self.sale_target_met()
    }

    /// Finalize a partial sale after holster; lane shows DONE totals, tx is STOPPED in history.
    fn end_sale_from_holster_early(
        &mut self,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
        active_shift_id: Option<String>,
        active_operator_name: Option<String>,
    ) -> FrameEffect {
        self.stopped_context = None;
        self.clear_deliver_caps();
        self.state.status = FpStatus::Done;
        let tx = self.close_transaction(false, fp_cfg, site, active_shift_id, active_operator_name);
        self.touch();
        FrameEffect::TransactionDone {
            tx,
            action: TxCompleteAction::AcknowledgeIdle,
        }
    }

    fn complete_sale_from_holster(
        &mut self,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
        active_shift_id: Option<String>,
        active_operator_name: Option<String>,
    ) -> FrameEffect {
        let (vol, _) = self.combined_totals();
        self.pending_holster_close = false;
        let hardware_complete = self.pump_sale_complete;
        self.pump_sale_complete = false;
        // Guard: if a PAUSE decel window was open but we reach holster-completion
        // (e.g. via an unhandled code path), disarm the timer so it cannot fire a
        // second save after this one.
        self.clear_decel_window();
        self.state.status = FpStatus::Done;
        let completed = hardware_complete || self.sale_target_met() || vol < 0.01;
        self.clear_deliver_caps();
        let tx = self.close_transaction(
            completed,
            fp_cfg,
            site,
            active_shift_id,
            active_operator_name,
        );
        self.touch();
        FrameEffect::TransactionDone {
            tx,
            action: TxCompleteAction::AcknowledgeIdle,
        }
    }

    /// E-stop or lane STOP while fuel was flowing — persist STOPPED tx and await continue/close.
    fn apply_stopped_display(
        &mut self,
        stopped_volume: f64,
        stopped_amount: u64,
        stopped_tx_id: String,
        stop_source: StopSource,
    ) {
        self.state.status = FpStatus::Stopped {
            stopped_volume,
            stopped_amount,
            stopped_tx_id: stopped_tx_id.clone(),
            stop_source,
        };
        self.state.stopped_tx_id = Some(stopped_tx_id);
        self.state.stop_source = Some(stop_source);
        self.state.volume = stopped_volume;
        self.state.amount = stopped_amount;
        self.state.base_volume = None;
        self.state.base_amount = None;
        self.state.segment_volume = None;
        self.state.segment_amount = None;
    }

    pub fn enter_stopped_state(
        &mut self,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
        active_shift_id: Option<String>,
        active_operator_name: Option<String>,
        preset: Preset,
        stop_source: StopSource,
    ) -> FrameEffect {
        self.clear_deliver_caps();
        // Capture whether the nozzle is up *before* apply_stopped_display overwrites the status.
        // A stop that interrupts a fill always has the nozzle in the tank; the pump may then poll
        // idle before the customer holsters, so we must keep showing STOPPED until the real holster.
        self.stopped_nozzle_up = matches!(
            self.state.status,
            FpStatus::Delivering | FpStatus::Authorizing | FpStatus::NozzleUp
        ) || self.nozzle_physically_up();
        let (combined_vol, combined_amt) = self.combined_totals();
        let tx = self.finish_transaction_with_totals(
            TxStatus::Stopped,
            fp_cfg,
            site,
            active_shift_id,
            active_operator_name,
            combined_vol,
            combined_amt,
            None,
        );
        let stopped_tx_id = tx.id.clone();
        let nozzle_index = self.state.nozzle_index.unwrap_or(1);
        self.stopped_context = Some(StoppedContext {
            stopped_tx_id: stopped_tx_id.clone(),
            stopped_volume: combined_vol,
            stopped_amount: combined_amt,
            preset,
            stop_source,
            price: self.state.price,
            nozzle_index,
        });
        self.continuation = None;
        self.apply_stopped_display(
            combined_vol,
            combined_amt,
            stopped_tx_id.clone(),
            stop_source,
        );
        self.touch();
        FrameEffect::Paused {
            tx,
            fp_id: self.state.fp_id.clone(),
            stopped_volume: combined_vol,
            stopped_amount: combined_amt,
            stopped_tx_id,
            stop_source,
        }
    }

    /// Rebuild in-memory E-stop state from a persisted `STOPPED` transaction (e.g. after restart).
    pub fn rehydrate_stopped_context(
        &mut self,
        tx: &Transaction,
        preset: Preset,
        stop_source: StopSource,
    ) {
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
        self.stopped_context = Some(StoppedContext {
            stopped_tx_id: tx.id.clone(),
            stopped_volume: vol,
            stopped_amount: amt,
            preset,
            stop_source,
            price: tx.price,
            nozzle_index: tx.nozzle_index,
        });
        self.continuation = None;
        self.current_tx = None;
        self.apply_stopped_display(vol, amt, tx.id.clone(), stop_source);
        self.state.price = tx.price;
        self.state.nozzle_index = Some(tx.nozzle_index);
        self.state.product_id = Some(tx.product_id);
        self.state.product_name = Some(tx.product_name.clone());
        self.touch();
    }

    pub fn prepare_continue(&mut self, stopped_tx_id: &str) -> Result<Preset, String> {
        let sc = self
            .stopped_context
            .take()
            .ok_or_else(|| "lane is not in a continuable stopped state".to_string())?;
        if sc.stopped_tx_id != stopped_tx_id {
            self.stopped_context = Some(sc);
            return Err("stopped_tx_id does not match this lane".into());
        }
        let preset = sc.preset.clone();

        // Hardware CONFIG must use the *remaining* amount so the pump doesn't
        // re-authorize for the full original limit again.  The software combined-
        // volume cap (set below) still uses the original preset so it fires at
        // the correct total (base + segment >= original limit).
        let hardware_preset = match &preset {
            Preset::Volume(v) => {
                let rem = (v - sc.stopped_volume).max(0.0);
                if rem > 0.01 {
                    Preset::Volume(rem)
                } else {
                    Preset::Str("full".into())
                }
            }
            Preset::Amount(a) => {
                let rem = a.saturating_sub(sc.stopped_amount);
                if rem > 0 {
                    Preset::Amount(rem)
                } else {
                    Preset::Str("full".into())
                }
            }
            Preset::Str(_) => preset.clone(),
        };

        self.continuation = Some(ContinuationContext {
            parent_tx_id: sc.stopped_tx_id.clone(),
            base_volume: sc.stopped_volume,
            base_amount: sc.stopped_amount,
            segment_volume: 0.0,
            segment_amount: 0,
        });
        self.state.stopped_tx_id = None;
        self.state.stop_source = None;
        self.state.status = FpStatus::Authorizing;
        self.state.base_volume = Some(sc.stopped_volume);
        self.state.base_amount = Some(sc.stopped_amount);
        self.state.segment_volume = Some(0.0);
        self.state.segment_amount = Some(0);
        self.state.volume = sc.stopped_volume;
        self.state.amount = sc.stopped_amount;
        self.set_deliver_caps_from_preset(&preset); // original — guards combined total
        self.last_preset = preset.clone(); // original — used for display & re-pause
        self.touch();
        Ok(hardware_preset)
    }

    pub fn close_stopped(&mut self, stopped_tx_id: &str) -> Result<(), String> {
        let sc = self
            .stopped_context
            .as_ref()
            .ok_or_else(|| "lane is not stopped".to_string())?;
        if sc.stopped_tx_id != stopped_tx_id {
            return Err("stopped_tx_id does not match this lane".into());
        }
        self.stopped_context = None;
        self.continuation = None;
        self.current_tx = None;
        self.clear_deliver_caps();
        self.clear_continuation_fields();
        self.state.status = FpStatus::Idle;
        self.state.stop_source = None;
        self.state.volume = 0.0;
        self.state.amount = 0;
        self.state.pre_auth_preset = None;
        self.pre_auth = None;
        self.touch();
        Ok(())
    }

    fn clear_completed_sale_latch(&mut self) {
        self.completed_sale = None;
    }

    /// Nozzle the pump's live meter block belongs to (embedded `03 04 01 PP 00 HH`).
    fn wire_transaction_nozzle(
        &self,
        hose_product: Option<u8>,
        hose_code: Option<u8>,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
    ) -> Option<u8> {
        let (pp, hh) = (hose_product?, hose_code?);
        if !Frame::is_nozzle_lift_code(hh) {
            return None;
        }
        Some(resolve_wayne_nozzle(site, fp_cfg, pp, hh).0)
    }

    fn reset_to_idle(&mut self) {
        self.stopped_context = None;
        self.stopped_nozzle_up = false;
        self.continuation = None;
        self.current_tx = None;
        self.pre_auth = None;
        self.pre_auth_started_at = None;
        self.pending_authorize_config = false;
        self.pending_authorize_config_repeat = false;
        self.preauth_config_on_wire = false;
        self.config_on_wire_at = None;
        self.auth_session_started_at = None;
        self.last_wire_hose_code = None;
        self.last_wire_hose_at_ms = 0;
        self.clear_deliver_caps();
        self.clear_decel_window();
        self.clear_continuation_fields();
        self.clear_unauthorized_state();
        self.pending_holster_close = false;
        self.pump_sale_complete = false;
        self.state.status = FpStatus::Idle;
        self.state.stop_source = None;
        self.state.pre_auth_preset = None;
        self.state.volume = 0.0;
        self.state.amount = 0;
        self.state.nozzle_index = None;
        self.state.product_id = None;
        self.state.product_name = None;
        self.state.product_color = None;
    }

    pub fn ghost_recovery_active(&self) -> bool {
        self.ghost_recovery && self.consecutive_idle_polls < GHOST_RECOVERY_IDLE_POLLS
    }

    pub fn note_dispenser_poll(&mut self, saw_idle: bool) {
        if !self.ghost_recovery {
            return;
        }
        if saw_idle {
            self.consecutive_idle_polls = self.consecutive_idle_polls.saturating_add(1);
            if self.consecutive_idle_polls >= GHOST_RECOVERY_IDLE_POLLS {
                self.ghost_recovery = false;
                self.consecutive_idle_polls = 0;
            }
        } else {
            self.consecutive_idle_polls = 0;
        }
    }

    pub fn clear_ghost_recovery(&mut self) {
        self.ghost_recovery = false;
        self.consecutive_idle_polls = 0;
    }

    /// In preauth mode, wire AUTH is always operator-initiated (never fired by a bare nozzle lift).
    /// The operator picks Full / Volume / Amount from the UI after the nozzle is lifted.
    pub fn allow_reactive_nozzle_auth(&self, auth_mode: &str) -> bool {
        if self.ghost_recovery_active() {
            return false;
        }
        if auth_mode != "preauth" {
            return true;
        }
        // Preauth mode: never auto-authorize on lift — wait for the operator.
        // Holstered preauth (§8.4) is handled by start_delivery_from_pre_auth; it does not
        // need this path.
        false
    }

    pub fn mark_preauth_config_on_wire(&mut self) {
        self.preauth_config_on_wire = true;
        self.config_on_wire_at = Some(Utc::now().timestamp_millis());
        self.pending_authorize_config = false;
        self.pending_authorize_config_repeat = false;
    }

    /// True while we are still inside the post-CONFIG window where the pump emits its zero-volume
    /// holster echo. A holster frame here is that echo, not a real customer holster.
    fn within_config_echo_grace(&self) -> bool {
        self.config_on_wire_at
            .is_some_and(|t| Utc::now().timestamp_millis() - t < CONFIG_ECHO_GRACE_MS)
    }

    /// Mark that a pre-auth was just cancelled. Until the pump confirms idle, any delivery is
    /// treated as unauthorized (the pump may have stayed armed). Set by the CancelPreauth handler.
    pub fn mark_preauth_cancel_pending(&mut self) {
        self.preauth_cancel_pending = true;
        self.unauthorized_alerted = false;
    }

    /// Clear the post-cancel / unauthorized-delivery guards once the pump is confirmed idle or the
    /// lane is reset by the operator.
    pub fn clear_unauthorized_state(&mut self) {
        self.preauth_cancel_pending = false;
        self.unauthorized_alerted = false;
    }

    /// Called when CONFIG is sent immediately on nozzle-up (reactive mode).
    /// Sets Authorizing and marks CONFIG on wire so the Data-frame handler
    /// skips the deferred-CONFIG path and keepalive just sends BUSY.
    pub fn apply_nozzle_lift_config_sent(&mut self) {
        if !matches!(
            self.state.status,
            FpStatus::Authorizing | FpStatus::Delivering
        ) {
            self.zero_delivery_meters();
        }
        self.auth_session_started_at = Some(Utc::now().timestamp_millis());
        self.pending_authorize_config = false;
        self.pending_authorize_config_repeat = false;
        self.preauth_config_on_wire = true;
        self.state.status = FpStatus::Authorizing;
        self.touch();
    }

    /// Called for lift-first authorization: nozzle was already up when operator authorized.
    /// Defers CONFIG until the pump returns to IDLE (pump must be in IDLE to accept CONFIG).
    /// Sets pending_authorize_config_repeat=true so apply_idle_response sends CONFIG+BUSY.
    /// With preauth_config_on_wire=false, send_busy_keepalive skips BUSY so pump exits
    /// data-frame mode and returns to IDLE within a few poll cycles.
    pub fn apply_nozzle_lift_deferred_config(&mut self) {
        self.zero_delivery_meters();
        self.auth_session_started_at = Some(Utc::now().timestamp_millis());
        self.pending_authorize_config = false;
        self.pending_authorize_config_repeat = true;
        self.preauth_config_on_wire = false;
        self.state.status = FpStatus::Authorizing;
        self.touch();
    }

    /// Cancel a zero-volume authorization on the app side and enter ghost recovery
    /// so stray NozzleUp frames do not re-trigger AUTH.
    fn cancel_zero_volume_session(&mut self) {
        self.clear_deliver_caps();
        self.current_tx = None;
        self.reset_to_idle();
        self.ghost_recovery = true;
        self.consecutive_idle_polls = 0;
    }

    /// Abort a frozen tiny startup pulse without pretending the lifted hose is idle.
    fn cancel_startup_ghost_keep_nozzle_up(&mut self) {
        self.clear_deliver_caps();
        self.clear_decel_window();
        self.clear_continuation_fields();
        self.clear_unauthorized_state();
        self.current_tx = None;
        self.pre_auth = None;
        self.pre_auth_started_at = None;
        self.pending_authorize_config = false;
        self.pending_authorize_config_repeat = false;
        self.preauth_config_on_wire = false;
        self.auth_session_started_at = None;
        self.pending_holster_close = false;
        self.pump_sale_complete = false;
        self.state.status = FpStatus::NozzleUp;
        self.state.stop_source = None;
        self.state.pre_auth_preset = None;
        self.state.volume = 0.0;
        self.state.amount = 0;
        self.clear_startup_ghost_watch();
        self.ghost_recovery = true;
        self.consecutive_idle_polls = 0;
    }

    fn begin_auth_session(&mut self) {
        self.auth_session_started_at = Some(Utc::now().timestamp_millis());
        self.pending_authorize_config = true;
        self.pending_authorize_config_repeat = false;
    }

    /// `03 04 01 PP 00 HH` with holster code (`HH < 0x10`), standalone or inside composite fill.
    fn apply_nozzle_holstered(
        &mut self,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
        active_shift_id: Option<String>,
        active_operator_name: Option<String>,
    ) -> FrameEffect {
        if self.ghost_recovery_active() {
            self.touch();
            return FrameEffect::None;
        }
        // Decel window: nozzle holstered while waiting for decel resolution → commit stopped.
        if self.in_decel_window()
            && matches!(
                self.state.status,
                FpStatus::Authorizing | FpStatus::Delivering
            )
        {
            let (vol, amt) = self.combined_totals();
            if vol < 0.01 && amt == 0 {
                self.clear_decel_window();
                self.cancel_zero_volume_session();
                self.touch();
                return FrameEffect::CompleteGhostFill;
            }
            let preset = self
                .decel_pending_preset
                .take()
                .unwrap_or_else(|| self.last_preset.clone());
            let ss = self.decel_pending_stop_source;
            self.clear_decel_window();
            return self.enter_stopped_state(
                fp_cfg,
                site,
                active_shift_id,
                active_operator_name,
                preset,
                ss,
            );
        }
        match self.state.status {
            FpStatus::Authorizing | FpStatus::Delivering => {
                let (vol, amt) = self.combined_totals();
                if vol < 0.01 && amt == 0 {
                    if (self.within_config_echo_grace()
                        && self.state.status == FpStatus::Authorizing)
                        || self.nozzle_physically_up()
                    {
                        // Post-CONFIG holster echo (here as a standalone NozzleReturned) or a still-up
                        // nozzle — keep the lane armed instead of de-authorizing it.
                        self.touch();
                        return FrameEffect::StatusChanged;
                    }
                    self.cancel_zero_volume_session();
                    self.touch();
                    FrameEffect::CompleteGhostFill
                } else if self.holster_ends_sale_early() {
                    // Early abort (operator pulled nozzle before preset) — finalize immediately.
                    self.pending_holster_close = false;
                    self.end_sale_from_holster_early(
                        fp_cfg,
                        site,
                        active_shift_id,
                        active_operator_name,
                    )
                } else if self.pending_holster_close {
                    // Second holster event (or fallback after deferral) — finalize now.
                    self.pending_holster_close = false;
                    self.complete_sale_from_holster(
                        fp_cfg,
                        site,
                        active_shift_id,
                        active_operator_name,
                    )
                } else {
                    // First holster event: defer one poll cycle so the pump can send its final
                    // Data frame carrying the true pump-counter reading before we record.
                    self.pending_holster_close = true;
                    self.touch();
                    FrameEffect::StatusChanged
                }
            }
            FpStatus::PreAuthorized => {
                // Customer confirmed the lift (set by NozzleUp handler) — they have now
                // holstered.  Cancel the pre-auth completely; do not keep it alive.
                if self.preauth_nozzle_confirmed {
                    self.cancel_pre_auth();
                    self.touch();
                    return FrameEffect::NozzleHolstered;
                }
                if self.preauth_config_on_wire {
                    // Pump confirming nozzle-holstered state after receiving CONFIG,
                    // before the customer has touched the nozzle.  Keep pre-auth alive.
                    self.touch();
                    FrameEffect::None
                } else if self.preauth_mismatch_active {
                    self.touch();
                    FrameEffect::None
                } else {
                    self.cancel_zero_volume_session();
                    self.touch();
                    FrameEffect::NozzleHolstered
                }
            }
            FpStatus::Done => {
                // Sale is already recorded. Stay in Done so the operator (or
                // the frontend auto-dismiss) can close the screen cleanly.
                // reset_to_idle here would clear nozzle_index and let stray
                // post-holster data frames restart a ghost delivery.
                self.touch();
                FrameEffect::StatusChanged
            }
            FpStatus::NozzleUp => {
                self.reset_to_idle();
                self.touch();
                FrameEffect::StatusChanged
            }
            FpStatus::Stopped {
                stop_source: StopSource::AppFinal,
                ..
            } => {
                // Stop mode (no resume): nozzle holstered → finalize as Completed.
                let tx = self.finalize_stopped_sale(
                    fp_cfg,
                    site,
                    active_shift_id,
                    active_operator_name,
                    true,
                );
                FrameEffect::TransactionDone {
                    tx,
                    action: TxCompleteAction::AcknowledgeIdle,
                }
            }
            FpStatus::Stopped {
                stop_source: StopSource::App,
                ref stopped_tx_id,
                ..
            } => {
                // Paused fill: pump sent NozzleReturned while we were in pause state.
                // Finalize as STOPPED and emit NozzleRemoved so the poll_loop persists it.
                let tx_id = stopped_tx_id.clone();
                let fp_id = self.state.fp_id.clone();
                let tx = self.finalize_stopped_sale(
                    fp_cfg,
                    site,
                    active_shift_id,
                    active_operator_name,
                    false,
                );
                FrameEffect::NozzleRemoved {
                    fp_id,
                    stopped_tx_id: Some(tx_id),
                    tx,
                }
            }
            FpStatus::Stopped {
                stop_source: StopSource::External,
                ..
            } => {
                // Pump-side stop: nozzle holstered → finalize as STOPPED (operator review).
                let tx = self.finalize_stopped_sale(
                    fp_cfg,
                    site,
                    active_shift_id,
                    active_operator_name,
                    false,
                );
                FrameEffect::TransactionDone {
                    tx,
                    action: TxCompleteAction::AcknowledgeIdle,
                }
            }
            _ => {
                self.reset_to_idle();
                self.touch();
                FrameEffect::StatusChanged
            }
        }
    }

    /// Holster / idle frame (`70 FA`) — handle by current lane status.
    pub fn apply_idle_response(
        &mut self,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
        active_shift_id: Option<String>,
        active_operator_name: Option<String>,
    ) -> FrameEffect {
        use FpStatus::*;

        match &self.state.status {
            Offline => {
                self.state.status = Idle;
                self.state.pre_auth_preset = None;
                self.clear_unauthorized_state();
                self.touch();
                FrameEffect::Online
            }
            Idle => {
                // Pump confirmed idle — a cancelled pre-auth (if any) is now de-authorized.
                self.clear_unauthorized_state();
                self.touch();
                FrameEffect::None
            }
            Done => {
                // Pump holstered after DONE ack — lane may go idle on the wire while we keep
                // the completed sale visible until the desktop operator starts the next session.
                self.touch();
                FrameEffect::None
            }
            Stopped {
                stop_source: StopSource::App,
                stopped_tx_id,
                ..
            } => {
                let tx_id = stopped_tx_id.clone();
                if self.stopped_nozzle_up {
                    // Stopped while filling: nozzle is still in the tank and the pump is just
                    // polling idle. Keep showing the paused sale; finalize on the real holster.
                    self.touch();
                    return FrameEffect::StatusChanged;
                }
                let tx = self.finalize_stopped_sale(
                    fp_cfg,
                    site,
                    active_shift_id,
                    active_operator_name,
                    false,
                );
                FrameEffect::NozzleRemoved {
                    fp_id: self.state.fp_id.clone(),
                    stopped_tx_id: Some(tx_id),
                    tx,
                }
            }
            Stopped {
                stop_source: StopSource::AppFinal,
                ..
            } => {
                if self.stopped_nozzle_up {
                    // Stopped while filling (terminal): nozzle still up, pump polling idle.
                    // Keep showing STOPPED until the customer holsters (NozzleReturned finalizes).
                    self.touch();
                    return FrameEffect::StatusChanged;
                }
                // Stop mode (no resume): nozzle-down or idle → finalize as Completed.
                let tx = self.finalize_stopped_sale(
                    fp_cfg,
                    site,
                    active_shift_id,
                    active_operator_name,
                    true,
                );
                FrameEffect::TransactionDone {
                    tx,
                    action: TxCompleteAction::AcknowledgeIdle,
                }
            }
            Stopped {
                stop_source: StopSource::External,
                ..
            } => {
                let tx = self.finalize_stopped_sale(
                    fp_cfg,
                    site,
                    active_shift_id,
                    active_operator_name,
                    false,
                );
                FrameEffect::TransactionDone {
                    tx,
                    action: TxCompleteAction::AcknowledgeIdle,
                }
            }
            PreAuthorized => {
                // Holstered while waiting for the correct nozzle — keep pre-auth active.
                self.touch();
                FrameEffect::None
            }
            NozzleUp => {
                // Holstered preauth or lift-first arming: idle polls are BUSY only (see poll_loop).
                self.touch();
                if self.preauth_config_on_wire
                    || self.pre_auth.is_some()
                    || self.preauth_session_armed()
                    || self.current_tx.is_some()
                {
                    FrameEffect::None
                } else {
                    FrameEffect::ResendAuthorize
                }
            }
            Authorizing => {
                // Decel window: PAUSE was pressed while in Authorizing state; idle frame
                // confirms nozzle is down — commit the paused transaction exactly as the
                // Delivering branch does.
                if self.in_decel_window() {
                    let (vol, amt) = self.combined_totals();
                    if vol < 0.01 && amt == 0 {
                        self.clear_decel_window();
                        self.cancel_zero_volume_session();
                        self.touch();
                        return FrameEffect::CompleteGhostFill;
                    }
                    let preset = self
                        .decel_pending_preset
                        .take()
                        .unwrap_or_else(|| self.last_preset.clone());
                    let ss = self.decel_pending_stop_source;
                    self.clear_decel_window();
                    return self.enter_stopped_state(
                        fp_cfg,
                        site,
                        active_shift_id,
                        active_operator_name,
                        preset,
                        ss,
                    );
                }
                if self.pending_authorize_config_repeat {
                    self.pending_authorize_config_repeat = false;
                    self.preauth_config_on_wire = true;
                    self.touch();
                    return FrameEffect::SendAuthorizeConfig;
                }
                let (vol, amt) = self.combined_totals();
                if vol < 0.01 && amt == 0 {
                    // Preauth + lift: AUTH/CONFIG already sent; idle polls are BUSY only (no AUTH spam).
                    if self.nozzle_physically_up() {
                        self.touch();
                        return FrameEffect::None;
                    }
                    if self.preauth_session_armed() {
                        // Lift-first authorization can sit on zero-volume IDLE frames
                        // until Wayne accepts CONFIG and starts metering.  A real cancel
                        // arrives as NozzleReturned, so don't clear the selected preset/nozzle
                        // just because the lift timestamp aged out.  NOTE: this must NOT also
                        // require current_tx.is_none() — deferred lift-first arming sets
                        // current_tx the instant the lift is confirmed, so gating on it here
                        // would ghost-cancel a still-up nozzle the moment the lift code goes stale.
                        self.touch();
                        return FrameEffect::None;
                    }
                    if self.current_tx.is_some() {
                        self.cancel_zero_volume_session();
                        self.touch();
                        return FrameEffect::CompleteGhostFill;
                    }
                    self.touch();
                    return FrameEffect::ResendAuthorize;
                }
                if self.nozzle_physically_up() {
                    self.touch();
                    return FrameEffect::None;
                }
                // During continuation re-authorization the lane has base volume > 0 but the
                // nozzle is not yet physically up (customer hasn't lifted yet, or nozzle was
                // holstered after an external stop).  The pump sends idle polls while waiting
                // for the customer to lift — don't treat this as a premature holster event.
                if self.continuation.is_some() {
                    self.touch();
                    return FrameEffect::None;
                }
                if self.holster_ends_sale_early() {
                    return self.end_sale_from_holster_early(
                        fp_cfg,
                        site,
                        active_shift_id,
                        active_operator_name,
                    );
                }
                if self.current_tx.is_some() {
                    return self.complete_sale_from_holster(
                        fp_cfg,
                        site,
                        active_shift_id,
                        active_operator_name,
                    );
                }
                self.clear_deliver_caps();
                self.reset_to_idle();
                self.touch();
                FrameEffect::StatusChanged
            }
            Delivering => {
                if self.in_decel_window() {
                    let (vol, amt) = self.combined_totals();
                    if vol < 0.01 && amt == 0 {
                        self.clear_decel_window();
                        self.cancel_zero_volume_session();
                        self.touch();
                        return FrameEffect::CompleteGhostFill;
                    }
                    let preset = self
                        .decel_pending_preset
                        .take()
                        .unwrap_or_else(|| self.last_preset.clone());
                    let ss = self.decel_pending_stop_source;
                    self.clear_decel_window();
                    return self.enter_stopped_state(
                        fp_cfg,
                        site,
                        active_shift_id,
                        active_operator_name,
                        preset,
                        ss,
                    );
                }
                let (vol, amt) = self.combined_totals();
                if vol < 0.01 && amt == 0 {
                    // Keep an armed lane alive while the nozzle is up; deferred arming sets
                    // current_tx the instant the lift is confirmed, so do NOT gate on current_tx.
                    if self.nozzle_physically_up() || self.preauth_session_armed() {
                        self.touch();
                        return FrameEffect::None;
                    }
                    self.cancel_zero_volume_session();
                    self.touch();
                    return FrameEffect::CompleteGhostFill;
                }
                if self.nozzle_physically_up() {
                    self.touch();
                    return FrameEffect::None;
                }
                if !self.pending_holster_close {
                    // Nozzle physically-up expired by staleness only — no explicit holster
                    // frame received.  Keep waiting to avoid showing Done prematurely.
                    self.touch();
                    return FrameEffect::None;
                }
                self.pending_holster_close = false;
                if self.holster_ends_sale_early() {
                    return self.end_sale_from_holster_early(
                        fp_cfg,
                        site,
                        active_shift_id,
                        active_operator_name,
                    );
                }
                self.complete_sale_from_holster(fp_cfg, site, active_shift_id, active_operator_name)
            }
        }
    }

    fn finalize_stopped_sale(
        &mut self,
        fp_cfg: &FuelingPositionConfig,
        _site: &SiteConfig,
        active_shift_id: Option<String>,
        active_operator_name: Option<String>,
        completed_normally: bool,
    ) -> Transaction {
        let fp_id = self.state.fp_id.clone();
        let label = self.state.label.clone();
        let sc = self.stopped_context.take();
        let (vol, amt, tx_id, nozzle_index, product_id, product_name, price, started_at) =
            if let Some(sc) = sc {
                (
                    sc.stopped_volume,
                    sc.stopped_amount,
                    sc.stopped_tx_id,
                    sc.nozzle_index,
                    self.state.product_id.unwrap_or(0),
                    self.state.product_name.clone().unwrap_or_default(),
                    sc.price,
                    self.state.updated_at,
                )
            } else if let FpStatus::Stopped {
                stopped_volume,
                stopped_amount,
                stopped_tx_id,
                ..
            } = &self.state.status
            {
                (
                    *stopped_volume,
                    *stopped_amount,
                    stopped_tx_id.clone(),
                    self.state.nozzle_index.unwrap_or(1),
                    self.state.product_id.unwrap_or(0),
                    self.state.product_name.clone().unwrap_or_default(),
                    self.state.price,
                    self.state.updated_at,
                )
            } else {
                (
                    self.state.volume,
                    self.state.amount,
                    self.state
                        .stopped_tx_id
                        .clone()
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    self.state.nozzle_index.unwrap_or(1),
                    self.state.product_id.unwrap_or(0),
                    self.state.product_name.clone().unwrap_or_default(),
                    self.state.price,
                    self.state.updated_at,
                )
            };
        let status = TxStatus::resolve(vol, completed_normally);
        self.reset_to_idle();
        Transaction {
            id: tx_id,
            fp_id,
            label,
            address_byte: fp_cfg.address_byte,
            started_at,
            completed_at: Some(Utc::now().timestamp_millis()),
            volume: vol,
            amount: amt,
            price,
            nozzle_index,
            product_id,
            product_name,
            status,
            shift_id: active_shift_id,
            operator_name: active_operator_name,
            parent_tx_id: None,
            combined_volume: vol,
            combined_amount: amt,
        }
    }

    /// Dispenser short `01 01 05` — idle/ready after ghost-fill holster (sniffer §ghost fill).
    fn apply_dispenser_idle(
        &mut self,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
        active_shift_id: Option<String>,
        active_operator_name: Option<String>,
    ) -> FrameEffect {
        if self.in_decel_window()
            && matches!(
                self.state.status,
                FpStatus::Authorizing | FpStatus::Delivering
            )
        {
            let preset = self
                .decel_pending_preset
                .take()
                .unwrap_or_else(|| self.last_preset.clone());
            let ss = self.decel_pending_stop_source;
            self.clear_decel_window();
            return self.enter_stopped_state(
                fp_cfg,
                site,
                active_shift_id,
                active_operator_name,
                preset,
                ss,
            );
        }
        if matches!(
            self.state.status,
            FpStatus::Authorizing | FpStatus::Delivering | FpStatus::NozzleUp
        ) {
            let (vol, amt) = self.combined_totals();
            if vol < 0.01 && amt == 0 {
                if self.nozzle_physically_up() {
                    self.touch();
                    return FrameEffect::StatusChanged;
                }
                // Deferred lift-first preauth sets current_tx the instant the lift is confirmed, so
                // keep the armed zero-volume lane alive on idle/done frames regardless of current_tx;
                // a real cancel arrives as a holster frame (NozzleReturned/NozzleHolstered), not an idle.
                if self.state.status == FpStatus::Authorizing && self.preauth_session_armed() {
                    self.touch();
                    return FrameEffect::StatusChanged;
                }
                self.cancel_zero_volume_session();
                self.touch();
                return FrameEffect::CompleteGhostFill;
            }
            if self.nozzle_physically_up() {
                self.pump_sale_complete = true;
                self.touch();
                return FrameEffect::SendDoneAwaitHolster;
            }
        }
        if matches!(self.state.status, FpStatus::Idle | FpStatus::PreAuthorized) {
            if self.ghost_recovery_active() {
                self.touch();
                return FrameEffect::None;
            }
            self.reset_to_idle();
            self.touch();
            return FrameEffect::CompleteGhostFill;
        }
        self.apply_done_response(fp_cfg, site, active_shift_id, active_operator_name)
    }

    /// Done frame (`01 01 05` legacy / composite tail) when not already handled by delivery.
    pub fn apply_done_response(
        &mut self,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
        active_shift_id: Option<String>,
        active_operator_name: Option<String>,
    ) -> FrameEffect {
        if matches!(self.state.status, FpStatus::Done) {
            self.touch();
            return FrameEffect::StatusChanged;
        }
        if self.continuation.is_some() {
            self.touch();
            return FrameEffect::StatusChanged;
        }
        if let FpStatus::Stopped {
            stop_source: StopSource::External,
            ..
        } = &self.state.status
        {
            // Lane is paused (nozzle holstered mid-fill). Ignore DONE frames until the
            // operator continues or holsters again (idle frame finalizes the sale).
            self.touch();
            return FrameEffect::StatusChanged;
        }
        if matches!(
            self.state.status,
            FpStatus::Delivering | FpStatus::Authorizing
        ) {
            let (vol, amt) = self.combined_totals();
            if vol < 0.01 && amt == 0 {
                if self.nozzle_physically_up() {
                    self.touch();
                    return FrameEffect::StatusChanged;
                }
                // Deferred lift-first preauth sets current_tx the instant the lift is confirmed, so
                // keep the armed zero-volume lane alive on idle/done frames regardless of current_tx;
                // a real cancel arrives as a holster frame (NozzleReturned/NozzleHolstered), not an idle.
                if self.state.status == FpStatus::Authorizing && self.preauth_session_armed() {
                    self.touch();
                    return FrameEffect::StatusChanged;
                }
                self.cancel_zero_volume_session();
                self.touch();
                return FrameEffect::CompleteGhostFill;
            }
            // Nozzle still physically in the tank — pump sent a completion frame
            // (TransactionComplete / DispenserIdle) but the customer hasn't holstered
            // yet.  Send GO_IDLE so the pump can send NozzleReturned, then wait for
            // that physical holster event to record the transaction.
            if self.nozzle_physically_up() {
                self.touch();
                return FrameEffect::SendDoneAwaitHolster;
            }
            if !self.pending_holster_close {
                // nozzle_physically_up() is false only due to the staleness timer —
                // no explicit NozzleReturned received yet.  Keep waiting.
                self.touch();
                return FrameEffect::SendDoneAwaitHolster;
            }
            self.pending_holster_close = false;
            if self.holster_ends_sale_early() {
                return self.end_sale_from_holster_early(
                    fp_cfg,
                    site,
                    active_shift_id,
                    active_operator_name,
                );
            }
            return self.complete_sale_from_holster(
                fp_cfg,
                site,
                active_shift_id,
                active_operator_name,
            );
        }
        if matches!(self.state.status, FpStatus::Idle | FpStatus::NozzleUp) {
            let (vol, amt) = self.combined_totals();
            if vol < 0.01 && amt == 0 {
                if self.ghost_recovery_active() {
                    self.touch();
                    return FrameEffect::None;
                }
                self.reset_to_idle();
                self.touch();
                return FrameEffect::CompleteGhostFill;
            }
        }
        self.touch();
        FrameEffect::StatusChanged
    }

    /// Lane has an operator-visible pre-auth that can be cancelled from the UI.
    pub fn has_cancellable_preauth(&self) -> bool {
        self.pre_auth.is_some()
            || self.preauth_config_on_wire
            || self.state.pre_auth_preset.is_some()
            || matches!(self.state.status, FpStatus::PreAuthorized)
            || (matches!(
                self.state.status,
                FpStatus::NozzleUp | FpStatus::Authorizing
            ) && self.state.pre_auth_preset.is_some())
    }

    pub fn cancel_pre_auth(&mut self) {
        self.pre_auth = None;
        self.pre_auth_started_at = None;
        self.preauth_nozzle_confirmed = false;
        self.preauth_mismatch_active = false;
        self.clear_ghost_recovery();
        self.clear_deliver_caps();
        self.preauth_config_on_wire = false;
        self.config_on_wire_at = None;
        self.pending_authorize_config = false;
        self.pending_authorize_config_repeat = false;
        self.auth_session_started_at = None;
        self.current_tx = None;
        self.state.pre_auth_preset = None;
        self.state.status = FpStatus::Idle;
        self.zero_delivery_meters();
        self.state.nozzle_index = None;
        self.state.product_id = None;
        self.state.product_name = None;
        self.state.product_color = None;
        self.last_wire_hose_code = None;
        self.last_wire_hose_at_ms = 0;
        self.touch();
    }

    fn cancel_pre_auth_after_nozzle_mismatch(&mut self) {
        self.cancel_pre_auth();
        self.ghost_recovery = true;
        self.consecutive_idle_polls = 0;
    }

    pub fn apply_preauthorize_sent(
        &mut self,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
        nozzle_index: u8,
        price: u32,
        preset: Preset,
    ) -> PreauthOutcome {
        // TOCTOU guard: the API queued this Preauthorize while the lane was Idle, but a NozzleUp
        // for a DIFFERENT nozzle was processed before we drained the command. Do not arm CONFIG
        // for the wrong product — emit a mismatch and leave the lane on the lifted (wrong) nozzle
        // so the operator can holster and re-authorize. (Mirrors Gilbarco, which never touches the
        // wire until the lifted nozzle is confirmed.)  nozzle_index == None while NozzleUp is
        // defensive: we cannot prove a conflict, so fall through to the normal path.
        if self.state.status == FpStatus::NozzleUp {
            if let Some(up) = self.state.nozzle_index {
                if up != nozzle_index {
                    let (expected_name, _, _) = lookup_nozzle(site, fp_cfg, nozzle_index);
                    let (lifted_name, _, _) = lookup_nozzle(site, fp_cfg, up);
                    self.preauth_nozzle_confirmed = false;
                    self.preauth_mismatch_active = false;
                    self.touch();
                    return PreauthOutcome::NozzleMismatch {
                        expected_nozzle_index: nozzle_index,
                        expected_product_name: expected_name,
                        lifted_nozzle_index: up,
                        lifted_product_name: lifted_name,
                    };
                }
            }
        }
        if self.state.status == FpStatus::Done {
            self.state.volume = 0.0;
            self.state.amount = 0;
            self.state.pre_auth_preset = None;
        }
        self.set_last_preset(preset);
        let b = fp_cfg.address_byte;
        let (name, pid, color) = lookup_nozzle(site, fp_cfg, nozzle_index);
        self.pre_auth = Some(PreAuthContext {
            nozzle_index,
            product_id: pid,
        });
        self.pre_auth_started_at = Some(Utc::now().timestamp_millis());
        self.preauth_nozzle_confirmed = false;
        self.preauth_mismatch_active = false;
        self.clear_ghost_recovery();
        let nozzle_already_up = self.state.status == FpStatus::NozzleUp
            && self.state.nozzle_index == Some(nozzle_index);
        self.state.status = FpStatus::PreAuthorized;
        self.state.nozzle_index = Some(nozzle_index);
        self.state.product_id = Some(pid);
        self.state.product_name = Some(name);
        self.state.product_color = Some(color);
        self.state.price = price;
        self.zero_delivery_meters();
        self.state.pre_auth_preset = Some(preset_label(&self.last_preset));
        self.state.seq = 0;
        // Lift-first: CONFIG is sent in poll_loop after this; delivery starts there too.
        if nozzle_already_up {
            self.preauth_nozzle_confirmed = true;
        }
        let _ = b;
        self.touch();
        if self.preauth_nozzle_confirmed {
            PreauthOutcome::LiftConfirmed
        } else {
            PreauthOutcome::Holstered
        }
    }

    /// Returns `Some(mismatch effect)` when the lifted nozzle does not match pre-authorization.
    /// A mismatch cancels the old preauth immediately so the pump cannot continue
    /// delivering with stale operator-entered fill data.
    fn check_preauth_nozzle(
        &mut self,
        lifted_product: u8,
        lifted_wayne_code: u8,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
    ) -> Option<FrameEffect> {
        let pre = self.pre_auth.as_ref()?;
        let (lifted_idx, lifted_name, _, _) =
            resolve_wayne_nozzle(site, fp_cfg, lifted_product, lifted_wayne_code);
        if lifted_idx == pre.nozzle_index {
            return None;
        }
        let (expected_name, _, _) = lookup_nozzle(site, fp_cfg, pre.nozzle_index);
        let expected_nozzle_index = pre.nozzle_index;
        self.cancel_pre_auth_after_nozzle_mismatch();
        Some(FrameEffect::PreAuthNozzleMismatch {
            expected_nozzle_index,
            expected_product_name: expected_name,
            lifted_nozzle_index: lifted_idx,
            lifted_product_name: lifted_name,
        })
    }

    pub(crate) fn start_delivery_from_pre_auth(
        &mut self,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
    ) {
        let nozzle_index = self
            .pre_auth
            .as_ref()
            .map(|p| p.nozzle_index)
            .or(self.state.nozzle_index)
            .unwrap_or(1);
        let (pname, pid, color) = lookup_nozzle(site, fp_cfg, nozzle_index);
        self.state.nozzle_index = Some(nozzle_index);
        self.state.product_id = Some(pid);
        self.state.product_name = Some(pname.clone());
        self.state.product_color = Some(color);
        self.pre_auth = None;
        self.preauth_nozzle_confirmed = false;
        if self.state.pre_auth_preset.is_none() {
            self.state.pre_auth_preset = Some(preset_label(&self.last_preset));
        }
        self.zero_delivery_meters();
        // If CONFIG is not yet on the wire, schedule it for the first Data frame.
        // If it was already sent (holstered preauth or reactive lift), preserve that
        // state so the Data-frame handler skips SendAuthorizeConfig.
        if !self.preauth_config_on_wire {
            self.begin_auth_session();
        } else {
            self.auth_session_started_at = Some(Utc::now().timestamp_millis());
            self.pending_authorize_config = false;
            self.pending_authorize_config_repeat = false;
        }
        self.state.status = FpStatus::Authorizing;
        self.current_tx = Some(CurrentTx {
            id: Uuid::new_v4().to_string(),
            started_at: Utc::now().timestamp_millis(),
            product_id: pid,
            product_name: pname,
            nozzle_index,
        });
    }

    /// Operator acknowledged a completed/ended sale — return lane to idle for the next customer.
    pub fn operator_dismiss_display(&mut self, fp: &FuelingPositionConfig) -> Result<(), String> {
        use FpStatus::*;
        match self.state.status {
            Done | Idle => {
                self.reset_for_operator(fp);
                Ok(())
            }
            Stopped { .. } => {
                Err("sale is paused — close the transaction or continue the fill".into())
            }
            Delivering | Authorizing | PreAuthorized | NozzleUp => {
                Err("pump is still active".into())
            }
            Offline => {
                self.reset_for_operator(fp);
                Ok(())
            }
        }
    }

    pub fn reset_for_operator(&mut self, fp: &FuelingPositionConfig) {
        self.clear_deliver_caps();
        self.clear_decel_window();
        self.current_tx = None;
        self.stopped_context = None;
        self.continuation = None;
        self.clear_completed_sale_latch();
        self.clear_unauthorized_state();
        self.pre_auth = None;
        self.missed = 0;
        self.settle_after_reconnect = 0;
        self.state.missed_polls = 0;
        self.nozzle_prices.clear();
        for n in fp.nozzles.iter().filter(|n| n.active) {
            self.nozzle_prices.insert(n.index, n.price);
        }
        let price = fp.default_price().unwrap_or(0);
        let now = Utc::now().timestamp_millis();
        self.state.volume = 0.0;
        self.state.amount = 0;
        self.state.status = FpStatus::Idle;
        self.state.nozzle_index = None;
        self.state.product_id = None;
        self.state.product_name = None;
        self.state.product_color = None;
        self.state.price = price;
        self.state.seq = 0;
        self.state.updated_at = now;
        self.state.pre_auth_preset = None;
        self.state.stop_source = None;
        self.clear_ghost_recovery();
        self.clear_continuation_fields();
        self.touch();
    }

    pub fn on_poll_success(&mut self) {
        self.missed = 0;
        self.state.missed_polls = 0;
        if self.settle_after_reconnect > 0 {
            self.settle_after_reconnect -= 1;
        }
        self.touch();
    }

    pub fn on_poll_missed(&mut self, threshold: u32) -> bool {
        self.missed += 1;
        self.state.missed_polls = self.missed;
        self.touch();
        if matches!(
            self.state.status,
            FpStatus::NozzleUp
                | FpStatus::PreAuthorized
                | FpStatus::Authorizing
                | FpStatus::Delivering
                | FpStatus::Done
        ) || self.preauth_session_armed()
            || self.current_tx.is_some()
            || self.completed_sale.is_some()
        {
            return false;
        }
        if self.missed >= threshold && self.state.status != FpStatus::Offline {
            self.state.status = FpStatus::Offline;
            return true;
        }
        false
    }

    pub fn on_reconnect_flush(&mut self, rounds: u32) {
        self.settle_after_reconnect = rounds;
    }

    pub fn apply_frame(
        &mut self,
        frame: &Frame,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
        active_shift_id: Option<String>,
        active_operator_name: Option<String>,
    ) -> FrameEffect {
        if self.settle_after_reconnect > 0 {
            return FrameEffect::None;
        }
        let b = fp_cfg.address_byte;
        match frame {
            Frame::Idle { addr } if *addr == b => {
                self.apply_idle_response(fp_cfg, site, active_shift_id, active_operator_name)
            }
            Frame::NozzleHolstered { addr, .. } if *addr == b => {
                // A holster frame means the nozzle is back in the boot — clear the
                // stopped-with-nozzle-up guard so a STOPPED sale can finalize on this event
                // (NozzleHolstered for a stopped lane delegates to apply_idle_response below).
                self.stopped_nozzle_up = false;
                match self.state.status {
                    FpStatus::Authorizing | FpStatus::Delivering => {
                        let (vol, amt) = self.combined_totals();
                        if vol < 0.01 && amt == 0 {
                            if self.within_config_echo_grace()
                                && self.state.status == FpStatus::Authorizing
                            {
                                // Pump's post-CONFIG holster echo, not a customer holster —
                                // keep the lane armed so fueling can start.
                                self.touch();
                                FrameEffect::StatusChanged
                            } else if self.nozzle_physically_up() {
                                self.touch();
                                FrameEffect::StatusChanged
                            } else {
                                self.cancel_zero_volume_session();
                                self.touch();
                                FrameEffect::CompleteGhostFill
                            }
                        } else {
                            // Nozzle holstered mid-fill — close the transaction the
                            // same way NozzleReturned does. NozzleHolstered carries no
                            // hose code so note_wire_hose is not called, but
                            // apply_nozzle_holstered does not check nozzle_physically_up()
                            // on the vol > 0 path, so it is safe to delegate directly.
                            self.apply_nozzle_holstered(
                                fp_cfg,
                                site,
                                active_shift_id,
                                active_operator_name.clone(),
                            )
                        }
                    }
                    FpStatus::PreAuthorized => {
                        // Customer confirmed the lift and has now holstered — cancel.
                        if self.preauth_nozzle_confirmed {
                            self.cancel_pre_auth();
                            self.touch();
                            return FrameEffect::NozzleHolstered;
                        }
                        if self.preauth_config_on_wire {
                            // Pump confirming nozzle-holstered state after receiving CONFIG,
                            // before the customer has touched the nozzle.  Keep pre-auth alive.
                            self.touch();
                            FrameEffect::None
                        } else if self.preauth_mismatch_active {
                            // Mismatch recovery: customer holstering wrong nozzle before
                            // lifting the correct one — keep pre-auth alive.
                            self.touch();
                            FrameEffect::None
                        } else {
                            // Nozzle holstered before delivery started — cancel pre-auth.
                            self.cancel_zero_volume_session();
                            self.touch();
                            FrameEffect::NozzleHolstered
                        }
                    }
                    _ => self.apply_idle_response(
                        fp_cfg,
                        site,
                        active_shift_id,
                        active_operator_name.clone(),
                    ),
                }
            }
            Frame::NozzleReturned { addr, hose, .. } if *addr == b => {
                // Update the hose code before calling apply_nozzle_holstered so that
                // nozzle_physically_up() sees the holster byte (< 0x10) and returns
                // false.  The previous guard (skip cancel while nozzle_physically_up())
                // caused genuine customer holsters to be silently ignored when the lift
                // was less than WIRE_LIFT_STALE_MS old, leaving the preauth visible on
                // the next lift.
                self.note_wire_hose(*hose);
                self.apply_nozzle_holstered(fp_cfg, site, active_shift_id, active_operator_name)
            }
            Frame::NozzleUp {
                addr,
                seq,
                product,
                nozzle,
                ..
            } if *addr == b => {
                self.note_wire_hose(*nozzle);
                let (cfg_idx, name, pid, color) =
                    resolve_wayne_nozzle(site, fp_cfg, *product, *nozzle);
                if self.state.status == FpStatus::Done {
                    // A physical lift after DONE is a new customer session even when it is
                    // the same hose as the completed sale.  Previously the same-hose path
                    // reset to IDLE but left completed_sale latched, so the UI could keep
                    // showing "filled" and later meter frames were ignored.
                    self.clear_completed_sale_latch();
                    self.state.status = FpStatus::NozzleUp;
                    self.zero_delivery_meters();
                    self.state.nozzle_index = Some(cfg_idx);
                    self.state.product_id = Some(pid);
                    self.state.product_name = Some(name.clone());
                    self.state.product_color = Some(color.clone());
                    let p = self
                        .nozzle_prices
                        .get(&cfg_idx)
                        .copied()
                        .or_else(|| site.price_for(b, cfg_idx))
                        .unwrap_or(self.state.price);
                    self.state.price = p;
                    self.touch();
                    return FrameEffect::NozzleUp {
                        nozzle_index: cfg_idx,
                        product_id: pid,
                        product_name: name,
                        product_color: color,
                        price: p,
                    };
                }
                if self.ghost_recovery_active() {
                    self.clear_ghost_recovery();
                }
                if matches!(
                    self.state.status,
                    FpStatus::Authorizing | FpStatus::Delivering
                ) {
                    // Repeated lift notifications while arming — stay in session.
                    self.touch();
                    return FrameEffect::StatusChanged;
                }
                if self.pre_auth.is_some() {
                    self.state.seq = *seq;
                    if let Some(effect) = self.check_preauth_nozzle(*product, *nozzle, fp_cfg, site)
                    {
                        self.preauth_mismatch_active = true;
                        self.touch();
                        return effect;
                    }
                    self.preauth_mismatch_active = false;
                    self.preauth_nozzle_confirmed = true;
                    self.zero_delivery_meters();
                    self.state.status = FpStatus::NozzleUp;
                    // Wire AUTH + start_delivery run in poll_loop after this frame.
                    let nozzle_index = self.state.nozzle_index.unwrap_or(1);
                    let product_id = self.state.product_id.unwrap_or(0);
                    let product_name = self.state.product_name.clone().unwrap_or_default();
                    let product_color = self.state.product_color.clone().unwrap_or_default();
                    let price = self.state.price;
                    self.touch();
                    return FrameEffect::NozzleUp {
                        nozzle_index,
                        product_id,
                        product_name,
                        product_color,
                        price,
                    };
                }
                let continuing = self.continuation.is_some();
                self.state.seq = *seq;
                if continuing {
                    // Continuation (E-stop resume / Continue fill): the nozzle identity
                    // is fixed by the stopped context.  Re-derive display names from
                    // config so they stay in sync with any admin catalog changes, but do
                    // NOT re-resolve the nozzle index from the wire — some Wayne firmware
                    // variants change the PP byte after E-stop re-authorization, which
                    // would cause the wrong product to be shown on the pump card and
                    // written into the continuation transaction.
                    let existing_nozzle = self.state.nozzle_index.unwrap_or(1);
                    let (name, pid, color) = lookup_nozzle(site, fp_cfg, existing_nozzle);
                    self.state.nozzle_index = Some(existing_nozzle);
                    self.state.product_id = Some(pid);
                    self.state.product_name = Some(name);
                    self.state.product_color = Some(color);
                    if matches!(self.state.status, FpStatus::Idle | FpStatus::NozzleUp)
                        || self.state.status.is_stopped()
                    {
                        self.state.status = FpStatus::Authorizing;
                    }
                    self.touch();
                    return FrameEffect::StatusChanged;
                } else if let Some(sc) = self.stopped_context.clone() {
                    // Nozzle lifted while paused — keep stopped totals; use Continue/Resume, not new authorize.
                    self.apply_stopped_display(
                        sc.stopped_volume,
                        sc.stopped_amount,
                        sc.stopped_tx_id,
                        sc.stop_source,
                    );
                    self.state.price = sc.price;
                    self.state.nozzle_index = Some(sc.nozzle_index);
                    let (name, pid, color) = lookup_nozzle(site, fp_cfg, sc.nozzle_index);
                    self.state.product_id = Some(pid);
                    self.state.product_name = Some(name);
                    self.state.product_color = Some(color);
                    self.touch();
                    return FrameEffect::StatusChanged;
                } else {
                    // Fresh nozzle lift (cfg_idx resolved above).
                    // Real dispensers repeat the same NozzleUp frame on every poll
                    // while waiting for AUTH. Only fire a new event on the first lift
                    // (or when the nozzle/product actually changes).
                    // Same physical lift repeated on poll, or switching to another hose on this lane.
                    let already_up = self.state.status == FpStatus::NozzleUp
                        && self.state.nozzle_index == Some(cfg_idx)
                        && self.state.product_id == Some(pid);
                    self.state.status = FpStatus::NozzleUp;
                    self.zero_delivery_meters();
                    self.state.nozzle_index = Some(cfg_idx);
                    self.state.product_id = Some(pid);
                    self.state.product_name = Some(name.clone());
                    self.state.product_color = Some(color);
                    let p = self
                        .nozzle_prices
                        .get(&cfg_idx)
                        .copied()
                        .or_else(|| site.price_for(b, cfg_idx))
                        .unwrap_or(self.state.price);
                    self.state.price = p;
                    if already_up {
                        self.touch();
                        return FrameEffect::StatusChanged;
                    }
                    self.touch();
                    return FrameEffect::NozzleUp {
                        nozzle_index: cfg_idx,
                        product_id: pid,
                        product_name: name,
                        product_color: self.state.product_color.clone().unwrap_or_default(),
                        price: self.state.price,
                    };
                }
            }
            Frame::DispenserIdle { addr, .. } if *addr == b => {
                self.apply_dispenser_idle(fp_cfg, site, active_shift_id, active_operator_name)
            }
            Frame::AckC0 { addr } if *addr == b => {
                self.touch();
                FrameEffect::StatusChanged
            }
            Frame::Data {
                addr,
                seq,
                volume_x1,
                volume_x2,
                volume_l,
                volume_h,
                amount,
                sale_complete,
                hose_product,
                hose_code,
            } if *addr == b => {
                self.state.seq = *seq;
                let raw_vol = decode_volume(*volume_x1, *volume_x2, *volume_l, *volume_h);
                let raw_amt = decode_amount(amount[0], amount[1], amount[2], amount[3]);

                if let (Some(_pp), Some(hh)) = (hose_product, hose_code) {
                    if Frame::is_nozzle_holster_code(*hh)
                        && self.embedded_holster_is_customer_event()
                    {
                        if *sale_complete
                            && matches!(
                                self.state.status,
                                FpStatus::Authorizing | FpStatus::Delivering
                            )
                        {
                            self.note_wire_hose(*hh);
                            self.apply_metering(raw_vol, self.metered_amount(raw_vol, raw_amt));
                            self.pump_sale_complete = true;
                            self.pending_holster_close = false;
                            if self.holster_ends_sale_early() {
                                return self.end_sale_from_holster_early(
                                    fp_cfg,
                                    site,
                                    active_shift_id,
                                    active_operator_name.clone(),
                                );
                            }
                            return self.complete_sale_from_holster(
                                fp_cfg,
                                site,
                                active_shift_id,
                                active_operator_name.clone(),
                            );
                        }
                        // During active delivery (vol > 0) embedded holster codes inside
                        // Data frames are always firmware deceleration artifacts — the pump
                        // emits them for several seconds while fuel is still flowing slowly.
                        // Real customer holsters arrive as standalone NozzleReturned /
                        // NozzleHolstered frames.  Refresh the lift timestamp so that
                        // nozzle_physically_up() stays true for all downstream guards.
                        let (embedded_vol, _) = self.combined_totals();
                        if embedded_vol > 0.01
                            && matches!(
                                self.state.status,
                                FpStatus::Authorizing | FpStatus::Delivering
                            )
                            && !self.pump_sale_complete
                        {
                            self.last_wire_hose_at_ms = Utc::now().timestamp_millis();
                            self.touch();
                            return FrameEffect::StatusChanged;
                        }
                        let (v, a) = self.combined_totals();
                        if v < 0.01
                            && a == 0
                            && matches!(
                                self.state.status,
                                FpStatus::Authorizing | FpStatus::Delivering
                            )
                        {
                            // CONFIG can make Wayne echo a zero-volume embedded holster right
                            // after CONFIG, before the customer has done anything.  Inside the
                            // post-CONFIG grace window treat it as that echo and keep the lane
                            // armed; outside it (or after fuel) the same shape is a real holster.
                            if (self.preauth_config_on_wire || self.pending_authorize_config_repeat)
                                && self.state.status == FpStatus::Authorizing
                                && self.within_config_echo_grace()
                            {
                                self.touch();
                                return FrameEffect::StatusChanged;
                            }
                            self.note_wire_hose(*hh);
                            return self.apply_nozzle_holstered(
                                fp_cfg,
                                site,
                                active_shift_id,
                                active_operator_name.clone(),
                            );
                        }
                        self.note_wire_hose(*hh);
                        return self.apply_nozzle_holstered(
                            fp_cfg,
                            site,
                            active_shift_id,
                            active_operator_name.clone(),
                        );
                    }
                    self.note_wire_hose(*hh);
                }

                if self.state.status == FpStatus::Offline && self.pre_auth.is_some() {
                    self.state.status = FpStatus::PreAuthorized;
                    if self.state.pre_auth_preset.is_none() {
                        self.state.pre_auth_preset = Some(preset_label(&self.last_preset));
                    }
                }

                // Pump reconnected while nozzle was lifted (service restarted mid-session).
                // The pump sends data frames but never re-sends the NozzleUp event frame, so
                // without this the status stays Offline even though the pump is responding.
                if self.state.status == FpStatus::Offline && raw_vol < 0.01 && raw_amt == 0 {
                    self.state.status = FpStatus::NozzleUp;
                    self.touch();
                    return FrameEffect::Online;
                }

                // Pump is holding a completed previous-session sale (app crashed/restarted
                // before sending GO_IDLE).  Don't create a ghost transaction — acknowledge
                // with GO_IDLE so the pump clears its counters and accepts new fills.
                if self.state.status == FpStatus::Offline && *sale_complete {
                    self.state.status = FpStatus::Idle;
                    self.touch();
                    return FrameEffect::CompleteGhostFill;
                }

                if self.state.status == FpStatus::Authorizing
                    && self.pending_authorize_config
                    && !self.preauth_config_on_wire
                {
                    self.pending_authorize_config = false;
                    self.touch();
                    // Lift-first: CONFIG+AUTHORISE after first zero-volume Data (sniffer arming).
                    return FrameEffect::SendAuthorizeConfig;
                }

                if self.state.status == FpStatus::PreAuthorized {
                    if let (Some(_pp), Some(hh)) = (hose_product, hose_code) {
                        if Frame::is_nozzle_lift_code(*hh) {
                            if let Some(effect) = self.check_preauth_nozzle(*_pp, *hh, fp_cfg, site)
                            {
                                self.preauth_mismatch_active = true;
                                self.touch();
                                return effect;
                            }
                            self.preauth_mismatch_active = false;
                            self.preauth_nozzle_confirmed = true;
                            self.zero_delivery_meters();
                            self.start_delivery_from_pre_auth(fp_cfg, site);
                            self.touch();
                            return FrameEffect::StatusChanged;
                        }
                    }
                    if !self.preauth_nozzle_confirmed {
                        // Holstered pre-auth: ignore meter frames until the customer lifts.
                        self.touch();
                        return FrameEffect::StatusChanged;
                    }
                    if raw_vol > 1e-6 {
                        self.start_delivery_from_pre_auth(fp_cfg, site);
                    } else if self.preauth_mismatch_active {
                        // Wrong nozzle detected — stay PreAuthorized so the customer
                        // can holster and lift the correct hose.
                        self.touch();
                        return FrameEffect::StatusChanged;
                    } else {
                        // Nozzle confirmed, zero volume — arming / ghost-fill path.
                        self.start_delivery_from_pre_auth(fp_cfg, site);
                        self.touch();
                        return FrameEffect::StatusChanged;
                    }
                }

                // After software preset completion the pump may still send a few data frames;
                // ignore them so totals stay frozen at the completed sale.
                if !matches!(
                    self.state.status,
                    FpStatus::Authorizing | FpStatus::Delivering
                ) {
                    if raw_vol > 1e-6 || raw_amt > 0 {
                        let wire_nozzle =
                            self.wire_transaction_nozzle(*hose_product, *hose_code, fp_cfg, site);
                        let lifted_nozzle = self.state.nozzle_index;

                        if !self.owns_meter_data() {
                            if matches!(self.state.status, FpStatus::Idle | FpStatus::Offline)
                                && !self.ghost_recovery_active()
                                && !*sale_complete
                                && wire_nozzle.is_some()
                                && !self.preauth_cancel_pending
                            {
                                let nozzle_index = wire_nozzle.unwrap_or(1);
                                let (pname, pid, color) = lookup_nozzle(site, fp_cfg, nozzle_index);
                                self.state.nozzle_index = Some(nozzle_index);
                                self.state.product_id = Some(pid);
                                self.state.product_name = Some(pname.clone());
                                self.state.product_color = Some(color);
                                self.state.price = self
                                    .nozzle_prices
                                    .get(&nozzle_index)
                                    .copied()
                                    .or_else(|| site.price_for(b, nozzle_index))
                                    .unwrap_or(self.state.price);
                                self.current_tx = Some(CurrentTx {
                                    id: Uuid::new_v4().to_string(),
                                    started_at: Utc::now().timestamp_millis(),
                                    product_id: pid,
                                    product_name: pname,
                                    nozzle_index,
                                });
                                self.auth_session_started_at = Some(Utc::now().timestamp_millis());
                                self.apply_metering(raw_vol, self.metered_amount(raw_vol, raw_amt));
                                self.state.status = FpStatus::Delivering;
                                self.touch();
                                return FrameEffect::StatusChanged;
                            }
                            self.touch();
                            if *sale_complete && !self.nozzle_physically_up() {
                                return FrameEffect::CompleteGhostFill;
                            }
                            // Real meter data on an Idle lane that owns no authorization. This is the
                            // cancelled-pre-auth-still-armed case (or a bare 02 08 frame with no hose
                            // tag, which the auto-create above cannot attribute). Never silently drop
                            // fuel: tell the poll loop to STOP the pump and alert the operator.
                            if matches!(self.state.status, FpStatus::Idle)
                                && !self.ghost_recovery_active()
                                && !*sale_complete
                            {
                                return FrameEffect::UnauthorizedDelivery {
                                    volume: raw_vol,
                                    amount: raw_amt,
                                };
                            }
                            return FrameEffect::StatusChanged;
                        }

                        // Pump still holds another hose's transaction — ignore for this lift.
                        if !self.preauth_session_armed() {
                            if let (Some(wn), Some(ln)) = (wire_nozzle, lifted_nozzle) {
                                if wn != ln {
                                    self.touch();
                                    return FrameEffect::StatusChanged;
                                }
                            }
                        }

                        // Pump may keep streaming meter data for a few frames after a stop
                        // command is sent, before it physically halts.  Don't revert STOPPED
                        // back to DELIVERING — the operator must choose Resume/Continue/Close.
                        if self.state.status.is_stopped() {
                            self.touch();
                            return FrameEffect::StatusChanged;
                        }

                        // Already recorded this sale — wait for operator dismiss.
                        // The pump continues to emit data frames during deceleration after
                        // reporting sale_complete, so volume keeps climbing slightly above
                        // what was recorded.  Stay in DONE regardless of the delta — DONE is
                        // only exited by the operator dismissing the sale or holstering.
                        //
                        // Also guard when completed_sale is set but status has been reset to
                        // Idle (e.g. by a stray holster frame): without this a data frame
                        // arriving after the reset would bypass the Done check above and
                        // create a ghost delivery with the fallback nozzle (wrong product).
                        if self.state.status == FpStatus::Done || self.completed_sale.is_some() {
                            self.touch();
                            return FrameEffect::StatusChanged;
                        }

                        let nozzle_index = if self.preauth_session_armed() {
                            lifted_nozzle.or(wire_nozzle).unwrap_or(1)
                        } else {
                            wire_nozzle.or(lifted_nozzle).unwrap_or(1)
                        };
                        let (pname, pid, color) = lookup_nozzle(site, fp_cfg, nozzle_index);
                        self.state.nozzle_index = Some(nozzle_index);
                        self.state.product_id = Some(pid);
                        self.state.product_name = Some(pname.clone());
                        self.state.product_color = Some(color);
                        self.state.status = FpStatus::Authorizing;
                        if self.current_tx.is_none() {
                            self.current_tx = Some(CurrentTx {
                                id: Uuid::new_v4().to_string(),
                                started_at: Utc::now().timestamp_millis(),
                                product_id: pid,
                                product_name: pname,
                                nozzle_index,
                            });
                        }
                        self.apply_metering(raw_vol, self.metered_amount(raw_vol, raw_amt));
                        self.state.status = FpStatus::Delivering;
                        self.touch();
                        return FrameEffect::StatusChanged;
                    }
                    self.touch();
                    return FrameEffect::StatusChanged;
                }
                // Decel window: STOP was sent but we deferred the commit to watch what
                // the pump does.  FpStatus stays Delivering so BUSY keeps flowing.
                if self.in_decel_window() {
                    if *sale_complete {
                        // Device closed the transaction — commit to STOPPED now.
                        let preset = self
                            .decel_pending_preset
                            .take()
                            .unwrap_or_else(|| self.last_preset.clone());
                        let ss = self.decel_pending_stop_source;
                        self.clear_decel_window();
                        return self.enter_stopped_state(
                            fp_cfg,
                            site,
                            active_shift_id,
                            active_operator_name,
                            preset,
                            ss,
                        );
                    }
                    if raw_vol > self.decel_vol_snapshot + 0.005 {
                        // Counter advanced — pump accepted our BUSY and is delivering again.
                        // Restore caps and fall through to normal metering.
                        self.set_deliver_caps_from_preset(&self.last_preset.clone());
                        self.clear_decel_window();
                    } else {
                        // Counter frozen — pump still decelerating.
                        self.decel_frozen_count = self.decel_frozen_count.saturating_add(1);
                        let elapsed =
                            Utc::now().timestamp_millis() - self.decel_stop_sent_at.unwrap_or(0);
                        if self.decel_frozen_count >= DECEL_FROZEN_FRAME_THRESHOLD
                            || elapsed >= DECEL_WINDOW_TIMEOUT_MS
                        {
                            let preset = self
                                .decel_pending_preset
                                .take()
                                .unwrap_or_else(|| self.last_preset.clone());
                            let ss = self.decel_pending_stop_source;
                            self.clear_decel_window();
                            return self.enter_stopped_state(
                                fp_cfg,
                                site,
                                active_shift_id,
                                active_operator_name,
                                preset,
                                ss,
                            );
                        }
                        // Still within window — update display with frozen value, wait.
                        self.apply_metering(raw_vol, self.metered_amount(raw_vol, raw_amt));
                        self.touch();
                        return FrameEffect::StatusChanged;
                    }
                }
                self.apply_metering(raw_vol, self.metered_amount(raw_vol, raw_amt));
                let vol = self.state.volume;
                let amt = self.state.amount;
                // First non-zero data frame starts delivery. Zero-volume frames are
                // normal while the nozzle is up but no fuel has flowed yet (ghost fill).
                if self.state.status == FpStatus::Authorizing {
                    if raw_vol > 1e-6 {
                        self.state.status = FpStatus::Delivering;
                        if self.current_tx.is_none() {
                            let nozzle_index = self.state.nozzle_index.unwrap_or(1);
                            let (pname, pid, _) = lookup_nozzle(site, fp_cfg, nozzle_index);
                            self.current_tx = Some(CurrentTx {
                                id: Uuid::new_v4().to_string(),
                                started_at: Utc::now().timestamp_millis(),
                                product_id: pid,
                                product_name: pname,
                                nozzle_index,
                            });
                        }
                    }
                } else if self.state.status == FpStatus::Delivering {
                    let hit_v = self
                        .cap_volume_liters
                        .map_or(false, |cap| vol + 1e-6 >= cap);
                    let hit_a = self.cap_amount.map_or(false, |cap| amt >= cap);
                    if hit_v || hit_a {
                        // Software preset cap reached. Clear the caps so this doesn't
                        // re-trigger on subsequent data frames, but do NOT close the
                        // transaction yet. The pump decelerates to its matching hardware
                        // limit and fires sale_complete; after that the customer holsters
                        // the nozzle and the holster event closes with the actual final volume.
                        self.clear_deliver_caps();
                        self.touch();
                        return FrameEffect::StatusChanged;
                    }
                }
                if !*sale_complete
                    && self.current_tx.is_some()
                    && self.continuation.is_none()
                    && !self.last_preset.is_full()
                    && self.startup_ghost_old_enough()
                    && matches!(
                        self.state.status,
                        FpStatus::Authorizing | FpStatus::Delivering
                    )
                    && self.startup_ghost_frozen(raw_vol, raw_amt)
                {
                    self.cancel_startup_ghost_keep_nozzle_up();
                    self.touch();
                    return FrameEffect::CompleteGhostFillWithNozzleUp;
                }
                if *sale_complete {
                    if matches!(
                        self.state.status,
                        FpStatus::Delivering | FpStatus::Authorizing
                    ) {
                        if self.nozzle_physically_up() {
                            // Pump signalled end-of-sale but the nozzle is still in the tank.
                            // Wait for the physical holster event — it gives us the true final
                            // volume and prevents recording a premature or stale total.
                            self.pump_sale_complete = true;
                            self.touch();
                            return FrameEffect::StatusChanged;
                        }
                        if !self.pending_holster_close {
                            // nozzle_physically_up() is false only due to the staleness timer,
                            // not because an explicit NozzleReturned was received.  Keep waiting.
                            self.touch();
                            return FrameEffect::StatusChanged;
                        }
                        // Nozzle confirmed holstered — close.
                        self.pending_holster_close = false;
                        // Hardware preset was reached (we are inside `sale_complete=true`),
                        // regardless of whether NozzleReturned arrived before or after this frame.
                        self.pump_sale_complete = true;
                        if self.holster_ends_sale_early() {
                            return self.end_sale_from_holster_early(
                                fp_cfg,
                                site,
                                active_shift_id,
                                active_operator_name.clone(),
                            );
                        }
                        return self.complete_sale_from_holster(
                            fp_cfg,
                            site,
                            active_shift_id,
                            active_operator_name.clone(),
                        );
                    }
                }
                self.touch();
                FrameEffect::StatusChanged
            }
            Frame::TransactionComplete { addr, .. } if *addr == b => {
                self.apply_done_response(fp_cfg, site, active_shift_id, active_operator_name)
            }
            Frame::Stopped { addr, .. } if *addr == b => {
                if self.state.status == FpStatus::Done {
                    self.touch();
                    return FrameEffect::StatusChanged;
                }
                // Resuming after E-stop: sim may still report Stopped until re-authorized.
                if self.continuation.is_some() {
                    self.touch();
                    return FrameEffect::StatusChanged;
                }
                // Decel window: device sent an explicit STOPPED frame — commit now.
                if self.in_decel_window()
                    && matches!(
                        self.state.status,
                        FpStatus::Delivering | FpStatus::Authorizing
                    )
                {
                    let preset = self
                        .decel_pending_preset
                        .take()
                        .unwrap_or_else(|| self.last_preset.clone());
                    let ss = self.decel_pending_stop_source;
                    self.clear_decel_window();
                    return self.enter_stopped_state(
                        fp_cfg,
                        site,
                        active_shift_id,
                        active_operator_name,
                        preset,
                        ss,
                    );
                }
                if matches!(
                    self.state.status,
                    FpStatus::Delivering | FpStatus::Authorizing
                ) {
                    // If CONFIG was just sent and no fuel has flowed, this Stopped frame
                    // is the pump completing its previous transaction state, not aborting
                    // the current authorization. Ignore it so delivery can start normally.
                    if self.state.status == FpStatus::Authorizing && self.preauth_config_on_wire {
                        let (vol, amt) = self.combined_totals();
                        if vol < 0.01 && amt == 0 {
                            self.touch();
                            return FrameEffect::StatusChanged;
                        }
                    }
                    let preset = self.last_preset.clone();
                    return self.enter_stopped_state(
                        fp_cfg,
                        site,
                        active_shift_id,
                        active_operator_name,
                        preset,
                        StopSource::External,
                    );
                }
                self.touch();
                FrameEffect::StatusChanged
            }
            _ => FrameEffect::None,
        }
    }

    pub fn set_last_preset(&mut self, preset: Preset) {
        self.set_deliver_caps_from_preset(&preset);
        self.last_preset = preset;
    }

    fn close_transaction(
        &mut self,
        completed_normally: bool,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
        active_shift_id: Option<String>,
        active_operator_name: Option<String>,
    ) -> Transaction {
        let (combined_vol, combined_amt) = self.combined_totals();
        let parent = self.continuation.as_ref().map(|c| c.parent_tx_id.clone());
        let mut status = TxStatus::resolve(combined_vol, completed_normally);
        if matches!(status, TxStatus::Completed) {
            if let Some(pid) = parent.clone() {
                status = TxStatus::ContinuedFrom(pid);
            }
        }
        self.finish_transaction_with_totals(
            status,
            fp_cfg,
            site,
            active_shift_id,
            active_operator_name,
            combined_vol,
            combined_amt,
            parent,
        )
    }

    fn finish_transaction_with_totals(
        &mut self,
        status: TxStatus,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
        active_shift_id: Option<String>,
        active_operator_name: Option<String>,
        combined_volume: f64,
        combined_amount: u64,
        parent_tx_id: Option<String>,
    ) -> Transaction {
        let now = Utc::now().timestamp_millis();
        let (seg_vol, _) = self.segment_totals();
        let seg_amt = self
            .continuation
            .as_ref()
            .map(|c| combined_amount.saturating_sub(c.base_amount))
            .unwrap_or(combined_amount);
        let ct = self.current_tx.take();
        let (id, started_at, product_id, product_name, nozzle_index) = if let Some(c) = ct {
            (
                c.id,
                c.started_at,
                c.product_id,
                c.product_name,
                c.nozzle_index,
            )
        } else {
            let nozzle_index = self.state.nozzle_index.unwrap_or(1);
            let (pname, pid, _) = lookup_nozzle(site, fp_cfg, nozzle_index);
            (Uuid::new_v4().to_string(), now, pid, pname, nozzle_index)
        };
        self.continuation = None;
        if combined_volume > 0.01 && !matches!(status, TxStatus::Stopped) {
            self.completed_sale = Some(CompletedSaleLatch);
        }
        Transaction {
            id,
            fp_id: self.state.fp_id.clone(),
            label: self.state.label.clone(),
            address_byte: fp_cfg.address_byte,
            started_at,
            completed_at: Some(now),
            volume: seg_vol,
            amount: seg_amt,
            price: self.state.price,
            nozzle_index,
            product_id,
            product_name,
            status,
            shift_id: active_shift_id,
            operator_name: active_operator_name,
            parent_tx_id,
            combined_volume,
            combined_amount,
        }
    }

    /// Open the child segment transaction after continue-fill authorize.
    pub fn begin_continuation_segment(
        &mut self,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
    ) {
        if self.continuation.is_none() || self.current_tx.is_some() {
            return;
        }
        let nozzle_index = self.state.nozzle_index.unwrap_or(1);
        let (pname, pid, _) = lookup_nozzle(site, fp_cfg, nozzle_index);
        self.current_tx = Some(CurrentTx {
            id: Uuid::new_v4().to_string(),
            started_at: Utc::now().timestamp_millis(),
            product_id: pid,
            product_name: pname,
            nozzle_index,
        });
        if self.state.status != FpStatus::Delivering {
            self.state.status = FpStatus::Authorizing;
        }
        self.touch();
    }

    /// App resume: hose still in tank — service is re-authorized; expect meter data immediately.
    pub fn promote_continuation_delivering(&mut self) {
        if self.continuation.is_some() {
            self.state.status = FpStatus::Delivering;
            self.touch();
        }
    }

    pub fn apply_authorize_sent(&mut self) {
        let may_authorize = matches!(
            self.state.status,
            FpStatus::NozzleUp | FpStatus::Authorizing
        ) || (self.state.status == FpStatus::Idle
            && self.continuation.is_some())
            || self.state.status.is_stopped();
        if may_authorize {
            if !matches!(
                self.state.status,
                FpStatus::Authorizing | FpStatus::Delivering
            ) {
                self.zero_delivery_meters();
                self.begin_auth_session();
            }
            self.state.status = FpStatus::Authorizing;
        }
        self.touch();
    }

    pub fn apply_done_ack(&mut self) {
        self.clear_deliver_caps();
        self.touch();
    }

    pub fn apply_stop(
        &mut self,
        fp_cfg: &FuelingPositionConfig,
        site: &SiteConfig,
        active_shift_id: Option<String>,
        active_operator_name: Option<String>,
        use_decel_window: bool,
        stop_mode: bool,
    ) -> Option<FrameEffect> {
        if self.state.status == FpStatus::PreAuthorized {
            self.cancel_pre_auth();
            return Some(FrameEffect::PreAuthCancelled);
        }
        if self.state.status.is_stopped() && self.stopped_context.is_some() {
            return None;
        }
        if matches!(
            self.state.status,
            FpStatus::Delivering | FpStatus::Authorizing
        ) || self.current_tx.is_some()
        {
            let stop_source = if stop_mode {
                StopSource::AppFinal
            } else {
                StopSource::App
            };
            if use_decel_window {
                if self.in_decel_window() {
                    // Second Stop while decel window is already open — ignore.
                    return None;
                }
                // Enter decel window: keep FpStatus::Delivering so BUSY frames keep
                // flowing, defer the DB write until we see whether the pump accepts.
                let (snapshot_vol, _) = self.combined_totals();
                self.decel_stop_sent_at = Some(Utc::now().timestamp_millis());
                self.decel_vol_snapshot = snapshot_vol;
                self.decel_frozen_count = 0;
                self.decel_pending_preset = Some(self.last_preset.clone());
                self.decel_pending_stop_source = stop_source;
                self.clear_deliver_caps();
                self.touch();
                return None;
            }
            return Some(self.enter_stopped_state(
                fp_cfg,
                site,
                active_shift_id,
                active_operator_name,
                self.last_preset.clone(),
                stop_source,
            ));
        }
        None
    }

    pub fn set_nozzle_price(&mut self, nozzle_index: u8, price: u32) -> u32 {
        let old = self
            .nozzle_prices
            .get(&nozzle_index)
            .copied()
            .unwrap_or(self.state.price);
        self.nozzle_prices.insert(nozzle_index, price);
        if self.state.nozzle_index == Some(nozzle_index) {
            self.state.price = price;
        }
        self.touch();
        old
    }

    /// Reload nozzle prices/count from site config after admin catalog changes.
    pub fn sync_nozzles_from_config(&mut self, fp: &FuelingPositionConfig) {
        self.nozzle_prices.clear();
        for n in fp.nozzles.iter().filter(|n| n.active) {
            self.nozzle_prices.insert(n.index, n.price);
        }
        if let Some(idx) = self.state.nozzle_index {
            if let Some(price) = self.nozzle_prices.get(&idx).copied() {
                self.state.price = price;
            }
        } else if matches!(self.state.status, FpStatus::Idle | FpStatus::Offline) {
            self.state.price = fp.default_price().unwrap_or(0);
        }
        self.state.nozzle_count = fp.nozzle_count().min(u8::MAX as usize) as u8;
        self.state.label = fp.label.clone();
        self.touch();
    }
}

/// How the poll loop should complete a recorded transaction on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxCompleteAction {
    /// Pump reported end-of-sale; send DONE (0x05) and return the lane to idle.
    AcknowledgeIdle,
}

pub enum FrameEffect {
    None,
    StatusChanged,
    /// Pump signalled end-of-sale (TransactionComplete / DispenserIdle) while the nozzle
    /// is physically still in the tank.  Send GO_IDLE on the wire so the pump advances to
    /// NozzleReturned state, but do NOT record the transaction yet — wait for the physical
    /// holster event which will call complete_sale_from_holster with the true final volume.
    SendDoneAwaitHolster,
    PreAuthCancelled,
    /// Meter data arrived on an unauthorized lane (e.g. pump left armed after a cancelled
    /// pre-auth). Poll loop must STOP the pump and alert the operator; fuel is never silently dropped.
    UnauthorizedDelivery {
        volume: f64,
        amount: u64,
    },
    PreAuthNozzleMismatch {
        expected_nozzle_index: u8,
        expected_product_name: String,
        lifted_nozzle_index: u8,
        lifted_product_name: String,
    },
    Online,
    NozzleUp {
        nozzle_index: u8,
        product_id: u8,
        product_name: String,
        product_color: String,
        price: u32,
    },
    TransactionDone {
        tx: Transaction,
        action: TxCompleteAction,
    },
    Paused {
        tx: Transaction,
        fp_id: String,
        stopped_volume: f64,
        stopped_amount: u64,
        stopped_tx_id: String,
        stop_source: StopSource,
    },
    NozzleRemoved {
        fp_id: String,
        stopped_tx_id: Option<String>,
        tx: Transaction,
    },
    /// Hose returned to holster while waiting for authorize — lane is idle; send STOP on wire.
    NozzleHolstered,
    /// `70 FA` after nozzle-up / during zero-volume authorize — resend AUTH, do not STOP.
    ResendAuthorize,
    /// Ghost fill complete — send GO_IDLE (done) on the wire.
    CompleteGhostFill,
    /// Frozen startup ghost complete — send GO_IDLE, but keep UI as NozzleUp.
    CompleteGhostFillWithNozzleUp,
    /// Send one CONFIG frame. First zero-volume Data sends the first copy; the repeat is sent
    /// after a later poll response so the pump gets the same gap seen in the sniffer.
    SendAuthorizeConfig,
}

/// Result of `apply_preauthorize_sent`, consumed by the poll loop's `Preauthorize` handler.
pub enum PreauthOutcome {
    /// Lane was holstered/idle: the poll loop must arm CONFIG on the wire now; the customer's
    /// lift is handled on a later poll.
    Holstered,
    /// The matching nozzle was already physically up: send full CONFIG + BUSY and start
    /// delivery immediately (lift-first authorization).
    LiftConfirmed,
    /// A *different* nozzle is physically up than the one requested (a TOCTOU lift that the API
    /// could not see).  The pre-auth is NOT established and nothing is armed on the wire; the
    /// poll loop emits these mismatch fields (STOP + notify the operator).
    NozzleMismatch {
        expected_nozzle_index: u8,
        expected_product_name: String,
        lifted_nozzle_index: u8,
        lifted_product_name: String,
    },
}

/// Look up product info by **config nozzle index** (1, 2, 3, …).
fn lookup_nozzle(
    site: &SiteConfig,
    fp: &FuelingPositionConfig,
    nozzle_index: u8,
) -> (String, u8, String) {
    for n in &fp.nozzles {
        if n.index == nozzle_index {
            if let Some(p) = site.product(n.product_id) {
                return (p.name.clone(), n.product_id, p.color.clone());
            }
            return ("Unknown".into(), n.product_id, "#888888".into());
        }
    }
    if let Some(n) = fp.nozzles.first() {
        if let Some(p) = site.product(n.product_id) {
            return (p.name.clone(), n.product_id, p.color.clone());
        }
        return ("Unknown".into(), n.product_id, "#888888".into());
    }
    ("Unknown".into(), 0, "#888888".into())
}

/// Resolve Wayne `03 04 01 [PP] 00 [HH]` to a config nozzle (supports 4 hoses per pump).
///
/// Lift `HH >= 0x10`; holster `HH` is `lift - 0x10` (e.g. 0x12/0x02, 0x11/0x01, 0x13/0x03).
fn resolve_wayne_nozzle(
    site: &SiteConfig,
    fp: &FuelingPositionConfig,
    product_code: u8,
    hose_code: u8,
) -> (u8, String, u8, String) {
    let lift_code = if Frame::is_nozzle_lift_code(hose_code) {
        hose_code
    } else {
        hose_code.saturating_add(0x10)
    };

    let active: Vec<_> = fp.nozzles.iter().filter(|n| n.active).collect();

    // 1. Both wayne_product_code and wayne_code (multi-hose pumps).
    for n in &active {
        if n.wayne_code != 0
            && n.wayne_code == lift_code
            && (n.wayne_product_code == 0 || n.wayne_product_code == product_code)
        {
            let (name, pid, color) = lookup_nozzle(site, fp, n.index);
            return (n.index, name, pid, color);
        }
    }

    // 2. wayne_code only.
    for n in &active {
        if n.wayne_code != 0 && n.wayne_code == lift_code {
            let (name, pid, color) = lookup_nozzle(site, fp, n.index);
            return (n.index, name, pid, color);
        }
    }

    // 3. product_code only when exactly one nozzle declares that PP byte.
    if product_code != 0 {
        let matches: Vec<_> = active
            .iter()
            .filter(|n| n.wayne_product_code == product_code)
            .collect();
        if matches.len() == 1 {
            let n = matches[0];
            let (name, pid, color) = lookup_nozzle(site, fp, n.index);
            return (n.index, name, pid, color);
        }
    }

    // 4. Legacy index match: lift codes are nozzle_index + 0x10 (Wayne protocol).
    if Frame::is_nozzle_lift_code(hose_code) {
        let idx = hose_code - 0x10;
        for n in &active {
            if n.index == idx {
                let (name, pid, color) = lookup_nozzle(site, fp, n.index);
                return (n.index, name, pid, color);
            }
        }
    }

    if let Some(n) = active.first() {
        let (name, pid, color) = lookup_nozzle(site, fp, n.index);
        return (n.index, name, pid, color);
    }
    (1, "Unknown".into(), 0, "#888888".into())
}

pub fn initial_runtimes(cfg: &SiteConfig) -> HashMap<u8, RuntimeFp> {
    let mut m = HashMap::new();
    for fp in &cfg.fueling_positions {
        if !fp.active {
            continue;
        }
        m.insert(fp.address_byte, RuntimeFp::new(fp, cfg));
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_site() -> SiteConfig {
        serde_json::from_str(
            r##"{
                "site": { "id": "test", "name": "Test", "timezone": "UTC" },
                "service": {
                    "port": 3001,
                    "log_level": "info",
                    "log_file": "test.log",
                    "db_path": "test.db"
                },
                "connection": {
                    "protocol": "wayne_europump",
                    "port": "COM3",
                    "baud_rate": 9600,
                    "parity": "odd",
                    "data_bits": 8,
                    "stop_bits": 1,
                    "response_timeout_ms": 300
                },
                "polling": {
                    "interval_ms": 140,
                    "offline_threshold_polls": 32,
                    "reconnect_settle_rounds": 0
                },
                "products": [
                    { "id": 3, "name": "AI-92", "color": "#2196F3", "unit": "litre" }
                ],
                "fueling_positions": [
                    {
                        "id": "FP4",
                        "label": "4",
                        "address_byte": 83,
                        "active": true,
                        "nozzles": [
                            {
                                "index": 2,
                                "product_id": 3,
                                "price": 11000,
                                "active": true,
                                "wayne_code": 18,
                                "wayne_product_code": 16
                            }
                        ]
                    }
                ],
                "sync": {
                    "enabled": false,
                    "backend_url": "",
                    "api_key": ""
                }
            }"##,
        )
        .expect("sample site config")
    }

    fn sample_site_two_nozzles() -> SiteConfig {
        serde_json::from_str(
            r##"{
                "site": { "id": "test", "name": "Test", "timezone": "UTC" },
                "service": {
                    "port": 3001,
                    "log_level": "info",
                    "log_file": "test.log",
                    "db_path": "test.db"
                },
                "connection": {
                    "protocol": "wayne_europump",
                    "port": "COM3",
                    "baud_rate": 9600,
                    "parity": "odd",
                    "data_bits": 8,
                    "stop_bits": 1,
                    "response_timeout_ms": 300
                },
                "polling": {
                    "interval_ms": 140,
                    "offline_threshold_polls": 32,
                    "reconnect_settle_rounds": 0
                },
                "products": [
                    { "id": 3, "name": "AI-92", "color": "#2196F3", "unit": "litre" },
                    { "id": 5, "name": "AI-95", "color": "#4CAF50", "unit": "litre" }
                ],
                "fueling_positions": [
                    {
                        "id": "FP4",
                        "label": "4",
                        "address_byte": 83,
                        "active": true,
                        "nozzles": [
                            {
                                "index": 2,
                                "product_id": 3,
                                "price": 11000,
                                "active": true,
                                "wayne_code": 18,
                                "wayne_product_code": 16
                            },
                            {
                                "index": 3,
                                "product_id": 5,
                                "price": 13000,
                                "active": true,
                                "wayne_code": 19,
                                "wayne_product_code": 17
                            }
                        ]
                    }
                ],
                "sync": {
                    "enabled": false,
                    "backend_url": "",
                    "api_key": ""
                }
            }"##,
        )
        .expect("sample site config")
    }

    #[test]
    fn zero_volume_embedded_holster_after_preauth_cancels_authorizing() {
        let site = sample_site();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        rt.state.status = FpStatus::PreAuthorized;
        rt.state.nozzle_index = Some(2);
        rt.state.product_id = Some(3);
        rt.state.product_name = Some("AI-92".into());
        rt.state.price = 11000;
        rt.preauth_config_on_wire = true;
        rt.current_tx = Some(CurrentTx {
            id: "tx".into(),
            started_at: Utc::now().timestamp_millis(),
            product_id: 3,
            product_name: "AI-92".into(),
            nozzle_index: 2,
        });
        rt.state.status = FpStatus::Authorizing;
        rt.note_wire_hose(0x12);

        let frame = Frame::Data {
            addr: 0x53,
            seq: 0x31,
            volume_x1: 0,
            volume_x2: 0,
            volume_l: 0,
            volume_h: 0,
            amount: [0, 0, 0, 0],
            sale_complete: false,
            hose_product: Some(0x10),
            hose_code: Some(0x02),
        };

        let effect = rt.apply_frame(&frame, &fp_cfg, &site, None, None);

        assert!(matches!(effect, FrameEffect::CompleteGhostFill));
        assert_eq!(rt.state.status, FpStatus::Idle);
        assert!(rt.current_tx.is_none());
        assert_eq!(rt.last_wire_hose_code, None);
        assert!(rt.ghost_recovery);
    }

    #[test]
    fn frozen_tiny_startup_meter_aborts_authorizing_but_keeps_nozzle_up() {
        let site = sample_site();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        rt.state.status = FpStatus::Authorizing;
        rt.state.nozzle_index = Some(2);
        rt.state.product_id = Some(3);
        rt.state.product_name = Some("AI-92".into());
        rt.state.price = 11000;
        rt.set_last_preset(Preset::Amount(200_000));
        rt.mark_preauth_config_on_wire();
        rt.auth_session_started_at = Some(Utc::now().timestamp_millis() - STARTUP_GHOST_MIN_AGE_MS);
        rt.current_tx = Some(CurrentTx {
            id: "tx".into(),
            started_at: Utc::now().timestamp_millis(),
            product_id: 3,
            product_name: "AI-92".into(),
            nozzle_index: 2,
        });

        let frame = Frame::Data {
            addr: 0x53,
            seq: 0x31,
            volume_x1: 0x00,
            volume_x2: 0x00,
            volume_l: 0x00,
            volume_h: 0x05,
            amount: [0x00, 0x00, 0x05, 0x50],
            sale_complete: false,
            hose_product: Some(0x10),
            hose_code: Some(0x12),
        };

        for _ in 1..STARTUP_GHOST_FROZEN_FRAME_THRESHOLD {
            let effect = rt.apply_frame(&frame, &fp_cfg, &site, None, None);
            assert!(matches!(effect, FrameEffect::StatusChanged));
            assert_eq!(rt.state.status, FpStatus::Delivering);
            assert!(rt.current_tx.is_some());
        }

        let effect = rt.apply_frame(&frame, &fp_cfg, &site, None, None);

        assert!(matches!(effect, FrameEffect::CompleteGhostFillWithNozzleUp));
        assert_eq!(rt.state.status, FpStatus::NozzleUp);
        assert!(rt.current_tx.is_none());
        assert_eq!(rt.state.volume, 0.0);
        assert_eq!(rt.last_wire_hose_code, Some(0x12));
        assert!(rt.ghost_recovery);
    }

    #[test]
    fn continuation_tiny_startup_meter_is_not_aborted_as_ghost() {
        let site = sample_site();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        rt.state.status = FpStatus::Delivering;
        rt.state.nozzle_index = Some(2);
        rt.state.product_id = Some(3);
        rt.state.product_name = Some("AI-92".into());
        rt.state.price = 11000;
        rt.set_last_preset(Preset::Amount(200_000));
        rt.mark_preauth_config_on_wire();
        rt.auth_session_started_at = Some(Utc::now().timestamp_millis() - STARTUP_GHOST_MIN_AGE_MS);
        rt.current_tx = Some(CurrentTx {
            id: "tx".into(),
            started_at: Utc::now().timestamp_millis(),
            product_id: 3,
            product_name: "AI-92".into(),
            nozzle_index: 2,
        });
        rt.continuation = Some(ContinuationContext {
            parent_tx_id: "parent".into(),
            base_volume: 10.0,
            base_amount: 110_000,
            segment_volume: 0.0,
            segment_amount: 0,
        });

        let frame = Frame::Data {
            addr: 0x53,
            seq: 0x31,
            volume_x1: 0x00,
            volume_x2: 0x00,
            volume_l: 0x00,
            volume_h: 0x05,
            amount: [0x00, 0x00, 0x05, 0x50],
            sale_complete: false,
            hose_product: Some(0x10),
            hose_code: Some(0x12),
        };

        for _ in 0..STARTUP_GHOST_FROZEN_FRAME_THRESHOLD {
            let effect = rt.apply_frame(&frame, &fp_cfg, &site, None, None);
            assert!(matches!(effect, FrameEffect::StatusChanged));
            assert_eq!(rt.state.status, FpStatus::Delivering);
            assert!(rt.current_tx.is_some());
            assert!(rt.continuation.is_some());
        }
    }

    #[test]
    fn wrong_nozzle_lift_cancels_preauth_and_ignores_stale_meter_data() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        assert!(matches!(
            rt.apply_preauthorize_sent(&fp_cfg, &site, 2, 11000, Preset::Amount(10_000)),
            PreauthOutcome::Holstered
        ));
        rt.mark_preauth_config_on_wire();

        let wrong_lift = Frame::NozzleUp {
            addr: 0x53,
            seq: 0x31,
            product: 0x11,
            nozzle: 0x13,
        };
        let effect = rt.apply_frame(&wrong_lift, &fp_cfg, &site, None, None);

        assert!(matches!(
            effect,
            FrameEffect::PreAuthNozzleMismatch {
                expected_nozzle_index: 2,
                lifted_nozzle_index: 3,
                ..
            }
        ));
        assert_eq!(rt.state.status, FpStatus::Idle);
        assert!(rt.pre_auth.is_none());
        assert!(rt.current_tx.is_none());
        assert!(rt.state.pre_auth_preset.is_none());
        assert!(rt.ghost_recovery);

        let stale_wrong_nozzle_data = Frame::Data {
            addr: 0x53,
            seq: 0x32,
            volume_x1: 0x00,
            volume_x2: 0x00,
            volume_l: 0x01,
            volume_h: 0x00,
            amount: [0x00, 0x00, 0x10, 0x00],
            sale_complete: false,
            hose_product: Some(0x11),
            hose_code: Some(0x13),
        };
        let effect = rt.apply_frame(&stale_wrong_nozzle_data, &fp_cfg, &site, None, None);

        assert!(matches!(effect, FrameEffect::StatusChanged));
        assert_eq!(rt.state.status, FpStatus::Idle);
        assert_eq!(rt.state.volume, 0.0);
        assert_eq!(rt.state.amount, 0);
        assert!(rt.current_tx.is_none());
        assert!(rt.completed_sale.is_none());
    }

    #[test]
    fn cancelled_preauth_then_armed_delivery_emits_unauthorized_not_sale() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        // Operator pre-authorized (holstered) then cancelled on the UI.
        assert!(matches!(
            rt.apply_preauthorize_sent(&fp_cfg, &site, 2, 11000, Preset::Amount(10_000)),
            PreauthOutcome::Holstered
        ));
        rt.cancel_pre_auth();
        rt.mark_preauth_cancel_pending();
        assert_eq!(rt.state.status, FpStatus::Idle);

        // The pump stayed armed and starts delivering on the matching hose after the cancel.
        let armed_delivery = Frame::Data {
            addr: 0x53,
            seq: 0x31,
            volume_x1: 0x00,
            volume_x2: 0x00,
            volume_l: 0x01,
            volume_h: 0x00,
            amount: [0x00, 0x00, 0x11, 0x00],
            sale_complete: false,
            hose_product: Some(0x10),
            hose_code: Some(0x12),
        };
        let effect = rt.apply_frame(&armed_delivery, &fp_cfg, &site, None, None);

        // It must be flagged unauthorized (STOP + alert), never auto-converted into a sale.
        assert!(matches!(effect, FrameEffect::UnauthorizedDelivery { .. }));
        assert_ne!(rt.state.status, FpStatus::Delivering);
        assert!(rt.current_tx.is_none());
    }

    #[test]
    fn bare_meter_frame_on_idle_lane_is_not_silently_dropped() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);
        rt.state.status = FpStatus::Idle; // lane has polled idle (fresh runtimes start Offline)

        // Bare 02 08 meter frame (no hose tag) on an unauthorized Idle lane — previously dropped.
        let bare = Frame::Data {
            addr: 0x53,
            seq: 0x31,
            volume_x1: 0x00,
            volume_x2: 0x00,
            volume_l: 0x02,
            volume_h: 0x00,
            amount: [0x00, 0x00, 0x22, 0x00],
            sale_complete: false,
            hose_product: None,
            hose_code: None,
        };
        let effect = rt.apply_frame(&bare, &fp_cfg, &site, None, None);

        assert!(matches!(effect, FrameEffect::UnauthorizedDelivery { .. }));
        assert_ne!(rt.state.status, FpStatus::Delivering);
    }

    #[test]
    fn idle_response_clears_cancel_pending_guard() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        rt.mark_preauth_cancel_pending();
        assert!(rt.preauth_cancel_pending);

        // Pump confirmed idle (70 FA) → the post-cancel guard is cleared (de-auth verified).
        let _ = rt.apply_idle_response(&fp_cfg, &site, None, None);
        assert!(!rt.preauth_cancel_pending);
        assert!(!rt.unauthorized_alerted);
    }

    #[test]
    fn holstered_preauth_defers_arming_to_lift() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        assert!(matches!(
            rt.apply_preauthorize_sent(&fp_cfg, &site, 2, 11000, Preset::Amount(10_000)),
            PreauthOutcome::Holstered
        ));
        // Layer 3: a holstered pre-auth must NOT pre-arm the pump.
        assert!(!rt.preauth_config_on_wire);

        // Matching lift confirms the pre-auth — still no CONFIG assumed on the wire.
        let lift = Frame::NozzleUp {
            addr: 0x53,
            seq: 0x31,
            product: 0x10,
            nozzle: 0x12,
        };
        let _ = rt.apply_frame(&lift, &fp_cfg, &site, None, None);
        assert!(rt.preauth_nozzle_confirmed);

        // Poll loop starts delivery → CONFIG is scheduled for the wire (deferred), not assumed sent.
        rt.start_delivery_from_pre_auth(&fp_cfg, &site);
        assert!(rt.pending_authorize_config);
        assert!(!rt.preauth_config_on_wire);
        assert_eq!(rt.state.status, FpStatus::Authorizing);
    }

    #[test]
    fn app_stop_while_filling_stays_stopped_until_holster() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        // Actively delivering on nozzle 2, nozzle physically up.
        rt.state.status = FpStatus::Delivering;
        rt.state.nozzle_index = Some(2);
        rt.state.product_id = Some(3);
        rt.state.product_name = Some("AI-92".into());
        rt.state.price = 11000;
        rt.state.volume = 5.0;
        rt.state.amount = 55000;
        rt.current_tx = Some(CurrentTx {
            id: "tx-stop".into(),
            started_at: Utc::now().timestamp_millis(),
            product_id: 3,
            product_name: "AI-92".into(),
            nozzle_index: 2,
        });
        rt.note_wire_hose(0x12);

        // Operator stops from the app (terminal stop mode, no decel window).
        let effect = rt.apply_stop(&fp_cfg, &site, None, None, false, true);
        assert!(matches!(effect, Some(FrameEffect::Paused { .. })));
        assert!(matches!(rt.state.status, FpStatus::Stopped { .. }));
        assert!(rt.stopped_nozzle_up);

        // Pump polls idle (70 FA) while the nozzle is STILL up → must stay STOPPED, not reset to Idle.
        let idle = Frame::Idle { addr: 0x53 };
        let effect = rt.apply_frame(&idle, &fp_cfg, &site, None, None);
        assert!(matches!(effect, FrameEffect::StatusChanged));
        assert!(
            matches!(rt.state.status, FpStatus::Stopped { .. }),
            "must still show STOPPED while the nozzle is up, not Idle"
        );

        // Customer holsters → finalize the sale and return to Idle.
        let holster = Frame::NozzleHolstered {
            addr: 0x53,
            seq: 0x32,
        };
        let effect = rt.apply_frame(&holster, &fp_cfg, &site, None, None);
        assert!(matches!(effect, FrameEffect::TransactionDone { .. }));
        assert_eq!(rt.state.status, FpStatus::Idle);
        assert!(!rt.stopped_nozzle_up);
    }

    #[test]
    fn lifted_preauth_stays_authorizing_on_idle_after_nozzle_goes_stale() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        // Deferred holstered pre-auth → customer lifts → poll loop starts delivery (CONFIG deferred).
        assert!(matches!(
            rt.apply_preauthorize_sent(&fp_cfg, &site, 2, 11000, Preset::Amount(10_000)),
            PreauthOutcome::Holstered
        ));
        let lift = Frame::NozzleUp {
            addr: 0x53,
            seq: 0x31,
            product: 0x10,
            nozzle: 0x12,
        };
        let _ = rt.apply_frame(&lift, &fp_cfg, &site, None, None);
        rt.start_delivery_from_pre_auth(&fp_cfg, &site);
        assert_eq!(rt.state.status, FpStatus::Authorizing);
        assert!(
            rt.current_tx.is_some(),
            "deferred arming sets current_tx on lift"
        );

        // Customer holds the nozzle up but hasn't squeezed yet; >4s pass so the lift code goes stale.
        rt.last_wire_hose_at_ms = 0;
        assert!(!rt.nozzle_physically_up());

        // Pump polls idle (70 FA): must NOT ghost-cancel — the nozzle is still up.
        let idle = Frame::Idle { addr: 0x53 };
        let effect = rt.apply_frame(&idle, &fp_cfg, &site, None, None);
        assert!(matches!(effect, FrameEffect::None));
        assert_eq!(rt.state.status, FpStatus::Authorizing);
        assert!(rt.current_tx.is_some());

        // Same for a DispenserIdle (01 01 05) frame.
        let disp_idle = Frame::DispenserIdle {
            addr: 0x53,
            seq: 0x32,
        };
        let effect = rt.apply_frame(&disp_idle, &fp_cfg, &site, None, None);
        assert!(matches!(effect, FrameEffect::StatusChanged));
        assert_eq!(rt.state.status, FpStatus::Authorizing);

        // The real cancel still works: a holster frame ends the zero-volume session.
        let holster = Frame::NozzleHolstered {
            addr: 0x53,
            seq: 0x33,
        };
        let _ = rt.apply_frame(&holster, &fp_cfg, &site, None, None);
        assert_ne!(rt.state.status, FpStatus::Authorizing);
    }

    /// Build an armed Authorizing lane (authorize-nozzle-already-up) with a stale lift code, so the
    /// old logic would have cancelled on a holster frame.
    fn armed_authorizing_lane(site: &SiteConfig, fp_cfg: &FuelingPositionConfig) -> RuntimeFp {
        let mut rt = RuntimeFp::new(fp_cfg, site);
        rt.state.status = FpStatus::Authorizing;
        rt.state.nozzle_index = Some(2);
        rt.current_tx = Some(CurrentTx {
            id: "tx-echo".into(),
            started_at: Utc::now().timestamp_millis(),
            product_id: 3,
            product_name: "AI-92".into(),
            nozzle_index: 2,
        });
        rt.last_wire_hose_at_ms = 0; // stale → nozzle_physically_up() == false
        rt
    }

    #[test]
    fn config_echo_standalone_holster_within_grace_keeps_authorizing() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = armed_authorizing_lane(&site, &fp_cfg);
        rt.mark_preauth_config_on_wire(); // config_on_wire_at = now → within grace
        assert!(!rt.nozzle_physically_up());

        // Pump's post-CONFIG holster echo (01 01 02), zero volume.
        let echo = Frame::NozzleHolstered {
            addr: 0x53,
            seq: 0x39,
        };
        let effect = rt.apply_frame(&echo, &fp_cfg, &site, None, None);
        assert!(matches!(effect, FrameEffect::StatusChanged));
        assert_eq!(
            rt.state.status,
            FpStatus::Authorizing,
            "post-CONFIG echo must not de-authorize the lane"
        );
    }

    #[test]
    fn config_echo_embedded_holster_within_grace_keeps_authorizing() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = armed_authorizing_lane(&site, &fp_cfg);
        rt.mark_preauth_config_on_wire();

        // Zero-volume Data frame carrying an embedded holster tail (03 04 01 10 00 02).
        let frame = Frame::Data {
            addr: 0x53,
            seq: 0x31,
            volume_x1: 0,
            volume_x2: 0,
            volume_l: 0,
            volume_h: 0,
            amount: [0, 0, 0, 0],
            sale_complete: false,
            hose_product: Some(0x10),
            hose_code: Some(0x02),
        };
        let effect = rt.apply_frame(&frame, &fp_cfg, &site, None, None);
        assert!(matches!(effect, FrameEffect::StatusChanged));
        assert_eq!(rt.state.status, FpStatus::Authorizing);
    }

    #[test]
    fn config_echo_standalone_nozzle_returned_within_grace_keeps_authorizing() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = armed_authorizing_lane(&site, &fp_cfg);
        rt.mark_preauth_config_on_wire();

        // Pump echoes the holster as a standalone NozzleReturned (03 04 01 10 00 02).
        let echo = Frame::NozzleReturned {
            addr: 0x53,
            seq: 0x39,
            product: 0x10,
            hose: 0x02,
        };
        let effect = rt.apply_frame(&echo, &fp_cfg, &site, None, None);
        assert!(matches!(effect, FrameEffect::StatusChanged));
        assert_eq!(rt.state.status, FpStatus::Authorizing);
    }

    #[test]
    fn holster_after_config_echo_grace_still_cancels() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = armed_authorizing_lane(&site, &fp_cfg);
        // CONFIG went on the wire >3 s ago → grace window has expired.
        rt.config_on_wire_at = Some(Utc::now().timestamp_millis() - 5_000);
        rt.preauth_config_on_wire = true;
        assert!(!rt.within_config_echo_grace());

        let holster = Frame::NozzleHolstered {
            addr: 0x53,
            seq: 0x39,
        };
        let effect = rt.apply_frame(&holster, &fp_cfg, &site, None, None);
        assert!(matches!(effect, FrameEffect::CompleteGhostFill));
        assert_ne!(rt.state.status, FpStatus::Authorizing);
    }

    #[test]
    fn preauth_command_holstered_when_idle() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        let outcome = rt.apply_preauthorize_sent(&fp_cfg, &site, 2, 11000, Preset::Amount(10_000));

        assert!(matches!(outcome, PreauthOutcome::Holstered));
        assert_eq!(rt.pre_auth.as_ref().map(|p| p.nozzle_index), Some(2));
        assert_eq!(rt.state.status, FpStatus::PreAuthorized);
        assert!(!rt.preauth_nozzle_confirmed);
    }

    #[test]
    fn preauth_command_lift_confirmed_when_matching_nozzle_up() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        // The matching nozzle was already physically up when the operator pre-authorized.
        rt.state.status = FpStatus::NozzleUp;
        rt.state.nozzle_index = Some(2);

        let outcome = rt.apply_preauthorize_sent(&fp_cfg, &site, 2, 11000, Preset::Amount(10_000));

        assert!(matches!(outcome, PreauthOutcome::LiftConfirmed));
        assert!(rt.preauth_nozzle_confirmed);
        assert_eq!(rt.state.status, FpStatus::PreAuthorized);
        assert_eq!(rt.state.nozzle_index, Some(2));
    }

    #[test]
    fn preauth_command_wrong_nozzle_up_emits_mismatch_and_arms_nothing() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        // A DIFFERENT nozzle (3) was lifted in the TOCTOU window between the API's Idle read and
        // the poll loop draining the Preauthorize for nozzle 2.
        rt.state.status = FpStatus::NozzleUp;
        rt.state.nozzle_index = Some(3);
        rt.state.product_id = Some(5);
        rt.state.product_name = Some("AI-95".into());

        let outcome = rt.apply_preauthorize_sent(&fp_cfg, &site, 2, 11000, Preset::Amount(10_000));

        match outcome {
            PreauthOutcome::NozzleMismatch {
                expected_nozzle_index,
                expected_product_name,
                lifted_nozzle_index,
                lifted_product_name,
            } => {
                assert_eq!(expected_nozzle_index, 2);
                assert_eq!(expected_product_name, "AI-92");
                assert_eq!(lifted_nozzle_index, 3);
                assert_eq!(lifted_product_name, "AI-95");
            }
            _ => panic!("expected NozzleMismatch"),
        }

        // No pre-auth established, nothing armed on the wire, lane left on the lifted nozzle so
        // the operator can holster and re-authorize cleanly.
        assert!(rt.pre_auth.is_none());
        assert_eq!(rt.state.status, FpStatus::NozzleUp);
        assert_eq!(rt.state.nozzle_index, Some(3));
        assert!(!rt.ghost_recovery);
        assert!(!rt.preauth_config_on_wire);
    }

    #[test]
    fn preauth_command_none_nozzle_index_while_nozzle_up_is_defensive() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        // Pathological: NozzleUp but no resolved nozzle index. We cannot prove a conflict, so we
        // must not fabricate a mismatch — fall through to the normal preauth path.
        rt.state.status = FpStatus::NozzleUp;
        rt.state.nozzle_index = None;

        let outcome = rt.apply_preauthorize_sent(&fp_cfg, &site, 2, 11000, Preset::Amount(10_000));

        assert!(matches!(outcome, PreauthOutcome::Holstered));
        assert!(rt.pre_auth.is_some());
    }

    #[test]
    fn lift_after_done_keeps_authorized_nozzle_while_waiting_for_first_meter_data() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        rt.state.status = FpStatus::Done;
        rt.completed_sale = Some(CompletedSaleLatch);
        rt.state.nozzle_index = Some(3);
        rt.state.product_id = Some(5);
        rt.state.product_name = Some("AI-95".into());

        let lift = Frame::NozzleUp {
            addr: 0x53,
            seq: 0x31,
            product: 0x10,
            nozzle: 0x12,
        };
        let effect = rt.apply_frame(&lift, &fp_cfg, &site, None, None);
        assert!(matches!(
            effect,
            FrameEffect::NozzleUp {
                nozzle_index: 2,
                ..
            }
        ));
        assert_eq!(rt.state.status, FpStatus::NozzleUp);
        assert_eq!(rt.state.product_name.as_deref(), Some("AI-92"));
        assert!(rt.completed_sale.is_none());

        rt.state.price = 11000;
        rt.set_last_preset(Preset::Amount(10_000));
        rt.apply_nozzle_lift_deferred_config();

        rt.last_wire_hose_at_ms = 0;
        let effect = rt.apply_idle_response(&fp_cfg, &site, None, None);
        assert!(matches!(effect, FrameEffect::SendAuthorizeConfig));

        rt.mark_preauth_config_on_wire();
        rt.last_wire_hose_at_ms = 0;
        let effect = rt.apply_idle_response(&fp_cfg, &site, None, None);
        assert!(matches!(effect, FrameEffect::None));
        assert_eq!(rt.state.status, FpStatus::Authorizing);
        assert_eq!(rt.state.nozzle_index, Some(2));
        assert_eq!(
            rt.snapshot_state().pre_auth_preset.as_deref(),
            Some("10000 sum")
        );

        let data = Frame::Data {
            addr: 0x53,
            seq: 0x32,
            volume_x1: 0x00,
            volume_x2: 0x00,
            volume_l: 0x00,
            volume_h: 0x90,
            amount: [0x00, 0x00, 0x99, 0x00],
            sale_complete: false,
            // Deliberately misleading wire hose/product. The active authorization must win.
            hose_product: Some(0x11),
            hose_code: Some(0x13),
        };
        let effect = rt.apply_frame(&data, &fp_cfg, &site, None, None);

        assert!(matches!(effect, FrameEffect::StatusChanged));
        assert_eq!(rt.state.status, FpStatus::Delivering);
        assert_eq!(rt.state.nozzle_index, Some(2));
        assert_eq!(rt.state.product_name.as_deref(), Some("AI-92"));
        let tx = rt.current_tx.as_ref().expect("current transaction");
        assert_eq!(tx.nozzle_index, 2);
        assert_eq!(tx.product_name, "AI-92");
    }

    #[test]
    fn stale_nonzero_data_after_clean_lift_does_not_create_transaction() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        rt.state.status = FpStatus::Idle;

        let lift = Frame::NozzleUp {
            addr: 0x53,
            seq: 0x31,
            product: 0x10,
            nozzle: 0x12,
        };
        let effect = rt.apply_frame(&lift, &fp_cfg, &site, None, None);
        assert!(matches!(
            effect,
            FrameEffect::NozzleUp {
                nozzle_index: 2,
                ..
            }
        ));

        let stale_data = Frame::Data {
            addr: 0x53,
            seq: 0x32,
            volume_x1: 0x00,
            volume_x2: 0x00,
            volume_l: 0x05,
            volume_h: 0x00,
            amount: [0x00, 0x00, 0x55, 0x00],
            sale_complete: true,
            hose_product: Some(0x10),
            hose_code: Some(0x12),
        };
        let effect = rt.apply_frame(&stale_data, &fp_cfg, &site, None, None);

        assert!(matches!(effect, FrameEffect::StatusChanged));
        assert_eq!(rt.state.status, FpStatus::NozzleUp);
        assert_eq!(rt.state.volume, 0.0);
        assert_eq!(rt.state.amount, 0);
        assert!(rt.current_tx.is_none());
        assert!(rt.completed_sale.is_none());

        let returned = Frame::NozzleReturned {
            addr: 0x53,
            seq: 0x33,
            product: 0x10,
            hose: 0x02,
        };
        let effect = rt.apply_frame(&returned, &fp_cfg, &site, None, None);
        assert!(matches!(effect, FrameEffect::StatusChanged));
        assert_eq!(rt.state.status, FpStatus::Idle);
        assert!(rt.current_tx.is_none());
        assert!(rt.completed_sale.is_none());
    }

    #[test]
    fn idle_live_meter_data_after_restart_is_adopted() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        rt.state.status = FpStatus::Idle;

        let live_data = Frame::Data {
            addr: 0x53,
            seq: 0x32,
            volume_x1: 0x00,
            volume_x2: 0x00,
            volume_l: 0x05,
            volume_h: 0x00,
            amount: [0x00, 0x00, 0x65, 0x00],
            sale_complete: false,
            hose_product: Some(0x11),
            hose_code: Some(0x13),
        };
        let effect = rt.apply_frame(&live_data, &fp_cfg, &site, None, None);

        assert!(matches!(effect, FrameEffect::StatusChanged));
        assert_eq!(rt.state.status, FpStatus::Delivering);
        assert_eq!(rt.state.nozzle_index, Some(3));
        assert_eq!(rt.state.product_name.as_deref(), Some("AI-95"));
        assert_eq!(rt.state.volume, 5.0);
        assert_eq!(rt.state.amount, 65000);
        let tx = rt.current_tx.as_ref().expect("adopted transaction");
        assert_eq!(tx.nozzle_index, 3);
        assert_eq!(tx.product_name, "AI-95");
    }

    #[test]
    fn missed_polls_do_not_drop_armed_authorization_to_offline() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        rt.state.status = FpStatus::Authorizing;
        rt.state.nozzle_index = Some(2);
        rt.state.product_id = Some(3);
        rt.state.product_name = Some("AI-92".into());
        rt.state.price = 11100;
        rt.set_last_preset(Preset::Volume(1.0));
        rt.mark_preauth_config_on_wire();

        for _ in 0..10 {
            assert!(!rt.on_poll_missed(6));
        }

        assert_eq!(rt.state.status, FpStatus::Authorizing);
        assert_eq!(rt.state.nozzle_index, Some(2));
        assert_eq!(
            rt.snapshot_state().pre_auth_preset.as_deref(),
            Some("1.00 L")
        );
    }

    #[test]
    fn late_data_after_offline_prefers_armed_nozzle_over_wire_guess() {
        let site = sample_site_two_nozzles();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        rt.state.status = FpStatus::Offline;
        rt.state.nozzle_index = Some(2);
        rt.state.product_id = Some(3);
        rt.state.product_name = Some("AI-92".into());
        rt.state.price = 11100;
        rt.set_last_preset(Preset::Volume(1.0));
        rt.mark_preauth_config_on_wire();

        let data = Frame::Data {
            addr: 0x53,
            seq: 0x32,
            volume_x1: 0x00,
            volume_x2: 0x00,
            volume_l: 0x00,
            volume_h: 0x90,
            amount: [0x00, 0x00, 0x99, 0x90],
            sale_complete: false,
            hose_product: Some(0x11),
            hose_code: Some(0x13),
        };
        let effect = rt.apply_frame(&data, &fp_cfg, &site, None, None);

        assert!(matches!(effect, FrameEffect::StatusChanged));
        assert_eq!(rt.state.status, FpStatus::Delivering);
        assert_eq!(rt.state.nozzle_index, Some(2));
        assert_eq!(rt.state.product_name.as_deref(), Some("AI-92"));
        let tx = rt.current_tx.as_ref().expect("current transaction");
        assert_eq!(tx.nozzle_index, 2);
        assert_eq!(tx.product_name, "AI-92");
    }

    #[test]
    fn amount_preset_uses_pump_reported_money_when_exact() {
        let site = sample_site();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        rt.state.status = FpStatus::Delivering;
        rt.state.nozzle_index = Some(2);
        rt.state.price = 11000;
        rt.set_last_preset(Preset::Amount(10_000));
        rt.current_tx = Some(CurrentTx {
            id: "tx".into(),
            started_at: Utc::now().timestamp_millis(),
            product_id: 3,
            product_name: "AI-92".into(),
            nozzle_index: 2,
        });
        let amount = rt.metered_amount(0.90, 10_000);
        rt.apply_metering(0.90, amount);

        assert_eq!(rt.state.amount, 10_000);
        assert!(rt.sale_target_met());

        rt.pump_sale_complete = true;
        let effect = rt.complete_sale_from_holster(&fp_cfg, &site, None, None);
        let FrameEffect::TransactionDone { tx, .. } = effect else {
            panic!("expected completed transaction");
        };

        assert_eq!(tx.volume, 0.90);
        assert_eq!(tx.amount, 10_000);
        assert!(matches!(tx.status, TxStatus::Completed));
    }

    #[test]
    fn amount_preset_keeps_pump_reported_shortfall_without_rounding() {
        let site = sample_site();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        rt.state.status = FpStatus::Delivering;
        rt.state.nozzle_index = Some(2);
        rt.state.price = 11000;
        rt.set_last_preset(Preset::Amount(10_000));
        rt.current_tx = Some(CurrentTx {
            id: "tx".into(),
            started_at: Utc::now().timestamp_millis(),
            product_id: 3,
            product_name: "AI-92".into(),
            nozzle_index: 2,
        });
        let amount = rt.metered_amount(0.90, 9_900);
        rt.apply_metering(0.90, amount);

        assert_eq!(rt.state.amount, 9_900);
        assert!(!rt.sale_target_met());

        rt.pump_sale_complete = true;
        let effect = rt.complete_sale_from_holster(&fp_cfg, &site, None, None);
        let FrameEffect::TransactionDone { tx, .. } = effect else {
            panic!("expected completed transaction");
        };

        assert_eq!(tx.volume, 0.90);
        assert_eq!(tx.amount, 9_900);
        assert!(matches!(tx.status, TxStatus::Completed));
    }

    #[test]
    fn volume_preset_ignores_pump_amount_field() {
        let site = sample_site();
        let fp_cfg = site.fueling_positions[0].clone();
        let mut rt = RuntimeFp::new(&fp_cfg, &site);

        rt.state.nozzle_index = Some(2);
        rt.state.price = 11000;
        rt.set_last_preset(Preset::Volume(1.0));

        assert_eq!(rt.metered_amount(0.90, 10_000), 9_900);
    }
}
