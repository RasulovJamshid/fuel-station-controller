//! Shared types (UNIVERSAL_CONFIG.md).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StopSource {
    /// Legacy app-initiated pause. No longer produced — pausing was removed and
    /// every app stop is final — but kept so historical `"APP"` rows still load.
    App,
    /// App-initiated stop — saves as STOPPED then promotes to COMPLETED on nozzle down.
    AppFinal,
    /// Pump-side stop (nozzle handle released) — saves as STOPPED for operator review.
    External,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FpStatus {
    Offline,
    Idle,
    /// Operator authorized before customer lifted the nozzle.
    PreAuthorized,
    NozzleUp,
    Authorizing,
    Delivering,
    /// Delivery has stopped; authoritative final meter data is still pending.
    Finalizing,
    Done,
    Stopped {
        stopped_volume: f64,
        stopped_amount: u64,
        stopped_tx_id: String,
        stop_source: StopSource,
    },
}

impl FpStatus {
    pub fn tag(&self) -> &'static str {
        match self {
            FpStatus::Offline => "OFFLINE",
            FpStatus::Idle => "IDLE",
            FpStatus::PreAuthorized => "PRE_AUTHORIZED",
            FpStatus::NozzleUp => "NOZZLE_UP",
            FpStatus::Authorizing => "AUTHORIZING",
            FpStatus::Delivering => "DELIVERING",
            FpStatus::Finalizing => "FINALIZING",
            FpStatus::Done => "DONE",
            FpStatus::Stopped { .. } => "STOPPED",
        }
    }

    pub fn is_stopped(&self) -> bool {
        matches!(self, FpStatus::Stopped { .. })
    }

    pub fn stop_source(&self) -> Option<StopSource> {
        match self {
            FpStatus::Stopped { stop_source, .. } => Some(*stop_source),
            _ => None,
        }
    }
}

