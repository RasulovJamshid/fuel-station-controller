# AZS Manager — Universal Config System

This document replaces the `crates/config` section in the main build prompt.
Apply these changes before implementing the service, simulator, or desktop.

---

## Problem with the original config

The original config hardcoded assumptions:
- Always 4 dispensers named P0-P3
- Addresses always 0x50-0x53
- One nozzle per side
- Fixed product per dispenser

Real sites differ:
- 2 dispensers, 4 dispensers, 6 dispensers, or 8
- Addresses depend on ASIS PCC485 DIP switch configuration
- Some sides have 4 nozzles for 4 different products
- Gilbarco uses address bytes 1, 2, 3 (not 0x50+)
- Some sites have multi-hose dispensers (1 side, 4 hoses)
- Prices differ per nozzle, per product, per site

---

## Universal config design principles

1. No hardcoded address formulas — every byte comes from config
2. Product catalog is site-specific and reusable across positions
3. Each fueling position has its own nozzle list
4. Protocol-specific fields are nested inside `connection`
5. Config validates itself — bad values produce clear errors at startup
6. Same config format works for Wayne, Gilbarco, and future protocols

---

## File: site.config.json (universal format)

```json
{
  "$schema": "../config/schema.json",

  "site": {
    "id":       "ung-001",
    "name":     "UNG Bostonliq",
    "timezone": "Asia/Tashkent",
    "address":  "Tashkent, Yunusobod, Bostonliq ko'chasi 12"
  },

  "service": {
    "port":      3001,
    "log_level": "info",
    "log_file":  "service.log",
    "db_path":   "transactions.db"
  },

  "connection": {
    "protocol": "wayne_europump",
    "port":      "COM3",
    "baud_rate": 9600,
    "parity":    "odd",
    "data_bits": 8,
    "stop_bits": 1,
    "response_timeout_ms": 300
  },

  "polling": {
    "interval_ms":             140,
    "offline_threshold_polls":  32,
    "reconnect_settle_rounds":   3
  },

  "products": [
    { "id": 1, "name": "AI-80",   "color": "#9E9E9E", "unit": "litre" },
    { "id": 2, "name": "AI-91",   "color": "#4CAF50", "unit": "litre" },
    { "id": 3, "name": "AI-92",   "color": "#2196F3", "unit": "litre" },
    { "id": 4, "name": "AI-95",   "color": "#FF9800", "unit": "litre" },
    { "id": 5, "name": "AI-98",   "color": "#F44336", "unit": "litre" },
    { "id": 6, "name": "Diesel",  "color": "#795548", "unit": "litre" },
    { "id": 7, "name": "Diesel+", "color": "#607D8B", "unit": "litre" }
  ],

  "fueling_positions": [
    {
      "id":           "FP1",
      "label":        "Dispenser 1 Side A",
      "address_byte": 80,
      "active":       true,
      "nozzles": [
        {
          "index":      1,
          "product_id": 3,
          "price":      10500,
          "active":     true
        }
      ]
    },
    {
      "id":           "FP2",
      "label":        "Dispenser 1 Side B",
      "address_byte": 81,
      "active":       true,
      "nozzles": [
        {
          "index":      1,
          "product_id": 3,
          "price":      10500,
          "active":     true
        }
      ]
    },
    {
      "id":           "FP3",
      "label":        "Dispenser 2 Side A",
      "address_byte": 82,
      "active":       true,
      "nozzles": [
        {
          "index":      1,
          "product_id": 3,
          "price":      10500,
          "active":     true
        },
        {
          "index":      2,
          "product_id": 4,
          "price":      12000,
          "active":     true
        }
      ]
    },
    {
      "id":           "FP4",
      "label":        "Dispenser 2 Side B",
      "address_byte": 83,
      "active":       true,
      "nozzles": [
        {
          "index":      1,
          "product_id": 3,
          "price":      10500,
          "active":     true
        }
      ]
    }
  ],

  "sync": {
    "enabled":     false,
    "backend_url": "https://api.ung.uz",
    "api_key":     ""
  }
}
```

