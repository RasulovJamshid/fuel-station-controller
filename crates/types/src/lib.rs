//! Shared types (UNIVERSAL_CONFIG.md).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StopSource {
    App,
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
    /// Human-readable preset while `status` is `PRE_AUTHORIZED`.
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
    pub fn counts_toward_revenue(&self) -> bool {
        matches!(self, Self::Completed | Self::Stopped)
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
    ShiftHandover { outgoing: Shift, incoming: Shift },
    #[serde(rename = "shift.warning")]
    ShiftEndWarning {
        shift_id: String,
        minutes_remaining: u32,
    },
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

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StopCmd {
    pub fp_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ContinueFillCmd {
    pub stopped_tx_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ResumeFillCmd {
    pub stopped_tx_id: String,
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
    pub shift_mode: String,
    pub shift_schedule: Vec<ShiftSlot>,
    pub require_operator_pin: bool,
    #[serde(default = "default_auth_mode")]
    pub default_auth_mode: String,
    #[serde(default = "default_preauth_timeout_seconds")]
    pub preauth_timeout_seconds: u64,
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
    #[serde(default)]
    pub pin: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
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
    #[serde(default)]
    pub incoming_pin: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
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
