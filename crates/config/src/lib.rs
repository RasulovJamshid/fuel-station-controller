//! Universal site configuration (UNIVERSAL_CONFIG.md).

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SiteConfig {
    pub site: SiteInfo,
    pub service: ServiceConfig,
    pub connection: ConnectionConfig,
    pub polling: PollingConfig,
    pub products: Vec<ProductConfig>,
    pub fueling_positions: Vec<FuelingPositionConfig>,
    pub sync: SyncConfig,
    #[serde(default)]
    pub shifts: ShiftConfig,
    #[serde(default)]
    pub ui: UiConfig,
    #[serde(default)]
    pub tanks: Vec<TankConfig>,
    /// ATG Modbus polling config. Absent or null = feature disabled.
    #[serde(default)]
    pub atg: Option<AtgConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TankConfig {
    pub product_id: u8,
    pub label: String,
    pub capacity_l: f64,
    pub current_l: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UiConfig {
    /// `reactive` — authorize after nozzle up; `preauth` — authorize while idle.
    #[serde(default = "default_auth_mode")]
    pub default_auth_mode: String,
    /// Auto-cancel pre-authorization if the customer never lifts the nozzle (0 = disabled).
    #[serde(default = "default_preauth_timeout_seconds")]
    pub preauth_timeout_seconds: u64,
    /// When true, keep sending BUSY for up to ~10 s after an app-initiated STOP so the
    /// pump can accept re-authorization and continue delivery without resetting its counter
    /// (old-app behavior).  Falls back to normal STOPPED state if the pump ignores BUSY.
    #[serde(default)]
    pub use_decel_window_on_stop: bool,
    /// When true, the app Stop button acts as a final stop (no resume): the transaction
    /// is promoted to COMPLETED once the nozzle is holstered.  When false (default) it
    /// acts as Pause so the operator can resume the fill later.
    #[serde(default)]
    pub use_stop_mode: bool,
    /// When true, show a "Cancel" button during delivery instead of Pause/Stop.
    /// Clicking it stops the pump and immediately closes the transaction (no holster
    /// required).  Intended for simulator configs where there is no physical nozzle.
    #[serde(default)]
    pub use_cancel_mode: bool,
}

fn default_auth_mode() -> String {
    "reactive".into()
}

fn default_preauth_timeout_seconds() -> u64 {
    300
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            default_auth_mode: default_auth_mode(),
            preauth_timeout_seconds: default_preauth_timeout_seconds(),
            use_decel_window_on_stop: false,
            use_stop_mode: false,
            use_cancel_mode: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SiteInfo {
    pub id: String,
    pub name: String,
    pub timezone: String,
    #[serde(default)]
    pub address: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ServiceConfig {
    pub port: u16,
    pub log_level: String,
    pub log_file: String,
    pub db_path: String,
    /// Path for raw serial frame log (TX/RX hex). `null` or absent = disabled.
    /// Overridden at runtime by the `AZS_SERIAL_LOG` environment variable.
    #[serde(default)]
    pub serial_log_file: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ConnectionConfig {
    pub protocol: Protocol,
    pub port: String,
    pub baud_rate: u32,
    pub parity: Parity,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub response_timeout_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    WayneEuropump,
    WayneDartV1,
    WayneDartV2,
    Gilbarco,
    /// AZT 2.0 (ОАО АЗТ) RS-485 protocol — 4800 baud, complementary-byte framing.
    #[serde(rename = "azt2_0")]
    Azt20,
    #[serde(rename = "mock")]
    Mock,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Parity {
    None,
    Odd,
    Even,
}

impl Parity {
    pub fn to_serialport(self) -> serialport::Parity {
        match self {
            Parity::None => serialport::Parity::None,
            Parity::Odd => serialport::Parity::Odd,
            Parity::Even => serialport::Parity::Even,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PollingConfig {
    pub interval_ms: u64,
    pub offline_threshold_polls: u32,
    pub reconnect_settle_rounds: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProductConfig {
    pub id: u8,
    /// Stable UUID for cross-system identification. Auto-generated on first load for
    /// configs that pre-date this field.
    #[serde(default = "gen_product_uuid")]
    pub uuid: String,
    pub name: String,
    pub color: String,
    pub unit: String,
}

fn gen_product_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FuelingPositionConfig {
    pub id: String,
    pub label: String,
    pub address_byte: u8,
    pub active: bool,
    pub nozzles: Vec<NozzleConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NozzleConfig {
    pub index: u8,
    pub product_id: u8,
    pub price: u32,
    pub active: bool,
    /// AZT 2.0 only: this nozzle's own RS-485 network address (1..=15). AZT puts
    /// each hose on its own address, so one pump card groups several nozzles at
    /// different addresses. `None`/0 → fall back to the position's `address_byte`
    /// (single-hose pumps and all other protocols ignore this field).
    #[serde(default)]
    pub azt_address: u8,
    /// Wayne hose byte on lift (`>= 0x10`) and holster (`lift - 0x10`, e.g. 18/2, 17/1, 19/3).
    #[serde(default)]
    pub wayne_code: u8,
    /// Wayne product byte in `03 04 01 [PP] 00 [HH]` (e.g. 0x05 = 5, 0x43 = 67, 0x24 = 36).
    /// Required when one pump has several hoses sharing grades; use 0 to match by `wayne_code` only.
    #[serde(default)]
    pub wayne_product_code: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SyncConfig {
    pub enabled: bool,
    pub backend_url: String,
    pub api_key: String,
    /// How often the sync worker pushes queued records (seconds). Default: 30.
    #[serde(default = "default_retry_interval_secs")]
    pub retry_interval_secs: u64,
    /// Max records per HTTP batch. Default: 100.
    #[serde(default = "default_batch_size")]
    pub batch_size: usize,
    /// Records rejected this many times are skipped permanently. Default: 10.
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,
    /// How often to pull price changes from the server (hours). Default: 12 (twice a day).
    /// Set to 0 to disable scheduled pulls (startup-only).
    #[serde(default = "default_price_pull_interval_hours")]
    pub price_pull_interval_hours: u64,
    /// Independent on/off switch for pulling prices from the server. When false,
    /// outbound data sync still runs but remote price changes are NOT pulled — lets
    /// the operator disable price sync alone without turning off all sync. Default: true
    /// (preserves prior behavior: prices pull whenever sync is enabled).
    #[serde(default = "default_true")]
    pub price_pull_enabled: bool,
}

fn default_true() -> bool {
    true
}
fn default_retry_interval_secs() -> u64 {
    30
}
fn default_batch_size() -> usize {
    100
}
fn default_max_retries() -> u32 {
    10
}
fn default_price_pull_interval_hours() -> u64 {
    12
}

// ── Shift configuration (SHIFT_MANAGEMENT.md) ─────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ShiftConfig {
    pub mode: ShiftMode,
    #[serde(default)]
    pub scheduled: Vec<ScheduledShift>,
    #[serde(default)]
    pub require_operator_pin: bool,
    #[serde(default = "default_warn_before_end")]
    pub warn_before_end_minutes: u32,
    #[serde(default = "default_allow_overlap")]
    pub allow_overlap_minutes: u32,
    #[serde(default)]
    pub auto_close_on_restart: bool,
}

fn default_warn_before_end() -> u32 {
    15
}
fn default_allow_overlap() -> u32 {
    30
}

impl Default for ShiftConfig {
    fn default() -> Self {
        Self {
            mode: ShiftMode::Disabled,
            scheduled: vec![],
            require_operator_pin: false,
            warn_before_end_minutes: 15,
            allow_overlap_minutes: 30,
            auto_close_on_restart: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShiftMode {
    Disabled,
    Manual,
    Scheduled,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ScheduledShift {
    pub name: String,
    pub start: String,
    pub end: String,
}

impl ScheduledShift {
    pub fn parse_time(s: &str) -> Option<(u32, u32)> {
        let parts: Vec<&str> = s.split(':').collect();
        if parts.len() != 2 {
            return None;
        }
        let h: u32 = parts[0].parse().ok()?;
        let m: u32 = parts[1].parse().ok()?;
        if h > 23 || m > 59 {
            return None;
        }
        Some((h, m))
    }

    pub fn start_minutes(&self) -> Option<u32> {
        let (h, m) = Self::parse_time(&self.start)?;
        Some(h * 60 + m)
    }

    pub fn end_minutes(&self) -> Option<u32> {
        let (h, m) = Self::parse_time(&self.end)?;
        Some(h * 60 + m)
    }
}

impl ShiftConfig {
    pub fn current_slot(&self, minutes_since_midnight: u32) -> Option<&ScheduledShift> {
        for slot in &self.scheduled {
            let start = slot.start_minutes()?;
            let end = slot.end_minutes()?;
            if start < end {
                if minutes_since_midnight >= start && minutes_since_midnight < end {
                    return Some(slot);
                }
            } else if minutes_since_midnight >= start || minutes_since_midnight < end {
                return Some(slot);
            }
        }
        None
    }

    pub fn minutes_until_slot_end(&self, minutes_since_midnight: u32) -> Option<u32> {
        let slot = self.current_slot(minutes_since_midnight)?;
        let end = slot.end_minutes()?;
        let start = slot.start_minutes()?;
        if start < end {
            if end > minutes_since_midnight {
                Some(end - minutes_since_midnight)
            } else {
                None
            }
        } else if minutes_since_midnight >= start {
            Some(1440 - minutes_since_midnight + end)
        } else if minutes_since_midnight < end {
            Some(end - minutes_since_midnight)
        } else {
            None
        }
    }
}

// ── ATG (Automatic Tank Gauge) configuration ──────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct AtgConfig {
    /// How often to poll all branches in seconds. Default: 300 (5 min).
    #[serde(default = "default_atg_poll_interval")]
    pub poll_interval_secs: u64,
    /// Modbus TCP connect + read timeout in seconds. Default: 10.
    #[serde(default = "default_atg_modbus_timeout")]
    pub modbus_timeout_secs: f64,
    /// POST target, e.g. "https://ps.ung.uz/api/integration/fuel-levels".
    #[serde(default)]
    pub api_url: String,
    #[serde(default)]
    pub auth: Option<AtgAuth>,
    #[serde(default)]
    pub branches: Vec<AtgBranch>,
}

fn default_atg_poll_interval() -> u64 {
    300
}
fn default_atg_modbus_timeout() -> f64 {
    10.0
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AtgAuth {
    /// Static Bearer token — takes priority over username/password login.
    #[serde(default)]
    pub api_token: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// Login endpoint. Derived from api_url if empty.
    #[serde(default)]
    pub login_url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AtgBranch {
    /// Integer used as `ayoqshMdmId` in the integration payload.
    pub id: u32,
    #[serde(default)]
    pub name: String,
    pub host: String,
    #[serde(default = "default_atg_port")]
    pub port: u16,
    #[serde(default = "default_atg_unit_id")]
    pub unit_id: u8,
    /// ModScan-style register address of the first register (e.g. 1000).
    #[serde(default = "default_atg_start_register")]
    pub start_register: u16,
    /// Offset used to convert start_register to a 0-based PDU address (usually 1).
    #[serde(default = "default_atg_address_base")]
    pub address_base: u16,
    /// Number of 16-bit registers to read. Must be a multiple of 12 (12 per slot, max 48).
    #[serde(default = "default_atg_register_count")]
    pub register_count: u16,
    pub slots: Vec<AtgSlot>,
}

fn default_atg_port() -> u16 {
    502
}
fn default_atg_unit_id() -> u8 {
    1
}
fn default_atg_start_register() -> u16 {
    1000
}
fn default_atg_address_base() -> u16 {
    1
}
fn default_atg_register_count() -> u16 {
    12
}

impl AtgBranch {
    /// 0-based PDU register address for the Modbus request.
    pub fn pdu_address(&self) -> u16 {
        self.start_register.saturating_sub(self.address_base)
    }
    /// Number of IEEE float32 values decoded from the register block.
    pub fn float_count(&self) -> usize {
        (self.register_count / 2) as usize
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AtgSlot {
    /// 1-based tank slot number (1–4).
    pub slot: u8,
    /// Optional backend reservoir tankId. Defaults to product_id when omitted.
    #[serde(default)]
    pub tank_id: Option<String>,
    /// Fuel type label used in the integration payload, e.g. "AI-92".
    #[serde(rename = "type")]
    pub fuel_type: String,
    /// Links this ATG slot to a product in the site product catalog.
    /// When set, live Modbus readings update the matching tank display.
    #[serde(default)]
    pub product_id: Option<u8>,
    /// Human-readable label shown in the tank panel. Falls back to `fuel_type` when absent.
    #[serde(default)]
    pub label: Option<String>,
    /// Physical tank capacity in litres for the UI fill-percent calculation.
    /// If absent the value is taken from the matching TankConfig (by product_id) or maxima.product_volume.
    #[serde(default)]
    pub capacity_l: Option<f64>,
    /// Optional per-parameter capacity values for percent calculation in the integration POST.
    /// Key "product_volume" → max litres → emits `product_volume_percent`.
    #[serde(default)]
    pub maxima: HashMap<String, f64>,
}

impl SiteConfig {
    pub fn load(path: &str) -> Result<Self> {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("read site config {}", path))?;
        let cfg: Self =
            serde_json::from_str(&text).with_context(|| format!("parse site config {}", path))?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn save(&self, path: &str) -> Result<()> {
        self.validate()?;
        let text = serde_json::to_string_pretty(self).context("serialize site config")?;
        std::fs::write(path, text).with_context(|| format!("write site config {}", path))?;
        Ok(())
    }

    pub fn next_product_id(&self) -> u8 {
        self.products
            .iter()
            .map(|p| p.id)
            .max()
            .unwrap_or(0)
            .saturating_add(1)
    }

    /// Replace the global product list (validates uniqueness and non-empty names).
    pub fn replace_products(&mut self, products: Vec<ProductConfig>) -> Result<()> {
        self.products = products;
        self.validate_products()?;
        Ok(())
    }

    /// Remove a product if no nozzle references it.
    pub fn remove_product(&mut self, id: u8) -> Result<()> {
        let in_use = self
            .fueling_positions
            .iter()
            .any(|fp| fp.nozzles.iter().any(|n| n.product_id == id));
        if in_use {
            bail!("product {id} is assigned to a nozzle — remove assignments first");
        }
        let before = self.products.len();
        self.products.retain(|p| p.id != id);
        if self.products.len() == before {
            bail!("product {id} not found");
        }
        self.validate_products()?;
        Ok(())
    }

    pub fn set_position_nozzles(&mut self, fp_id: &str, nozzles: Vec<NozzleConfig>) -> Result<()> {
        let fp = self
            .fueling_positions
            .iter_mut()
            .find(|fp| fp.id == fp_id)
            .ok_or_else(|| anyhow::anyhow!("unknown fp_id {fp_id}"))?;
        fp.nozzles = nozzles;
        self.validate_positions()?;
        Ok(())
    }

    pub fn set_nozzle_price(&mut self, fp_id: &str, nozzle_index: u8, price: u32) -> Option<u32> {
        let fp = self
            .fueling_positions
            .iter_mut()
            .find(|fp| fp.id == fp_id)?;
        let n = fp.nozzles.iter_mut().find(|n| n.index == nozzle_index)?;
        let old = n.price;
        n.price = price;
        Some(old)
    }

    pub fn is_mock_serial(&self) -> bool {
        matches!(self.connection.protocol, Protocol::Mock)
            || self.connection.port.eq_ignore_ascii_case("MOCK")
    }

    pub fn active_positions(&self) -> Vec<&FuelingPositionConfig> {
        self.fueling_positions
            .iter()
            .filter(|fp| fp.active)
            .collect()
    }

    pub fn active_addresses(&self) -> Vec<u8> {
        self.active_positions()
            .iter()
            .map(|fp| fp.address_byte)
            .collect()
    }

    pub fn position_by_addr(&self, addr: u8) -> Option<&FuelingPositionConfig> {
        self.fueling_positions
            .iter()
            .find(|fp| fp.address_byte == addr && fp.active)
    }

    pub fn position_by_address(&self, byte: u8) -> Option<&FuelingPositionConfig> {
        self.fueling_positions
            .iter()
            .find(|p| p.address_byte == byte)
    }

    pub fn position_by_id(&self, id: &str) -> Option<&FuelingPositionConfig> {
        self.fueling_positions.iter().find(|fp| fp.id == id)
    }

    pub fn product(&self, id: u8) -> Option<&ProductConfig> {
        self.products.iter().find(|p| p.id == id)
    }

    pub fn price_for(&self, addr: u8, nozzle_index: u8) -> Option<u32> {
        self.position_by_addr(addr)?
            .nozzles
            .iter()
            .find(|n| n.index == nozzle_index && n.active)
            .map(|n| n.price)
    }

    pub fn product_name_for(&self, addr: u8, nozzle_index: u8) -> Option<String> {
        let pos = self.position_by_addr(addr)?;
        let nozzle = pos.nozzles.iter().find(|n| n.index == nozzle_index)?;
        self.product(nozzle.product_id).map(|p| p.name.clone())
    }

    pub fn price_map(&self, addr: u8) -> HashMap<u8, u32> {
        self.position_by_addr(addr)
            .map(|fp| {
                fp.nozzles
                    .iter()
                    .filter(|n| n.active)
                    .map(|n| (n.index, n.price))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn validate(&self) -> Result<()> {
        self.validate_connection()?;
        self.validate_products()?;
        self.validate_positions()?;
        self.validate_tanks()?;
        self.validate_atg()?;
        self.validate_shifts()?;
        Ok(())
    }

    fn validate_connection(&self) -> Result<()> {
        if self.connection.port.is_empty() {
            bail!("connection.port cannot be empty");
        }
        if self.connection.baud_rate == 0 {
            bail!("connection.baud_rate cannot be 0");
        }
        if self.connection.response_timeout_ms == 0 {
            bail!("connection.response_timeout_ms cannot be 0");
        }
        if !(5..=8).contains(&self.connection.data_bits) {
            bail!("connection.data_bits must be 5..=8");
        }
        if self.connection.stop_bits != 1 && self.connection.stop_bits != 2 {
            bail!("connection.stop_bits must be 1 or 2");
        }
        Ok(())
    }

    fn validate_products(&self) -> Result<()> {
        if self.products.is_empty() {
            bail!("products list cannot be empty");
        }
        let mut ids = HashSet::new();
        for p in &self.products {
            if !ids.insert(p.id) {
                bail!("Duplicate product id: {}", p.id);
            }
            if p.name.is_empty() {
                bail!("Product id {} has empty name", p.id);
            }
        }
        Ok(())
    }

    fn validate_tanks(&self) -> Result<()> {
        let product_ids: HashSet<u8> = self.products.iter().map(|p| p.id).collect();
        let mut tank_products = HashSet::new();
        for t in &self.tanks {
            if !product_ids.contains(&t.product_id) {
                bail!(
                    "Tank '{}' references unknown product_id {}",
                    t.label,
                    t.product_id
                );
            }
            if !tank_products.insert(t.product_id) {
                bail!("Duplicate tank for product_id {}", t.product_id);
            }
            if t.label.trim().is_empty() {
                bail!("Tank for product_id {} has empty label", t.product_id);
            }
            if t.capacity_l <= 0.0 {
                bail!("Tank '{}' capacity_l must be > 0", t.label);
            }
            if t.current_l < 0.0 {
                bail!("Tank '{}' current_l cannot be negative", t.label);
            }
        }
        Ok(())
    }

    fn validate_atg(&self) -> Result<()> {
        let Some(atg) = &self.atg else {
            return Ok(());
        };
        if atg.poll_interval_secs == 0 {
            bail!("atg.poll_interval_secs must be > 0");
        }
        if atg.modbus_timeout_secs <= 0.0 {
            bail!("atg.modbus_timeout_secs must be > 0");
        }

        let product_ids: HashSet<u8> = self.products.iter().map(|p| p.id).collect();
        let tank_product_ids: HashSet<u8> = self.tanks.iter().map(|t| t.product_id).collect();
        let mut branch_ids = HashSet::new();

        for branch in &atg.branches {
            if !branch_ids.insert(branch.id) {
                bail!("Duplicate ATG branch id {}", branch.id);
            }
            if branch.host.trim().is_empty() {
                bail!("ATG branch {} has empty host", branch.id);
            }
            if branch.register_count < 12
                || branch.register_count > 48
                || branch.register_count % 12 != 0
            {
                bail!(
                    "ATG branch {} register_count must be 12, 24, 36, or 48",
                    branch.id
                );
            }
            if branch.slots.is_empty() {
                bail!("ATG branch {} must define at least one slot", branch.id);
            }

            let mut slots = HashSet::new();
            for slot in &branch.slots {
                if !(1..=4).contains(&slot.slot) {
                    bail!(
                        "ATG branch {} slot must be 1..=4, got {}",
                        branch.id,
                        slot.slot
                    );
                }
                if !slots.insert(slot.slot) {
                    bail!("ATG branch {} has duplicate slot {}", branch.id, slot.slot);
                }
                if slot.slot as u16 * 12 > branch.register_count {
                    bail!(
                        "ATG branch {} slot {} is outside register_count {}",
                        branch.id,
                        slot.slot,
                        branch.register_count
                    );
                }
                if slot.fuel_type.trim().is_empty() {
                    bail!("ATG branch {} slot {} has empty type", branch.id, slot.slot);
                }
                if matches!(slot.tank_id.as_deref(), Some(tank_id) if tank_id.trim().is_empty()) {
                    bail!(
                        "ATG branch {} slot {} has empty tank_id",
                        branch.id,
                        slot.slot
                    );
                }
                if let Some(pid) = slot.product_id {
                    if !product_ids.contains(&pid) {
                        bail!(
                            "ATG branch {} slot {} references unknown product_id {}",
                            branch.id,
                            slot.slot,
                            pid
                        );
                    }
                    if !tank_product_ids.contains(&pid) {
                        bail!(
                            "ATG branch {} slot {} product_id {} has no matching tanks[] entry",
                            branch.id,
                            slot.slot,
                            pid
                        );
                    }
                }
                if matches!(slot.label.as_deref(), Some(label) if label.trim().is_empty()) {
                    bail!(
                        "ATG branch {} slot {} has empty label",
                        branch.id,
                        slot.slot
                    );
                }
                if matches!(slot.capacity_l, Some(capacity) if capacity <= 0.0) {
                    bail!(
                        "ATG branch {} slot {} capacity_l must be > 0",
                        branch.id,
                        slot.slot
                    );
                }
                for (key, value) in &slot.maxima {
                    if key.trim().is_empty() {
                        bail!(
                            "ATG branch {} slot {} has empty maxima key",
                            branch.id,
                            slot.slot
                        );
                    }
                    if *value <= 0.0 {
                        bail!(
                            "ATG branch {} slot {} maxima.{} must be > 0",
                            branch.id,
                            slot.slot,
                            key
                        );
                    }
                }
            }
        }
        Ok(())
    }

    fn validate_positions(&self) -> Result<()> {
        if self.fueling_positions.is_empty() {
            bail!("fueling_positions cannot be empty");
        }

        let product_ids: HashSet<u8> = self.products.iter().map(|p| p.id).collect();
        let mut addr_bytes = HashSet::new();
        let mut fp_ids = HashSet::new();

        for fp in &self.fueling_positions {
            if !fp_ids.insert(&fp.id) {
                bail!("Duplicate fueling position id: '{}'", fp.id);
            }
            if fp.id.is_empty() {
                bail!("Fueling position has empty id");
            }
            if fp.label.is_empty() {
                bail!("Fueling position '{}' has empty label", fp.id);
            }

            if fp.active {
                if !addr_bytes.insert(fp.address_byte) {
                    bail!(
                        "Duplicate address_byte {} in fueling position '{}'",
                        fp.address_byte,
                        fp.id
                    );
                }
            }

            if fp.active && fp.nozzles.is_empty() {
                bail!("Fueling position '{}' is active but has no nozzles", fp.id);
            }

            let mut nozzle_indices = HashSet::new();
            for nozzle in &fp.nozzles {
                if !nozzle_indices.insert(nozzle.index) {
                    bail!(
                        "Duplicate nozzle index {} in position '{}'",
                        nozzle.index,
                        fp.id
                    );
                }
                if nozzle.index == 0 {
                    bail!(
                        "Nozzle index cannot be 0 in position '{}' (use 1-based indexing)",
                        fp.id
                    );
                }
                if !product_ids.contains(&nozzle.product_id) {
                    bail!(
                        "Nozzle {} in position '{}' references unknown product_id {}",
                        nozzle.index,
                        fp.id,
                        nozzle.product_id
                    );
                }
                if nozzle.active && nozzle.price == 0 {
                    bail!(
                        "Nozzle {} in position '{}' is active but has price = 0",
                        nozzle.index,
                        fp.id
                    );
                }
            }
        }
        Ok(())
    }

    fn validate_shifts(&self) -> Result<()> {
        if self.shifts.mode == ShiftMode::Scheduled {
            if self.shifts.scheduled.is_empty() {
                bail!("shifts.mode is 'scheduled' but shifts.scheduled is empty");
            }
            for slot in &self.shifts.scheduled {
                if slot.name.is_empty() {
                    bail!("Scheduled shift has empty name");
                }
                if ScheduledShift::parse_time(&slot.start).is_none() {
                    bail!(
                        "Scheduled shift '{}' has invalid start time '{}'",
                        slot.name,
                        slot.start
                    );
                }
                if ScheduledShift::parse_time(&slot.end).is_none() {
                    bail!(
                        "Scheduled shift '{}' has invalid end time '{}'",
                        slot.name,
                        slot.end
                    );
                }
            }
        }
        Ok(())
    }
}

impl FuelingPositionConfig {
    pub fn active_nozzles(&self) -> Vec<&NozzleConfig> {
        self.nozzles.iter().filter(|n| n.active).collect()
    }

    pub fn nozzle_count(&self) -> usize {
        self.active_nozzles().len()
    }

    pub fn default_price(&self) -> Option<u32> {
        self.active_nozzles().first().map(|n| n.price)
    }

    pub fn default_product_id(&self) -> Option<u8> {
        self.active_nozzles().first().map(|n| n.product_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> SiteConfig {
        serde_json::from_str(
            r##"{
            "site": { "id": "test", "name": "Test", "timezone": "UTC" },
            "service": {
                "port": 3001, "log_level": "info",
                "log_file": "test.log", "db_path": "test.db"
            },
            "connection": {
                "protocol": "wayne_europump",
                "port": "COM3", "baud_rate": 9600,
                "parity": "odd", "data_bits": 8,
                "stop_bits": 1, "response_timeout_ms": 300
            },
            "polling": {
                "interval_ms": 140,
                "offline_threshold_polls": 32,
                "reconnect_settle_rounds": 3
            },
            "products": [
                { "id": 3, "name": "AI-92", "color": "#2196F3", "unit": "litre" },
                { "id": 4, "name": "AI-95", "color": "#FF9800", "unit": "litre" }
            ],
            "fueling_positions": [
                {
                    "id": "FP1", "label": "Disp 1A",
                    "address_byte": 80, "active": true,
                    "nozzles": [
                        { "index": 1, "product_id": 3,
                          "price": 10500, "active": true }
                    ]
                },
                {
                    "id": "FP2", "label": "Disp 2A",
                    "address_byte": 82, "active": true,
                    "nozzles": [
                        { "index": 1, "product_id": 3,
                          "price": 10500, "active": true },
                        { "index": 2, "product_id": 4,
                          "price": 12000, "active": true }
                    ]
                }
            ],
            "sync": { "enabled": false, "backend_url": "", "api_key": "" }
        }"##,
        )
        .unwrap()
    }

    #[test]
    fn loads_and_validates() {
        let cfg = sample_config();
        assert_eq!(cfg.site.id, "test");
        assert_eq!(cfg.fueling_positions.len(), 2);
        cfg.validate().unwrap();
    }

    #[test]
    fn active_addresses() {
        let cfg = sample_config();
        let addrs = cfg.active_addresses();
        assert_eq!(addrs, vec![80, 82]);
    }

    #[test]
    fn price_lookup() {
        let cfg = sample_config();
        assert_eq!(cfg.price_for(80, 1), Some(10500));
        assert_eq!(cfg.price_for(82, 2), Some(12000));
        assert_eq!(cfg.price_for(82, 9), None);
        assert_eq!(cfg.price_for(99, 1), None);
    }

    #[test]
    fn product_name_lookup() {
        let cfg = sample_config();
        assert_eq!(cfg.product_name_for(82, 2), Some("AI-95".to_string()));
    }

    #[test]
    fn position_by_addr() {
        let cfg = sample_config();
        let fp = cfg.position_by_addr(82).unwrap();
        assert_eq!(fp.id, "FP2");
        assert_eq!(fp.nozzle_count(), 2);
    }

    #[test]
    fn rejects_duplicate_address() {
        let mut cfg = sample_config();
        cfg.fueling_positions[1].address_byte = 80;
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn rejects_unknown_product() {
        let mut cfg = sample_config();
        cfg.fueling_positions[0].nozzles[0].product_id = 99;
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn rejects_zero_price_on_active_nozzle() {
        let mut cfg = sample_config();
        cfg.fueling_positions[0].nozzles[0].price = 0;
        assert!(cfg.validate().is_err());
    }
}