/// Lifetime pump totalizer for one nozzle (Gilbarco GetTotals). One entry per
/// configured nozzle so the UI can show totals for the currently-selected product.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PumpNozzleTotals {
    pub nozzle_index: u8,
    pub volume: f64,
    pub amount: u64,
    pub price: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FpState {
    pub fp_id: String,
    pub label: String,
    pub address_byte: u8,
    pub status: FpStatus,
    /// Display volume (combined total while continuing a stopped fill).
    pub volume: f64,
    /// Display amount (combined total while continuing a stopped fill).
    pub amount: u64,
    pub price: u32,
    pub nozzle_index: Option<u8>,
    pub product_id: Option<u8>,
    pub product_name: Option<String>,
    pub product_color: Option<String>,
    pub nozzle_count: u8,
    pub seq: u8,
    pub missed_polls: u32,
    pub updated_at: i64,
    /// Set when `status` is `STOPPED` — transaction that can be continued or closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_tx_id: Option<String>,
    /// Prior segments' volume before the current pump counter (continuation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_amount: Option<u64>,
    /// Current segment raw volume from the pump (resets to 0 on each AUTH).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segment_volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segment_amount: Option<u64>,
    /// Latest pump totalizer for the currently selected/last sold nozzle.
    /// Kept for backward compatibility; prefer `pump_totals` (per-nozzle) when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_total_nozzle_index: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_total_volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_total_amount: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_total_price: Option<u32>,
    /// Per-nozzle pump totalizer (one entry per configured nozzle). Lets the UI show
    /// totals for the currently-selected product instead of only the first nozzle.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pump_totals: Vec<PumpNozzleTotals>,
    /// Human-readable active preset/limit shown while pre-authorized or filling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_auth_preset: Option<String>,
    /// Mirror of `STOPPED` payload for clients that read flat fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_source: Option<StopSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    pub id: String,
    pub fp_id: String,
    pub label: String,
    pub address_byte: u8,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    /// Volume for this segment (pump counter leg).
    pub volume: f64,
    /// Amount for this segment.
    pub amount: u64,
    pub price: u32,
    pub nozzle_index: u8,
    pub product_id: u8,
    pub product_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_label: Option<String>,
    pub status: TxStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shift_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tx_id: Option<String>,
    /// Total across all segments (root + continuations) for reporting.
    pub combined_volume: f64,
    pub combined_amount: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TxStatus {
    Completed,
    Aborted,
    /// E-stopped; may be continued via a child segment.
    Stopped,
    /// This segment continues a stopped parent transaction.
    #[serde(rename = "CONTINUED_FROM")]
    ContinuedFrom(String),
}

impl TxStatus {
    /// `ABORTED` only when no fuel was dispensed; otherwise `COMPLETED` vs `STOPPED`.
    pub fn resolve(volume: f64, completed_normally: bool) -> Self {
        if volume <= 0.0 {
            Self::Aborted
        } else if completed_normally {
            Self::Completed
        } else {
            Self::Stopped
        }
    }

    /// Revenue and shift totals include completed and interrupted sales with fuel.
    /// ContinuedFrom carries the segment volume only; caller must add it to the
    /// already-counted STOPPED parent to avoid double-counting.
    pub fn counts_toward_revenue(&self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Stopped | Self::ContinuedFrom(_)
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
pub enum WsEvent {
    #[serde(rename = "fp.status")]
    Status(FpState),
    #[serde(rename = "fp.pre_authorized")]
    PreAuthorized {
        fp_id: String,
        price: u32,
        preset: String,
        nozzle_index: u8,
    },
    #[serde(rename = "fp.pre_auth_cancelled")]
    PreAuthCancelled { fp_id: String },
    #[serde(rename = "fp.pre_auth_nozzle_mismatch")]
    PreAuthNozzleMismatch {
        fp_id: String,
        expected_nozzle_index: u8,
        expected_product_name: String,
        lifted_nozzle_index: u8,
        lifted_product_name: String,
    },
    #[serde(rename = "fp.nozzle_up")]
    NozzleUp {
        fp_id: String,
        nozzle_index: u8,
        product_id: u8,
        product_name: String,
        product_color: String,
        price: u32,
    },
    #[serde(rename = "fp.done")]
    Done(Transaction),
    #[serde(rename = "fp.paused")]
    Paused {
        fp_id: String,
        stopped_volume: f64,
        stopped_amount: u64,
        stopped_tx_id: String,
        stop_source: String,
    },
    #[serde(rename = "fp.nozzle_removed")]
    NozzleRemoved {
        fp_id: String,
        stopped_tx_id: Option<String>,
    },
    #[serde(rename = "fp.pre_auth_timeout")]
    PreAuthTimeout { fp_id: String },
    /// Meter data arrived on a lane that holds no authorization (e.g. a pump left armed after a
    /// cancelled pre-auth). The poll loop STOPs the pump and raises this so the operator is alerted.
    #[serde(rename = "fp.unauthorized_delivery")]
    UnauthorizedDelivery {
        fp_id: String,
        volume: f64,
        amount: u64,
    },
    #[serde(rename = "fp.offline")]
    Offline { fp_id: String, label: String },
    #[serde(rename = "fp.online")]
    Online { fp_id: String, label: String },
    #[serde(rename = "service.connected")]
    Connected {
        site_name: String,
        fp_count: usize,
        protocol: String,
    },
    #[serde(rename = "service.price_updated")]
    PriceUpdated {
        fp_id: String,
        nozzle_index: u8,
        product_name: String,
        old_price: u32,
        new_price: u32,
        changed_by: String,
    },
    #[serde(rename = "shift.started")]
    ShiftStarted(Shift),
    #[serde(rename = "shift.ended")]
    ShiftEnded(Shift),
    #[serde(rename = "shift.handover")]
    /// Boxed so the rare handover payload does not set the size of every
    /// `WsEvent` sent on the broadcast channel (status frames are the hot path).
    ShiftHandover {
        outgoing: Box<Shift>,
        incoming: Box<Shift>,
    },
    #[serde(rename = "shift.warning")]
    ShiftEndWarning {
        shift_id: String,
        minutes_remaining: u32,
    },
    /// ATG poller published fresh tank levels. Sent after every successful Modbus round.
    #[serde(rename = "tank.updated")]
    TankUpdated { tanks: Vec<TankSnapshot> },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AuthorizeCmd {
    pub fp_id: String,
    #[serde(default)]
    pub nozzle_index: Option<u8>,
    pub preset: Preset,
    /// If set, used as price for this authorization instead of runtime/config price.
    #[serde(default)]
    pub price_override: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Preset {
    /// JSON `"full"`
    Str(String),
    Amount(u64),
    Volume(f64),
}

impl Preset {
    pub fn is_full(&self) -> bool {
        matches!(self, Preset::Str(s) if s.eq_ignore_ascii_case("full"))
    }
}

/// Display label for operator UI and WebSocket events.
pub fn preset_label(preset: &Preset) -> String {
    match preset {
        Preset::Str(s) if s.eq_ignore_ascii_case("full") => "Full tank".into(),
        Preset::Volume(v) => format!("{v:.2} L"),
        Preset::Amount(a) => format!("{a} sum"),
        Preset::Str(_) => "Preset".into(),
    }
}

/// Optional metadata for persisted transactions. This is informational only:
/// pump authorization and close logic continue to use `Preset` directly.
pub fn preset_metadata(preset: &Preset) -> (Option<String>, Option<f64>, Option<String>) {
    match preset {
        Preset::Str(s) if s.eq_ignore_ascii_case("full") => {
            (Some("full".into()), None, Some(preset_label(preset)))
        }
        Preset::Volume(v) => (Some("volume".into()), Some(*v), Some(preset_label(preset))),
        Preset::Amount(a) => (
            Some("amount".into()),
            Some(*a as f64),
            Some(preset_label(preset)),
        ),
        Preset::Str(_) => (None, None, None),
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StopCmd {
    pub fp_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CloseStoppedTxCmd {
    pub stopped_tx_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UpdatePriceCmd {
    pub fp_id: String,
    pub nozzle_index: u8,
    pub price: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UpdateAllPricesCmd {
    pub updates: Vec<UpdatePriceCmd>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteSnapshot {
    pub site_id: String,
    pub site_name: String,
    pub protocol: String,
    pub positions: Vec<FpSnapshot>,
    pub products: Vec<ProductSnapshot>,
    #[serde(default)]
    pub tanks: Vec<TankSnapshot>,
    pub shift_mode: String,
    pub shift_schedule: Vec<ShiftSlot>,
    pub require_operator_pin: bool,
    #[serde(default = "default_auth_mode")]
    pub default_auth_mode: String,
    #[serde(default = "default_preauth_timeout_seconds")]
    pub preauth_timeout_seconds: u64,
    /// When true show a "Cancel" button that stops and immediately closes the transaction.
    #[serde(default)]
    pub use_cancel_mode: bool,
}

fn default_preauth_timeout_seconds() -> u64 {
    300
}

fn default_auth_mode() -> String {
    "reactive".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FpSnapshot {
    pub fp_id: String,
    pub label: String,
    pub address_byte: u8,
    pub active: bool,
    pub nozzles: Vec<NozzleSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NozzleSnapshot {
    pub index: u8,
    pub product_id: u8,
    pub product_name: String,
    pub product_color: String,
    pub price: u32,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductSnapshot {
    pub id: u8,
    pub name: String,
    pub color: String,
    pub unit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TankSnapshot {
    pub product_id: u8,
    pub label: String,
    pub capacity_l: f64,
    pub current_l: f64,
    /// Fuel temperature in °C from the ATG probe. Absent when ATG is not configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature_c: Option<f64>,
    /// Water layer volume in litres from the ATG probe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub water_l: Option<f64>,
    /// Unix millisecond timestamp of the last successful ATG Modbus read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<i64>,
}

/// Live reading from the ATG poller, keyed by product_id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TankLiveLevel {
    pub product_id: u8,
    /// Current fuel volume in litres from the Modbus probe.
    pub current_l: f64,
    /// Fuel temperature in °C.
    pub temperature_c: f64,
    /// Water layer volume in litres.
    pub water_l: f64,
    /// Unix millisecond timestamp of the last successful Modbus read.
    pub updated_at_ms: i64,
}

// ── Shift types (SHIFT_MANAGEMENT.md) ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ShiftStatus {
    Active,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shift {
    pub id: String,
    pub operator_id: Option<String>,
    pub operator_name: String,
    pub shift_name: Option<String>,
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub total_transactions: u32,
    pub total_volume: f64,
    pub total_amount: u64,
    pub status: ShiftStatus,
    pub notes: Option<String>,
    #[serde(default)]
    pub position_totals: Vec<ShiftPositionTotal>,
    /// Sales broken down by fuel grade — the standard Z-report grade section.
    #[serde(default)]
    pub product_totals: Vec<ShiftProductTotal>,
    /// Electronic totalizer readings captured at shift open and close, per nozzle.
    /// Empty on protocols that do not report totalizers (e.g. Wayne Europump).
    #[serde(default)]
    pub nozzle_totalizers: Vec<ShiftNozzleTotalizer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShiftPositionTotal {
    pub fp_id: String,
    pub label: String,
    pub transactions_count: u32,
    pub total_volume: f64,
    pub total_amount: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShiftProductTotal {
    pub product_id: u8,
    pub product_name: String,
    pub transactions_count: u32,
    pub total_volume: f64,
    pub total_amount: u64,
}

/// Opening and closing electronic totalizer readings for one nozzle over a shift.
///
/// `dispensed_volume` is the totalizer delta (current/close − open). Comparing it with the
/// summed transaction volume for the same nozzle is the audit check that proves the
/// recorded sales account for everything the meter actually delivered.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShiftNozzleTotalizer {
    pub fp_id: String,
    pub label: String,
    pub nozzle_index: u8,
    pub product_id: u8,
    pub product_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_volume: Option<f64>,
    /// Latest available meter reading for an active shift; never a closing snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_amount: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_amount: Option<u64>,
    /// Meter change: current − open while active, close − open once closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispensed_volume: Option<f64>,
    /// Sum of recorded transaction volume on this nozzle during the shift.
    #[serde(default)]
    pub recorded_volume: f64,
    /// `dispensed_volume − recorded_volume`. Non-zero means metered fuel that no
    /// transaction accounts for (or vice versa).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variance_volume: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Operator {
    pub id: String,
    pub name: String,
    pub has_pin: bool,
    pub active: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StartShiftCmd {
    pub operator_name: String,
    /// Optional link to an existing operator record.
    #[serde(default)]
    pub operator_id: Option<String>,
    #[serde(default)]
    pub pin: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    /// Override the shift start timestamp (Unix ms). When absent the service uses now().
    #[serde(default)]
    pub started_at_override: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EndShiftCmd {
    pub shift_id: String,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HandoverCmd {
    pub outgoing_shift_id: String,
    pub incoming_operator: String,
    /// Optional link to an existing operator record for the incoming operator.
    #[serde(default)]
    pub incoming_operator_id: Option<String>,
    #[serde(default)]
    pub incoming_pin: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    /// Override the incoming shift's start timestamp (Unix ms). Absent = server uses now().
    #[serde(default)]
    pub incoming_started_at_override: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShiftSlot {
    pub name: String,
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CreateOperatorCmd {
    pub name: String,
    #[serde(default)]
    pub pin: Option<String>,
}

// ── Admin API ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdminAuthCmd {
    pub pin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminAuthResponse {
    pub token: String,
    pub expires_in: u64,
    #[serde(default)]
    pub must_change_pin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminPriceEntry {
    pub fp_id: String,
    pub label: String,
    pub nozzle_index: u8,
    pub product_id: u8,
    pub product_name: String,
    pub price: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceChange {
    pub id: String,
    pub fp_id: String,
    pub nozzle_index: u8,
    pub product_id: u8,
    pub product_name: String,
    pub old_price: u32,
    pub new_price: u32,
    pub changed_at: i64,
    pub changed_by: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdminConfigEntry {
    pub key: String,
    pub value: String,
    pub updated_at: i64,
    pub updated_by: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdminSetConfigCmd {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdminChangePinCmd {
    pub current_pin: String,
    pub new_pin: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdminApplyPricesCmd {
    pub fp_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdminUpdateOperatorCmd {
    #[serde(default)]
    pub active: Option<bool>,
    #[serde(default)]
    pub pin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminSettingsSnapshot {
    pub polling_interval_ms: u64,
    pub polling_offline_threshold_polls: u32,
    pub preauth_timeout_seconds: u64,
    pub shifts_warn_before_end_minutes: u32,
    pub shift_mode: String,
    pub shift_schedule: Vec<ShiftSlot>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdminShiftScheduleCmd {
    pub mode: String,
    #[serde(default)]
    pub scheduled: Vec<ShiftSlot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminCatalog {
    pub products: Vec<ProductSnapshot>,
    pub positions: Vec<AdminPositionCatalog>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminPositionCatalog {
    pub fp_id: String,
    pub label: String,
    pub address_byte: u8,
    pub active: bool,
    pub nozzles: Vec<AdminNozzleRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminNozzleRow {
    pub index: u8,
    pub product_id: u8,
    pub product_name: String,
    pub price: u32,
    pub active: bool,
    #[serde(default)]
    pub wayne_code: u8,
    #[serde(default)]
    pub wayne_product_code: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdminProductInput {
    /// Omit for new products (server assigns next free id).
    #[serde(default)]
    pub id: Option<u8>,
    /// Stable UUID — preserved on update, auto-generated by server on create.
    #[serde(default)]
    pub uuid: Option<String>,
    pub name: String,
    pub color: String,
    #[serde(default = "default_product_unit")]
    pub unit: String,
}

fn default_product_unit() -> String {
    "litre".into()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SaveProductsCmd {
    pub products: Vec<AdminProductInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdminNozzleInput {
    pub index: u8,
    pub product_id: u8,
    pub price: u32,
    pub active: bool,
    #[serde(default)]
    pub wayne_code: u8,
    #[serde(default)]
    pub wayne_product_code: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SavePositionNozzlesCmd {
    pub nozzles: Vec<AdminNozzleInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxSummary {
    pub count: i64,
    pub total_volume: f64,
    pub total_amount: i64,
}

// ── Wetstock: deliveries and reconciliation ───────────────────────────────

/// A fuel delivery (tanker drop) into one tank.
///
/// Deliveries are the "in" side of book stock. Without them, book stock only ever
/// falls and reconciliation against the ATG dip is meaningless.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FuelDelivery {
    pub id: String,
    pub product_id: u8,
    pub product_name: String,
    pub tank_label: String,
    /// Unix ms when the fuel was actually dropped.
    pub delivered_at: i64,
    /// Waybill / delivery note reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supplier: Option<String>,
    /// Litres stated on the delivery document.
    pub ordered_l: f64,
    /// Litres actually received (the figure that moves book stock).
    pub delivered_l: f64,
    /// Tank volume measured before the drop, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tank_before_l: Option<f64>,
    /// Tank volume measured after the drop, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tank_after_l: Option<f64>,
    /// `(tank_after_l − tank_before_l) − delivered_l`: short/over delivery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variance_l: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature_c: Option<f64>,
    /// Purchase price per litre in minor units.
    pub price_per_l: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shift_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CreateDeliveryCmd {
    pub product_id: u8,
    #[serde(default)]
    pub tank_label: Option<String>,
    /// Defaults to now when omitted.
    #[serde(default)]
    pub delivered_at: Option<i64>,
    #[serde(default)]
    pub document_ref: Option<String>,
    #[serde(default)]
    pub supplier: Option<String>,
    #[serde(default)]
    pub ordered_l: f64,
    pub delivered_l: f64,
    #[serde(default)]
    pub tank_before_l: Option<f64>,
    #[serde(default)]
    pub tank_after_l: Option<f64>,
    #[serde(default)]
    pub temperature_c: Option<f64>,
    #[serde(default)]
    pub price_per_l: u32,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VarianceStatus {
    /// Within tolerance.
    Ok,
    /// Outside tolerance but below the alarm threshold.
    Warn,
    /// Outside the alarm threshold — investigate for leak or theft.
    Alarm,
}

/// One wetstock reconciliation: book stock versus measured (ATG) stock.
///
/// `book_closing_l = opening_l + deliveries_l − sales_l`, and
/// `variance_l = measured_l − book_closing_l`. A persistent negative variance is
/// the classic signature of a leak or unrecorded draw-off.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WetstockReconciliation {
    pub id: String,
    pub product_id: u8,
    pub product_name: String,
    pub tank_label: String,
    pub period_start: i64,
    pub period_end: i64,
    pub opening_l: f64,
    pub deliveries_l: f64,
    pub sales_l: f64,
    pub book_closing_l: f64,
    pub measured_l: f64,
    pub variance_l: f64,
    /// Variance as a percentage of throughput (deliveries + sales).
    pub variance_pct: f64,
    pub status: VarianceStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shift_id: Option<String>,
    /// False when no ATG reading was available, so `measured_l` is not trustworthy.
    pub measured_available: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ReconcileCmd {
    /// Reconcile only this product; omit to reconcile every configured tank.
    #[serde(default)]
    pub product_id: Option<u8>,
    /// Start of the period. Defaults to the previous reconciliation for the tank,
    /// or the current shift start, whichever is later.
    #[serde(default)]
    pub period_start: Option<i64>,
    #[serde(default)]
    pub notes: Option<String>,
}

// ── Scheduled price changes ───────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ScheduledPriceStatus {
    Pending,
    Applied,
    Cancelled,
    Failed,
}

/// A future-dated price change. The scheduler applies it once `effective_at` passes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledPrice {
    pub id: String,
    pub product_id: u8,
    pub product_name: String,
    pub new_price: u32,
    pub effective_at: i64,
    pub status: ScheduledPriceStatus,
    pub created_by: String,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CreateScheduledPriceCmd {
    pub product_id: u8,
    pub new_price: u32,
    /// Unix ms at which the price becomes effective. Must be in the future.
    pub effective_at: i64,
    #[serde(default)]
    pub notes: Option<String>,
}
