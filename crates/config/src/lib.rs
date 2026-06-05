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
    pub name: String,
    pub color: String,
    pub unit: String,
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