---

## Example: 3-dispenser Gilbarco site

```json
{
  "site": {
    "id":   "ung-sergeli",
    "name": "UNG Sergeli 2"
  },
  "connection": {
    "protocol":  "gilbarco",
    "port":      "COM5",
    "baud_rate": 9600,
    "parity":    "none",
    "data_bits": 8,
    "stop_bits": 1,
    "response_timeout_ms": 300
  },
  "polling": {
    "interval_ms": 200,
    "offline_threshold_polls": 25,
    "reconnect_settle_rounds": 3
  },
  "products": [
    { "id": 3, "name": "AI-92",  "color": "#2196F3", "unit": "litre" },
    { "id": 6, "name": "Diesel", "color": "#795548", "unit": "litre" }
  ],
  "fueling_positions": [
    {
      "id":           "FP1",
      "label":        "Gilbarco 1",
      "address_byte": 1,
      "active":       true,
      "nozzles": [
        { "index": 1, "product_id": 3, "price": 10500, "active": true },
        { "index": 2, "product_id": 6, "price": 9800,  "active": true }
      ]
    },
    {
      "id":           "FP2",
      "label":        "Gilbarco 2",
      "address_byte": 2,
      "active":       true,
      "nozzles": [
        { "index": 1, "product_id": 3, "price": 10500, "active": true }
      ]
    },
    {
      "id":           "FP3",
      "label":        "Gilbarco 3",
      "address_byte": 3,
      "active":       true,
      "nozzles": [
        { "index": 1, "product_id": 3, "price": 10500, "active": true }
      ]
    }
  ]
}
```

---

## Example: 8-position site (4 dispensers × 2 sides)

```json
{
  "fueling_positions": [
    { "id": "FP1", "label": "TRK 1 Side A", "address_byte": 80 },
    { "id": "FP2", "label": "TRK 1 Side B", "address_byte": 81 },
    { "id": "FP3", "label": "TRK 2 Side A", "address_byte": 82 },
    { "id": "FP4", "label": "TRK 2 Side B", "address_byte": 83 },
    { "id": "FP5", "label": "TRK 3 Side A", "address_byte": 84 },
    { "id": "FP6", "label": "TRK 3 Side B", "address_byte": 85 },
    { "id": "FP7", "label": "TRK 4 Side A", "address_byte": 86 },
    { "id": "FP8", "label": "TRK 4 Side B", "address_byte": 87 }
  ]
}
```

---

## Example: Multi-hose dispenser (1 side, 4 nozzles, 4 products)

```json
{
  "fueling_positions": [
    {
      "id":           "FP1",
      "label":        "Multi-hose Dispenser 1",
      "address_byte": 80,
      "active":       true,
      "nozzles": [
        { "index": 1, "product_id": 2, "price": 9500,  "active": true },
        { "index": 2, "product_id": 3, "price": 10500, "active": true },
        { "index": 3, "product_id": 4, "price": 12000, "active": true },
        { "index": 4, "product_id": 6, "price": 9800,  "active": true }
      ]
    }
  ]
}
```

---

## crates/config/src/lib.rs — Complete Rust implementation

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Top-level config ──────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SiteConfig {
    pub site:              SiteInfo,
    pub service:           ServiceConfig,
    pub connection:        ConnectionConfig,
    pub polling:           PollingConfig,
    pub products:          Vec<ProductConfig>,
    pub fueling_positions: Vec<FuelingPositionConfig>,
    pub sync:              SyncConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SiteInfo {
    pub id:       String,
    pub name:     String,
    pub timezone: String,
    pub address:  Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServiceConfig {
    pub port:      u16,
    pub log_level: String,
    pub log_file:  String,
    pub db_path:   String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionConfig {
    pub protocol:             Protocol,
    pub port:                 String,
    pub baud_rate:            u32,
    pub parity:               Parity,
    pub data_bits:            u8,
    pub stop_bits:            u8,
    pub response_timeout_ms:  u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    WayneEuropump,
    WayneDartV2,
    Gilbarco,
    // future: Mekser, Tokheim, ...
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Parity {
    None,
    Odd,
    Even,
}

impl Parity {
    pub fn to_serialport(&self) -> serialport::Parity {
        match self {
            Parity::None => serialport::Parity::None,
            Parity::Odd  => serialport::Parity::Odd,
            Parity::Even => serialport::Parity::Even,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PollingConfig {
    pub interval_ms:              u64,
    pub offline_threshold_polls:  u32,
    pub reconnect_settle_rounds:  u32,
}

// ── Product catalog ───────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProductConfig {
    pub id:    u8,
    pub name:  String,
    pub color: String,   // hex color for UI: "#2196F3"
    pub unit:  String,   // "litre", "kg", etc.
}

// ── Fueling positions ─────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct FuelingPositionConfig {
    pub id:           String,   // "FP1", "FP2" — unique identifier
    pub label:        String,   // human-readable: "Dispenser 1 Side A"
    pub address_byte: u8,       // raw address byte used by protocol
    pub active:       bool,
    pub nozzles:      Vec<NozzleConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NozzleConfig {
    pub index:      u8,     // nozzle number on this position (1-4)
    pub product_id: u8,     // reference to products[].id
    pub price:      u32,    // sum per litre (or other unit)
    pub active:     bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncConfig {
    pub enabled:     bool,
    pub backend_url: String,
    pub api_key:     String,
}

// ── Helper methods ────────────────────────────────────────────

impl SiteConfig {
    /// Load and validate config from file
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!(
                "Cannot read config file '{}': {}", path, e
            ))?;

        let cfg: Self = serde_json::from_str(&text)
            .map_err(|e| anyhow::anyhow!(
                "Invalid JSON in '{}': {}", path, e
            ))?;

        cfg.validate()?;
        Ok(cfg)
    }

    /// All active fueling positions
    pub fn active_positions(&self) -> Vec<&FuelingPositionConfig> {
        self.fueling_positions.iter()
            .filter(|fp| fp.active)
            .collect()
    }

    /// All active address bytes
    pub fn active_addresses(&self) -> Vec<u8> {
        self.active_positions().iter()
            .map(|fp| fp.address_byte)
            .collect()
    }

    /// Find position by address byte
    pub fn position_by_addr(&self, addr: u8) -> Option<&FuelingPositionConfig> {
        self.fueling_positions.iter()
            .find(|fp| fp.address_byte == addr && fp.active)
    }

    /// Find position by ID
    pub fn position_by_id(&self, id: &str) -> Option<&FuelingPositionConfig> {
        self.fueling_positions.iter()
            .find(|fp| fp.id == id)
    }

    /// Find product by ID
    pub fn product(&self, id: u8) -> Option<&ProductConfig> {
        self.products.iter().find(|p| p.id == id)
    }

    /// Price for a specific nozzle on a position
    pub fn price_for(&self, addr: u8, nozzle_index: u8) -> Option<u32> {
        self.position_by_addr(addr)?
            .nozzles.iter()
            .find(|n| n.index == nozzle_index && n.active)
            .map(|n| n.price)
    }

    /// Product name for a nozzle
    pub fn product_name_for(&self, addr: u8, nozzle_index: u8) -> Option<String> {
        let pos = self.position_by_addr(addr)?;
        let nozzle = pos.nozzles.iter()
            .find(|n| n.index == nozzle_index)?;
        self.product(nozzle.product_id)
            .map(|p| p.name.clone())
    }

    /// Build price map: nozzle_index → price for one position
    pub fn price_map(&self, addr: u8) -> HashMap<u8, u32> {
        self.position_by_addr(addr)
            .map(|fp| {
                fp.nozzles.iter()
                    .filter(|n| n.active)
                    .map(|n| (n.index, n.price))
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl FuelingPositionConfig {
    /// Active nozzles only
    pub fn active_nozzles(&self) -> Vec<&NozzleConfig> {
        self.nozzles.iter().filter(|n| n.active).collect()
    }

    /// Number of active nozzles
    pub fn nozzle_count(&self) -> usize {
        self.active_nozzles().len()
    }

    /// Default price (first active nozzle)
    pub fn default_price(&self) -> Option<u32> {
        self.active_nozzles().first().map(|n| n.price)
    }

    /// Default product id (first active nozzle)
    pub fn default_product_id(&self) -> Option<u8> {
        self.active_nozzles().first().map(|n| n.product_id)
    }
}

// ── Validation ────────────────────────────────────────────────

impl SiteConfig {
    fn validate(&self) -> anyhow::Result<()> {
        self.validate_connection()?;
        self.validate_products()?;
        self.validate_positions()?;
        Ok(())
    }

    fn validate_connection(&self) -> anyhow::Result<()> {
        if self.connection.port.is_empty() {
            anyhow::bail!("connection.port cannot be empty");
        }
        if self.connection.baud_rate == 0 {
            anyhow::bail!("connection.baud_rate cannot be 0");
        }
        if self.connection.response_timeout_ms == 0 {
            anyhow::bail!("connection.response_timeout_ms cannot be 0");
        }
        Ok(())
    }

    fn validate_products(&self) -> anyhow::Result<()> {
        if self.products.is_empty() {
            anyhow::bail!("products list cannot be empty");
        }
        let mut ids = std::collections::HashSet::new();
        for p in &self.products {
            if !ids.insert(p.id) {
                anyhow::bail!("Duplicate product id: {}", p.id);
            }
            if p.name.is_empty() {
                anyhow::bail!("Product id {} has empty name", p.id);
            }
        }
        Ok(())
    }

    fn validate_positions(&self) -> anyhow::Result<()> {
        if self.fueling_positions.is_empty() {
            anyhow::bail!("fueling_positions cannot be empty");
        }

        let product_ids: std::collections::HashSet<u8> =
            self.products.iter().map(|p| p.id).collect();
        let mut addr_bytes = std::collections::HashSet::new();
        let mut fp_ids = std::collections::HashSet::new();

        for fp in &self.fueling_positions {
            // unique IDs
            if !fp_ids.insert(&fp.id) {
                anyhow::bail!("Duplicate fueling position id: '{}'", fp.id);
            }
            if fp.id.is_empty() {
                anyhow::bail!("Fueling position has empty id");
            }
            if fp.label.is_empty() {
                anyhow::bail!("Fueling position '{}' has empty label", fp.id);
            }

            // unique address bytes (among active positions)
            if fp.active {
                if !addr_bytes.insert(fp.address_byte) {
                    anyhow::bail!(
                        "Duplicate address_byte {} in fueling position '{}'",
                        fp.address_byte, fp.id
                    );
                }
            }

            // nozzles
            if fp.active && fp.nozzles.is_empty() {
                anyhow::bail!(
                    "Fueling position '{}' is active but has no nozzles",
                    fp.id
                );
            }

            let mut nozzle_indices = std::collections::HashSet::new();
            for nozzle in &fp.nozzles {
                if !nozzle_indices.insert(nozzle.index) {
                    anyhow::bail!(
                        "Duplicate nozzle index {} in position '{}'",
                        nozzle.index, fp.id
                    );
                }
                if nozzle.index == 0 {
                    anyhow::bail!(
                        "Nozzle index cannot be 0 in position '{}' \
                         (use 1-based indexing)",
                        fp.id
                    );
                }
                if !product_ids.contains(&nozzle.product_id) {
                    anyhow::bail!(
                        "Nozzle {} in position '{}' references \
                         unknown product_id {}",
                        nozzle.index, fp.id, nozzle.product_id
                    );
                }
                if nozzle.active && nozzle.price == 0 {
                    anyhow::bail!(
                        "Nozzle {} in position '{}' is active \
                         but has price = 0",
                        nozzle.index, fp.id
                    );
                }
            }
        }
        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> SiteConfig {
        serde_json::from_str(r#"{
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
        }"#).unwrap()
    }

    #[test]
    fn loads_and_validates() {
        let cfg = sample_config();
        assert_eq!(cfg.site.id, "test");
        assert_eq!(cfg.fueling_positions.len(), 2);
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
        assert_eq!(cfg.price_for(82, 9), None);    // nonexistent nozzle
        assert_eq!(cfg.price_for(99, 1), None);    // nonexistent addr
    }

    #[test]
    fn product_name_lookup() {
        let cfg = sample_config();
        assert_eq!(
            cfg.product_name_for(82, 2),
            Some("AI-95".to_string())
        );
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
        cfg.fueling_positions[1].address_byte = 80; // duplicate!
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn rejects_unknown_product() {
        let mut cfg = sample_config();
        cfg.fueling_positions[0].nozzles[0].product_id = 99; // doesn't exist
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn rejects_zero_price_on_active_nozzle() {
        let mut cfg = sample_config();
        cfg.fueling_positions[0].nozzles[0].price = 0;
        assert!(cfg.validate().is_err());
    }
}
```

---

## Updated crates/types/src/lib.rs

Key change: replace `addr: String` ("P0") with `fp_id: String` ("FP1") everywhere,
and add `product_name` and `nozzle_count` to the state object so the UI knows
what to display without querying config separately.

```rust
use serde::{Deserialize, Serialize};

// ── Runtime state per fueling position ───────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FpStatus {
    Offline,
    Idle,
    NozzleUp,
    Authorizing,
    Delivering,
    Done,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FpState {
    // identity (from config)
    pub fp_id:        String,       // "FP1"
    pub label:        String,       // "Dispenser 1 Side A"
    pub address_byte: u8,           // 80 = 0x50

    // status
    pub status:       FpStatus,

    // active transaction data
    pub volume:       f64,          // litres dispensed (0.01 precision)
    pub amount:       u64,          // sum charged
    pub price:        u32,          // sum per litre of active nozzle

    // active nozzle info
    pub nozzle_index:   Option<u8>,
    pub product_id:     Option<u8>,
    pub product_name:   Option<String>,
    pub product_color:  Option<String>,

    // config snapshot (for UI — no config lookup needed)
    pub nozzle_count:   u8,

    // protocol
    pub seq:          u8,

    // health
    pub missed_polls: u32,
    pub updated_at:   i64,          // unix ms
}

// ── Transaction record ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    pub id:           String,       // UUID v4
    pub fp_id:        String,       // "FP1"
    pub label:        String,       // "Dispenser 1 Side A"
    pub address_byte: u8,
    pub started_at:   i64,
    pub completed_at: Option<i64>,
    pub volume:       f64,
    pub amount:       u64,
    pub price:        u32,
    pub nozzle_index: u8,
    pub product_id:   u8,
    pub product_name: String,
    pub status:       TxStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TxStatus { Completed, Aborted, Stopped }

// ── WebSocket events ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
pub enum WsEvent {
    #[serde(rename = "fp.status")]
    Status(FpState),

    #[serde(rename = "fp.nozzle_up")]
    NozzleUp {
        fp_id:        String,
        nozzle_index: u8,
        product_id:   u8,
        product_name: String,
        product_color: String,
        price:        u32,
    },

    #[serde(rename = "fp.done")]
    Done(Transaction),

    #[serde(rename = "fp.offline")]
    Offline { fp_id: String, label: String },

    #[serde(rename = "fp.online")]
    Online  { fp_id: String, label: String },

    #[serde(rename = "service.connected")]
    Connected {
        site_name:  String,
        fp_count:   usize,
        protocol:   String,
    },

    #[serde(rename = "service.price_updated")]
    PriceUpdated {
        fp_id:       String,
        nozzle_index: u8,
        old_price:   u32,
        new_price:   u32,
    },
}

// ── REST command types ────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct AuthorizeCmd {
    pub fp_id:        String,       // "FP1"
    pub nozzle_index: Option<u8>,   // None = first active nozzle
    pub preset:       Preset,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Preset {
    Full,           // use "full" string in JSON
    Amount(u64),    // specific sum amount
    Volume(f64),    // specific litre amount (future)
}

#[derive(Debug, Deserialize)]
pub struct StopCmd {
    pub fp_id: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePriceCmd {
    pub fp_id:        String,
    pub nozzle_index: u8,
    pub price:        u32,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAllPricesCmd {
    /// List of price updates — can cover multiple positions and nozzles
    pub updates: Vec<UpdatePriceCmd>,
}

// ── Config snapshot sent to desktop on connect ────────────────

/// Everything the desktop needs to render the UI — sent once at connect
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteSnapshot {
    pub site_id:   String,
    pub site_name: String,
    pub protocol:  String,
    pub positions: Vec<FpSnapshot>,
    pub products:  Vec<ProductSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FpSnapshot {
    pub fp_id:        String,
    pub label:        String,
    pub address_byte: u8,
    pub active:       bool,
    pub nozzles:      Vec<NozzleSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NozzleSnapshot {
    pub index:        u8,
    pub product_id:   u8,
    pub product_name: String,
    pub product_color: String,
    pub price:        u32,
    pub active:       bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductSnapshot {
    pub id:    u8,
    pub name:  String,
    pub color: String,
    pub unit:  String,
}
```

---

## Updated REST API — dispenser-service

```
GET  /health
     → 200 { "status": "ok", "site": "ung-001", "uptime_s": 3600 }

GET  /config
     → 200 SiteSnapshot   ← desktop calls this on startup to know topology

GET  /status
     → 200 [FpState, ...]   ← all active positions

GET  /status/:fp_id
     → 200 FpState          ← "FP1", "FP2", etc.

POST /authorize
     body: AuthorizeCmd { fp_id, nozzle_index?, preset }
     → 200 { "ok": true }

POST /stop
     body: StopCmd { fp_id }
     → 200 { "ok": true }

POST /estop
     → 200 { "ok": true }   ← stops all delivering positions

POST /prices
     body: UpdateAllPricesCmd { updates: [...] }
     → 200 { "ok": true, "updated": 2 }

GET  /transactions?limit=50&offset=0&fp_id=FP1&status=COMPLETED
     → 200 [Transaction, ...]

GET  /transactions/:id
     → 200 Transaction

GET  /products
     → 200 [ProductSnapshot, ...]
```

---

## What changes in the service (engine/poll_loop.rs)

Before (hardcoded):
```rust
let addrs = vec![0x50, 0x51, 0x52, 0x53];
```

After (config-driven):
```rust
let addrs: Vec<u8> = config.active_addresses();
// Works for 2, 4, 6, or 8 positions
// Works for Wayne (0x50+) or Gilbarco (1, 2, 3)
```

Before (hardcoded label):
```rust
format!("P{}", addr - 0x50)
```

After (config lookup):
```rust
config.position_by_addr(addr)
    .map(|fp| fp.label.clone())
    .unwrap_or_else(|| format!("0x{:02X}", addr))
```

---

## What changes in the desktop (React)

Before (hardcoded grid):
```tsx
<DispenserCard addr="P0" />
<DispenserCard addr="P1" />
<DispenserCard addr="P2" />
<DispenserCard addr="P3" />
```

After (config-driven dynamic render):
```tsx
// On startup: call GET /config → get SiteSnapshot
// Render one card per active position
const { positions } = useSiteConfig();

return (
    <div className={`grid grid-cols-${Math.min(positions.length, 4)}`}>
        {positions
            .filter(fp => fp.active)
            .map(fp => (
                <DispenserCard
                    key={fp.fp_id}
                    fpId={fp.fp_id}
                    label={fp.label}
                    nozzles={fp.nozzles}
                />
            ))
        }
    </div>
);
```

Grid columns scale automatically:
```
1-2 positions → grid-cols-2
3-4 positions → grid-cols-2 (2×2)
5-6 positions → grid-cols-3
7-8 positions → grid-cols-4
```

---

## What changes in the simulator (tools/simulators/wayne-sim)

The simulator reads `fueling_positions` from config — no changes to the
engine, only the initialization in main.rs:

```rust
// Before:
let dispensers = vec![
    SimDispenser::new(0x50, "P0", ...),
    SimDispenser::new(0x51, "P1", ...),
    SimDispenser::new(0x52, "P2", ...),
    SimDispenser::new(0x53, "P3", ...),
];

// After (reads from same site.config.json):
let dispensers: Vec<SimDispenser> = cfg
    .active_positions()
    .iter()
    .map(|fp| {
        let default_nozzle = fp.active_nozzles().first().unwrap();
        let product = cfg.product(default_nozzle.product_id).unwrap();
        SimDispenser::new(
            fp.address_byte,
            &fp.label,
            default_nozzle.product_id,
            &product.name,
            default_nozzle.price,
            1.2,  // fill rate from sim config
        )
    })
    .collect();
```

The simulator HTTP API now uses `fp_id` instead of hardcoded "P0-P3":
```bash
# Works for any topology:
curl -X POST http://localhost:3002/sim/nozzle-up \
     -d '{"fp_id":"FP3","nozzle_index":2}'

curl -X POST http://localhost:3002/sim/nozzle-down \
     -d '{"fp_id":"FP3"}'
```

---

## Config templates to ship with the app

```
config/
├── wayne-2fp.json        ← 1 dispenser, 2 sides, 1 product each
├── wayne-4fp.json        ← 2 dispensers, 4 sides (current Bostonliq)
├── wayne-4fp-multi.json  ← 2 dispensers, 4 sides, 2 products on some sides
├── wayne-8fp.json        ← 4 dispensers, 8 sides
├── gilbarco-3fp.json     ← 3 Gilbarco dispensers
├── gilbarco-6fp.json     ← 6 Gilbarco dispensers
└── schema.json           ← JSON schema for IDE validation
```

Operator installs service, copies closest template, edits:
- COM port
- Prices
- Active/inactive nozzles

Everything else works automatically.

---

## Schema validation (config/schema.json)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AZS Manager Site Config",
  "type": "object",
  "required": ["site","service","connection","polling",
               "products","fueling_positions","sync"],
  "properties": {
    "connection": {
      "type": "object",
      "required": ["protocol","port","baud_rate","parity"],
      "properties": {
        "protocol": {
          "type": "string",
          "enum": ["wayne_europump","wayne_dart_v2","gilbarco"]
        },
        "parity": {
          "type": "string",
          "enum": ["none","odd","even"]
        }
      }
    },
    "fueling_positions": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["id","label","address_byte","active","nozzles"],
        "properties": {
          "address_byte": { "type": "integer", "minimum": 0, "maximum": 255 },
          "nozzles": {
            "type": "array",
            "minItems": 1,
            "items": {
              "required": ["index","product_id","price","active"],
              "properties": {
                "index": { "type": "integer", "minimum": 1, "maximum": 4 },
                "price": { "type": "integer", "minimum": 0 }
              }
            }
          }
        }
      }
    }
  }
}
```

---

## Build checklist for config system

- [ ] `SiteConfig::load("wayne-4fp.json")` works without errors
- [ ] `SiteConfig::load("gilbarco-3fp.json")` works without errors
- [ ] Validation rejects duplicate address bytes
- [ ] Validation rejects unknown product_id references
- [ ] Validation rejects zero price on active nozzle
- [ ] `active_addresses()` returns only active positions
- [ ] `price_for(80, 1)` returns correct price
- [ ] `product_name_for(82, 2)` returns correct product name
- [ ] All unit tests pass: `cargo test -p azs-config`
- [ ] Service poll loop reads addresses from config (no hardcoded 0x50-0x53)
- [ ] Desktop renders N cards based on position count (not hardcoded 4)
- [ ] Simulator initializes dispensers from config positions

---

*Apply these changes to the main build prompt before implementing any service code.*
*The config crate must be fully tested before anything else is built.*
