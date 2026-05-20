# AZS Manager — Code Agent Build Prompt

You are building **AZS Manager**, a desktop application for controlling fuel dispensers
at petrol stations. Read this entire document before writing any code.

---

## Project overview

**Company:** UNG (6 fuel stations in Tashkent, Uzbekistan)
**Goal:** Replace the existing proprietary Windows software with a custom app that
controls Wayne 3490D fuel dispensers, reads ATG reservoir probes, and logs all
transactions to a local database with optional sync to a central backend.

**Architecture decision:** Two separate programs per station PC:
1. `dispenser-service` — headless Rust binary, runs as a Windows service at boot,
   owns the serial port, polls dispensers, exposes a REST + WebSocket API on localhost.
2. `desktop` — Tauri v2 desktop app (Rust backend + React frontend), connects to the
   service API, shows the operator dashboard.

This separation means the service keeps running and logging even when the UI is closed.

---

## Technology stack

| Layer | Technology |
|---|---|
| Background service | Rust, tokio, axum, serialport, sqlx |
| Desktop shell | Tauri v2 |
| Desktop backend | Rust |
| Desktop frontend | React 18, TypeScript, Tailwind CSS |
| Database | SQLite via sqlx |
| Serialization | serde + serde_json |
| Logging | tracing + tracing-subscriber |
| Windows service | windows-service crate |
| Error handling | anyhow throughout |

---

## Workspace structure

```
azs-dispenser/
├── Cargo.toml                        ← workspace root
│
├── crates/
│   ├── config/                       ← SiteConfig loader + validator
│   │   ├── src/lib.rs
│   │   └── Cargo.toml
│   │
│   ├── types/                        ← shared API types (service + desktop)
│   │   ├── src/lib.rs
│   │   └── Cargo.toml
│   │
│   ├── protocol-trait/               ← ProtocolDriver trait definition
│   │   ├── src/lib.rs
│   │   └── Cargo.toml
│   │
│   └── wayne-europump/               ← Wayne/Europump protocol implementation
│       ├── src/
│       │   ├── lib.rs
│       │   ├── crc.rs
│       │   ├── frame.rs
│       │   ├── parser.rs
│       │   └── builder.rs
│       └── Cargo.toml
│
├── services/
│   └── dispenser-service/
│       ├── src/
│       │   ├── main.rs
│       │   ├── config.rs             ← load site.config.json
│       │   ├── engine/
│       │   │   ├── mod.rs
│       │   │   ├── serial.rs         ← open/read/write serial port
│       │   │   ├── state.rs          ← DispenserState + transitions
│       │   │   └── poll_loop.rs      ← 140ms tokio interval loop
│       │   ├── api/
│       │   │   ├── mod.rs
│       │   │   ├── routes.rs         ← REST endpoints
│       │   │   └── ws.rs             ← WebSocket broadcast hub
│       │   └── db/
│       │       ├── mod.rs
│       │       └── queries.rs        ← sqlx queries
│       ├── migrations/
│       │   └── 001_init.sql
│       ├── site.config.json          ← edit per station
│       └── Cargo.toml
│
└── apps/
    └── desktop/
        ├── src-tauri/                ← Tauri Rust backend
        │   ├── src/
        │   │   ├── main.rs
        │   │   ├── lib.rs
        │   │   ├── commands.rs       ← Tauri commands
        │   │   └── client.rs         ← HTTP client to dispenser-service
        │   ├── tauri.conf.json
        │   └── Cargo.toml
        ├── src/                      ← React frontend
        │   ├── App.tsx
        │   ├── main.tsx
        │   ├── components/
        │   │   ├── DispenserCard.tsx
        │   │   ├── TankGauge.tsx
        │   │   ├── AtgPanel.tsx
        │   │   ├── StatsPanel.tsx
        │   │   └── Header.tsx
        │   ├── hooks/
        │   │   ├── useDispenserState.ts
        │   │   └── useServiceEvents.ts
        │   └── types/
        │       └── api.ts            ← TypeScript mirror of Rust types
        ├── package.json
        ├── tailwind.config.js
        ├── tsconfig.json
        └── index.html

config/
├── wayne-template.json               ← copy to site.config.json for Wayne stations
├── gilbarco-template.json            ← copy for Gilbarco stations (future)
└── schema.json                       ← JSON schema for IDE validation
```

---

## Workspace Cargo.toml

```toml
[workspace]
members = [
    "crates/config",
    "crates/types",
    "crates/protocol-trait",
    "crates/wayne-europump",
    "services/dispenser-service",
    "apps/desktop/src-tauri",
]
resolver = "2"

[workspace.dependencies]
tokio       = { version = "1",   features = ["full"] }
serde       = { version = "1",   features = ["derive"] }
serde_json  = "1"
anyhow      = "1"
tracing     = "0.1"
axum        = { version = "0.7", features = ["ws"] }
sqlx        = { version = "0.7", features = ["runtime-tokio", "sqlite"] }
serialport  = "4"
uuid        = { version = "1",   features = ["v4", "serde"] }
chrono      = { version = "0.4", features = ["serde"] }
```

---

## Protocol specification — Wayne 3490D via ASIS PCC485

### Serial port settings
```
Baud rate:  9600
Parity:     Odd
Data bits:  8
Stop bits:  1
```

### CRC algorithm — CRITICAL, verified against 694 captured frames

```rust
// CRC16 with init=0 (NOT 0xFFFF), polynomial=0xA001
// Frame format: [...data bytes...][CRC_lo][CRC_hi][0x03][0xFA]

const fn build_crc_table() -> [u16; 256] {
    let mut table = [0u16; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut value = 0u16;
        let mut temp = i as u16;
        let mut j = 0;
        while j < 8 {
            if (value ^ temp) & 1 != 0 {
                value = (value >> 1) ^ 0xA001;
            } else {
                value >>= 1;
            }
            temp >>= 1;
            j += 1;
        }
        table[i] = value;
        i += 1;
    }
    table
}

static CRC_TABLE: [u16; 256] = build_crc_table();

pub fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0; // init = 0, NOT 0xFFFF
    for &byte in data {
        let index = ((crc as u8) ^ byte) as usize;
        crc = (crc >> 8) ^ CRC_TABLE[index];
    }
    crc
}

pub fn build_frame(data: &[u8]) -> Vec<u8> {
    let crc = crc16(data);
    let mut frame = data.to_vec();
    frame.push((crc & 0xFF) as u8);  // CK1 = low byte
    frame.push((crc >> 8) as u8);    // CK2 = high byte
    frame.push(0x03);
    frame.push(0xFA);
    frame
}
```

**Test vectors — must all pass:**
```
crc16(&[0x52, 0x30, 0x01, 0x01, 0x04]) = 0x5FE7  → frame ends: E7 5F 03 FA
crc16(&[0x52, 0x30, 0x01, 0x01, 0x08]) = 0x5AE7  → frame ends: E7 5A 03 FA
crc16(&[0x52, 0x30, 0x01, 0x01, 0x05]) = 0x9F26  → frame ends: 26 9F 03 FA
crc16(&[0x53, 0x30, 0x01, 0x01, 0x08]) = 0x9ADA  → frame ends: DA 9A 03 FA
crc16(&[0x50, 0x30, 0x01, 0x01, 0x08]) = 0x9A9E  → frame ends: 9E 9A 03 FA
crc16(&[0x51, 0x30, 0x01, 0x01, 0x08]) = 0x5AA3  → frame ends: A3 5A 03 FA
```

### Device addresses

| Label | Byte | Description |
|---|---|---|
| P0 | 0x50 | Dispenser 1 Side A |
| P1 | 0x51 | Dispenser 1 Side B |
| P2 | 0x52 | Dispenser 2 Side A |
| P3 | 0x53 | Dispenser 2 Side B |

Formula: `address_byte = 79 + nozzle_id` (nozzle_id 1..4 → 0x50..0x53)

### Frame types

#### Short frames (3 bytes, no CRC)
```
PC → DISP:   [addr] 20 FA    Status poll
DISP → PC:   [addr] 70 FA    Idle status
DISP → PC:   [addr] C0 FA    Authorized / delivering / acknowledge
PC → DISP:   [addr] C0 FA    Acknowledge data frame received
```

#### Command frames — built with build_frame()
```rust
// Poll (does NOT use CRC — special 3-byte frame)
fn poll(addr: u8) -> Vec<u8> {
    vec![addr, 0x20, 0xFA]
}

// BUSY keepalive — send during active delivery every 1-2 poll cycles
fn busy(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x30, 0x01, 0x01, 0x04])
}

// STOP — emergency stop, send to all addresses simultaneously
fn stop(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x30, 0x01, 0x01, 0x08])
}

// DONE — acknowledge transaction complete after nozzle replaced
fn done(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x30, 0x01, 0x01, 0x05])
}

// AUTHORIZE — initial auth with nozzle parameters
fn authorize_initial(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x30, 0x01, 0x01, 0x04, 0x01, 0x01, 0x05])
}
```

**Hardcoded STOP checksums per address (for emergency use):**
```rust
fn stop_frame(addr: u8) -> Vec<u8> {
    match addr {
        0x50 => vec![0x50, 0x30, 0x01, 0x01, 0x08, 0x9E, 0x9A, 0x03, 0xFA],
        0x51 => vec![0x51, 0x30, 0x01, 0x01, 0x08, 0xA3, 0x5A, 0x03, 0xFA],
        0x52 => vec![0x52, 0x30, 0x01, 0x01, 0x08, 0xE7, 0x5A, 0x03, 0xFA],
        0x53 => vec![0x53, 0x30, 0x01, 0x01, 0x08, 0xDA, 0x9A, 0x03, 0xFA],
        _ => unreachable!(),
    }
}
```

#### Data frame from dispenser — parse this for live volume/amount

```
DISP → PC:  [addr] [seq] 02 08 00 00 [V1][V2] 00 [A1][A2][A3] [CK1][CK2] 03 FA
                                                                                 ↑16 bytes total

addr    = dispenser address (0x50-0x53)
seq     = incrementing sequence counter (0x31-0x3F, wraps)
02 08   = fixed header bytes
00 00   = fixed zeros
V1 V2   = volume in BCD (e.g. 09 97 = 9.97 L, 10 00 = 10.00 L)
00      = separator
A1 A2 A3= amount in BCD × 100 sum (e.g. 10 46 85 = 1,046.85 sum × 100 = 104,685 sum)
CK1 CK2 = CRC16 over bytes[0..12] (first 12 bytes)
03 FA   = frame terminator
```

**Extended data frame (22 bytes) — same but with nozzle/product config appended:**
```
[addr][seq] 02 08 00 00 [V1][V2] 00 [A1][A2][A3] [extra config bytes] [CK1][CK2] 03 FA
CRC is computed over first 18 bytes only when extra config bytes present.
```

**Volume decoding:**
```rust
fn decode_volume(v1: u8, v2: u8) -> f64 {
    // BCD: each nibble is one decimal digit
    // 09 97 → "0997" → 9.97 L
    let digits = format!("{:02X}{:02X}", v1, v2);
    digits.parse::<f64>().unwrap_or(0.0) / 100.0
}
```

**Amount decoding:**
```rust
fn decode_amount(a1: u8, a2: u8, a3: u8) -> u64 {
    // BCD: 10 46 85 → "104685" → 104,685 sum
    let digits = format!("{:02X}{:02X}{:02X}", a1, a2, a3);
    digits.parse::<u64>().unwrap_or(0)
}
```

#### Special sequence frames
```
Nozzle lifted:        [addr] [seq] 03 04 01 [product] 00 [nozzle] [CK] 03 FA
Transaction complete: [addr] [seq] 01 01 05 [CK] 03 FA   ← nozzle replaced
Stopped state:        [addr] [seq] 01 01 01 [CK] 03 FA   ← after emergency stop
```

### Frame parser rules

1. Collect bytes until `03 FA` (2-byte terminator)
2. If first byte is not in range `0x50..=0x53`, it is a garbage byte from RS485
   bus turnaround — skip it and continue collecting
3. Minimum valid frame length: 3 bytes
4. Frames ending with `CK1 CK2 03 FA` verify CRC16 over bytes[0..len-4]
5. Short frames `[addr] 20 FA`, `[addr] 70 FA`, `[addr] C0 FA` have no CRC

### Complete transaction lifecycle

```
1. IDLE:     PC polls [addr] 20 FA → dispenser responds [addr] 70 FA

2. NOZZLE:   Dispenser sends nozzle-up frame:
             [addr] [seq] 03 04 01 [prod] 00 [nozzle] [CK] 03 FA

3. AUTH:     PC sends initial authorize:
             build_frame([addr, 0x30, 0x01, 0x01, 0x04, 0x01, 0x01, 0x05])
             Dispenser responds: [addr] C0 FA

4. CONFIG:   PC sends price configuration frame (twice):
             build_frame([addr, 0x30, 0x01, 0x01, 0x05, ...price+preset bytes...])
             Dispenser responds: [addr] C0 FA

5. DELIVER:  Every poll cycle (~140ms):
             PC: [addr] 20 FA
             DISP: [addr] [seq] 02 08 00 00 [V1][V2] 00 [A1][A2][A3] [CK] 03 FA
             PC: [addr] C0 FA  (acknowledge)
             PC: build_frame([addr, 0x30, 0x01, 0x01, 0x04])  (BUSY keepalive)
             DISP: [addr] C0 FA

6. COMPLETE: Nozzle replaced → dispenser sends:
             [addr] [seq] 01 01 05 [CK] 03 FA
             PC responds: build_frame([addr, 0x30, 0x01, 0x01, 0x05])  (DONE)
             DISP: [addr] C0 FA
             DISP: [addr] 70 FA  (back to idle)

7. ESTOP:    PC sends stop to ALL addresses simultaneously:
             stop_frame(0x50), stop_frame(0x51), stop_frame(0x52), stop_frame(0x53)
```

### Disconnect / reconnect behavior

- PC continues polling at same rate during disconnect (no backoff)
- After 32 consecutive missed polls (~5 seconds): mark dispenser OFFLINE
- On reconnect: dispensers may send data flush frames for 2-3 poll rounds
- Wait 3 full poll rounds after reconnect before trusting state
- No special reconnect handshake needed

---

## State machine

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DispenserStatus {
    Offline,
    Idle,
    NozzleUp,
    Authorizing,
    Delivering,
    Done,
    Stopped,
}

// Transitions:
// Offline → Idle (on first valid response)
// Idle → NozzleUp (on nozzle-up frame)
// NozzleUp → Authorizing (on PC send authorize command)
// Authorizing → Delivering (on first data frame with vol > 0)
// Delivering → Done (on transaction-complete frame)
// Done → Idle (after DONE ack sent)
// Any → Stopped (on STOP command)
// Stopped → Idle (after nozzle replaced)
// Any → Offline (after 32 missed polls)
```

---

## Site config file — site.config.json

```json
{
  "$schema": "../config/schema.json",
  "site": {
    "id":       "ung-001",
    "name":     "UNG Bostonliq",
    "timezone": "Asia/Tashkent"
  },
  "service": {
    "port":      3001,
    "log_level": "info",
    "log_file":  "service.log",
    "db_path":   "transactions.db"
  },
  "connection": {
    "protocol":  "wayne_europump",
    "port":      "COM3",
    "baud_rate": 9600,
    "parity":    "odd",
    "data_bits": 8,
    "stop_bits": 1
  },
  "polling": {
    "interval_ms":             140,
    "offline_threshold":        32,
    "reconnect_settle_rounds":   3,
    "response_timeout_ms":     300
  },
  "dispensers": [
    {
      "addr":   "P0",
      "byte":   80,
      "label":  "Dispenser 1 Side A",
      "active": true,
      "nozzles": [
        { "index": 1, "product_id": 5, "product_name": "AI-92", "price": 10500, "active": true }
      ]
    },
    {
      "addr":   "P1",
      "byte":   81,
      "label":  "Dispenser 1 Side B",
      "active": true,
      "nozzles": [
        { "index": 1, "product_id": 5, "product_name": "AI-92", "price": 10500, "active": true }
      ]
    },
    {
      "addr":   "P2",
      "byte":   82,
      "label":  "Dispenser 2 Side A",
      "active": true,
      "nozzles": [
        { "index": 1, "product_id": 5, "product_name": "AI-92", "price": 10500, "active": true },
        { "index": 2, "product_id": 3, "product_name": "AI-95", "price": 12000, "active": true }
      ]
    },
    {
      "addr":   "P3",
      "byte":   83,
      "label":  "Dispenser 2 Side B",
      "active": true,
      "nozzles": [
        { "index": 1, "product_id": 5, "product_name": "AI-92", "price": 10500, "active": true }
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

## Shared types — crates/types/src/lib.rs

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DispenserStatus {
    Offline, Idle, NozzleUp, Authorizing, Delivering, Done, Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispenserState {
    pub addr:         String,      // "P0"
    pub label:        String,      // "Dispenser 1 Side A"
    pub status:       DispenserStatus,
    pub volume:       f64,         // liters, 0.01 precision
    pub amount:       u64,         // sum
    pub price:        u32,         // sum per liter
    pub product:      Option<u8>,
    pub product_name: Option<String>,
    pub nozzle:       Option<u8>,
    pub seq:          u8,
    pub missed_polls: u32,
    pub updated_at:   i64,         // unix ms
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    pub id:           String,      // UUID v4
    pub addr:         String,
    pub label:        String,
    pub started_at:   i64,
    pub completed_at: Option<i64>,
    pub volume:       f64,
    pub amount:       u64,
    pub price:        u32,
    pub product_id:   u8,
    pub product_name: String,
    pub nozzle:       u8,
    pub status:       TxStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TxStatus { Completed, Aborted, Stopped }

// WebSocket events — service → desktop
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
pub enum WsEvent {
    #[serde(rename = "dispenser.status")]
    Status(DispenserState),

    #[serde(rename = "dispenser.nozzle_up")]
    NozzleUp { addr: String, product: u8, nozzle: u8 },

    #[serde(rename = "dispenser.done")]
    Done(Transaction),

    #[serde(rename = "dispenser.offline")]
    Offline { addr: String },

    #[serde(rename = "dispenser.online")]
    Online { addr: String },

    #[serde(rename = "service.connected")]
    Connected,
}

// REST request types
#[derive(Debug, Deserialize)]
pub struct AuthorizeCmd {
    pub addr:   String,
    pub price:  u32,
    pub preset: Preset,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Preset {
    Full,          // send "full" string
    Amount(u64),   // specific sum amount
}

#[derive(Debug, Deserialize)]
pub struct UpdatePricesCmd {
    /// Map of addr → price: { "P0": 10500, "P1": 10500 }
    pub prices: std::collections::HashMap<String, u32>,
}

#[derive(Debug, Deserialize)]
pub struct StopCmd {
    pub addr: String,
}
```

---

## REST API — dispenser-service

Base URL: `http://localhost:3001`

```
GET  /health
     → 200 { "status": "ok", "site": "ung-001", "uptime_s": 3600 }

GET  /status
     → 200 [DispenserState, ...]     (all dispensers)

GET  /status/:addr
     → 200 DispenserState

POST /authorize
     body: AuthorizeCmd
     → 200 { "ok": true }

POST /stop
     body: StopCmd
     → 200 { "ok": true }

POST /estop
     (no body — stops all dispensers simultaneously)
     → 200 { "ok": true }

POST /prices
     body: UpdatePricesCmd
     → 200 { "ok": true }

GET  /transactions?limit=50&offset=0&addr=P2
     → 200 [Transaction, ...]

GET  /transactions/:id
     → 200 Transaction
```

## WebSocket — dispenser-service

```
WS  /ws

All events are JSON: { "event": "dispenser.status", "data": {...} }
Event types: dispenser.status, dispenser.nozzle_up, dispenser.done,
             dispenser.offline, dispenser.online, service.connected

Client sends: ping frames to keep alive
Service sends: all WsEvent variants as text frames
```

---

## Database schema — migrations/001_init.sql

```sql
CREATE TABLE IF NOT EXISTS transactions (
    id           TEXT PRIMARY KEY,
    addr         TEXT NOT NULL,
    label        TEXT NOT NULL,
    started_at   INTEGER NOT NULL,
    completed_at INTEGER,
    volume       REAL NOT NULL DEFAULT 0.0,
    amount       INTEGER NOT NULL DEFAULT 0,
    price        INTEGER NOT NULL DEFAULT 0,
    product_id   INTEGER NOT NULL DEFAULT 0,
    product_name TEXT NOT NULL DEFAULT '',
    nozzle       INTEGER NOT NULL DEFAULT 1,
    status       TEXT NOT NULL DEFAULT 'COMPLETED'
);

CREATE INDEX idx_tx_addr       ON transactions(addr);
CREATE INDEX idx_tx_started    ON transactions(started_at);
CREATE INDEX idx_tx_status     ON transactions(status);

CREATE TABLE IF NOT EXISTS price_history (
    id         TEXT PRIMARY KEY,
    addr       TEXT NOT NULL,
    nozzle     INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    old_price  INTEGER NOT NULL,
    new_price  INTEGER NOT NULL,
    changed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    addr       TEXT,
    detail     TEXT,
    occurred_at INTEGER NOT NULL
);
```

---

## Poll loop implementation guidance

```rust
// Key design: one tokio task per serial port, isolated from API tasks
// All state behind Arc<RwLock<HashMap<u8, DispenserState>>>
// Events sent via tokio::sync::broadcast channel

pub async fn run_poll_loop(
    port:     Arc<tokio::sync::Mutex<Box<dyn serialport::SerialPort>>>,
    state:    Arc<tokio::sync::RwLock<HashMap<u8, DispenserState>>>,
    events:   tokio::sync::broadcast::Sender<WsEvent>,
    commands: tokio::sync::mpsc::Receiver<DispatchCommand>,
    config:   Arc<SiteConfig>,
) {
    let addrs: Vec<u8> = config.dispensers.iter()
        .filter(|d| d.active)
        .map(|d| d.byte)
        .collect();

    let mut interval = tokio::time::interval(
        Duration::from_millis(config.polling.interval_ms)
    );
    interval.set_missed_tick_behavior(
        tokio::time::MissedTickBehavior::Skip
    );

    loop {
        // drain pending commands before each poll round
        // (commands: Authorize, Stop, UpdatePrice)

        for &addr in &addrs {
            interval.tick().await;
            // 1. write poll frame to serial port
            // 2. read response with timeout
            // 3. update state machine
            // 4. emit WsEvent if state changed
            // 5. if DELIVERING: also send BUSY keepalive
        }
    }
}
```

---

## Tauri commands — apps/desktop/src-tauri/src/commands.rs

```rust
// All Tauri commands call dispenser-service via HTTP client
// The Rust backend in Tauri only does HTTP calls — no serial port access

#[tauri::command]
pub async fn get_all_status(client: State<'_, ServiceClient>)
    -> Result<Vec<DispenserState>, String>;

#[tauri::command]
pub async fn authorize(cmd: AuthorizeCmd, client: State<'_, ServiceClient>)
    -> Result<(), String>;

#[tauri::command]
pub async fn stop_dispenser(addr: String, client: State<'_, ServiceClient>)
    -> Result<(), String>;

#[tauri::command]
pub async fn emergency_stop_all(client: State<'_, ServiceClient>)
    -> Result<(), String>;

#[tauri::command]
pub async fn update_prices(cmd: UpdatePricesCmd, client: State<'_, ServiceClient>)
    -> Result<(), String>;

#[tauri::command]
pub async fn get_transactions(
    limit: Option<i64>,
    offset: Option<i64>,
    addr: Option<String>,
    client: State<'_, ServiceClient>
) -> Result<Vec<Transaction>, String>;

// WebSocket events forwarded to all frontend windows
// Set up in lib.rs using tauri::async_runtime::spawn
// Connect to ws://localhost:3001/ws
// Re-emit each message as Tauri event "dispenser_event"
```

---

## Frontend — React component structure

### App.tsx
```tsx
// Root layout:
// <Header />           site name, connection status, clock
// <Dashboard />        main content
//   <DispensersGrid /> 2×2 grid of DispenserCard
//   <RightPanel />     TankGauges + AtgPanel + StatsPanel
```

### DispenserCard.tsx props
```typescript
interface DispenserCardProps {
  state: DispenserState;
  onAuthorize: (addr: string, price: number, preset: 'full' | number) => void;
  onStop: (addr: string) => void;
  onEStop: () => void;
}
```

### UI layout (matches the approved mockup)
```
┌─ Header bar ──────────────────────────────────────────────────┐
│  AZS Manager    Bostonliq    ● Connected · COM3    14:32:07   │
├─ Dispensers (60%) ──────────┬─ Right panel (40%) ────────────┤
│  ┌─────────┐  ┌─────────┐  │  ┌─ Reservoirs ─────────────┐  │
│  │ P0 IDLE │  │P1 DELIV │  │  │  [gauge][gauge][gauge]   │  │
│  │  0.00L  │  │ 14.28L  │  │  │  AI-92  AI-95  Diesel    │  │
│  │  0 sum  │  │149,940  │  │  └──────────────────────────┘  │
│  └─────────┘  └─────────┘  │  ┌─ ATG probes ─────────────┐  │
│  ┌─────────┐  ┌─────────┐  │  │  Tank 1 · AI-92  15,600L │  │
│  │ P2 NOZ  │  │ P3 IDLE │  │  │  Tank 2 · AI-95   8,400L │  │
│  │  0.00L  │  │  0.00L  │  │  │  Tank 3 · Diesel 13,000L │  │
│  └─────────┘  └─────────┘  │  └──────────────────────────┘  │
│                             │  ┌─ Today ──────────────────┐  │
│                             │  │  47 tx  1,284L  13.5M    │  │
│                             │  └──────────────────────────┘  │
└─────────────────────────────┴────────────────────────────────┘
```

### Status colors (Tailwind)
```
IDLE:        border-gray-200    badge: gray
DELIVERING:  border-green-500   badge: green  (animated pulse)
NOZZLE_UP:   border-amber-500   badge: amber
STOPPED:     border-red-500     badge: red
OFFLINE:     border-red-300     opacity-60
```

### useServiceEvents hook
```typescript
// Connects to dispenser-service WebSocket via Tauri event forwarding
// listen('dispenser_event', callback)
// Dispatches to local React state (Zustand store)
```

---

## Build order — implement exactly in this sequence

### Phase 1 — Foundation (pure logic, no async)
1. Scaffold Cargo workspace with all Cargo.toml files
2. `crates/types` — all shared types, no dependencies
3. `crates/config` — SiteConfig struct + loader + validator
4. `crates/wayne-europump/src/crc.rs` — CRC16 + tests using test vectors above
5. `crates/wayne-europump/src/frame.rs` — Frame enum covering all frame types
6. `crates/wayne-europump/src/parser.rs` — bytes → Frame, handles garbage bytes
7. `crates/wayne-europump/src/builder.rs` — all build_frame calls (poll, busy, stop, auth, done)
8. Write unit tests for every frame builder using the hex values in this document

### Phase 2 — Service core
9. `services/dispenser-service/src/config.rs` — load site.config.json using crates/config
10. `services/dispenser-service/src/engine/serial.rs` — open serialport with settings from config
11. `services/dispenser-service/src/engine/state.rs` — DispenserState + all status transitions
12. `services/dispenser-service/src/engine/poll_loop.rs` — 140ms tokio interval, full poll cycle

### Phase 3 — Service API
13. `migrations/001_init.sql` + sqlx pool setup
14. `services/dispenser-service/src/db/queries.rs` — insert/query transactions
15. `services/dispenser-service/src/api/ws.rs` — broadcast hub
16. `services/dispenser-service/src/api/routes.rs` — all REST endpoints
17. `services/dispenser-service/src/main.rs` — wire everything together

### Phase 4 — Windows service wrapper
18. Add windows-service integration to main.rs
19. Add CLI args: install / uninstall / start / stop / run
20. Test as regular process first with `dispenser-service.exe run`

### Phase 5 — Desktop
21. `cargo tauri init` in apps/desktop
22. `apps/desktop/src-tauri/src/client.rs` — reqwest HTTP client to service
23. `apps/desktop/src-tauri/src/commands.rs` — all Tauri commands
24. WebSocket listener in lib.rs forwarding to Tauri events
25. React scaffold: Vite + React + TypeScript + Tailwind
26. `types/api.ts` — TypeScript mirror of Rust types
27. `hooks/useServiceEvents.ts` — WebSocket/Tauri event hook
28. `components/DispenserCard.tsx`
29. `components/TankGauge.tsx`
30. `components/AtgPanel.tsx`
31. `components/StatsPanel.tsx`
32. `App.tsx` — full layout wiring

---

## Important notes for implementation

1. **Serial port on Windows:** Use `serialport::new(port_name, baud_rate)` with
   `.parity(serialport::Parity::Odd)` — not Even, not None.

2. **Frame boundary detection:** Collect bytes until `[0x03, 0xFA]` appears as
   the last two bytes. A single `0xFA` byte inside a data frame is NOT a boundary.

3. **Garbage byte stripping:** First byte of every response MUST be in `0x50..=0x53`.
   If not, discard it silently and continue — this is an RS485 bus turnaround artifact.

4. **Tokio + serialport:** `serialport` is a blocking library. Use
   `tokio::task::spawn_blocking` for reads, or run the entire poll loop on a
   dedicated OS thread with `std::thread::spawn` + its own `tokio::runtime::Runtime`.

5. **Shared state:** `Arc<RwLock<HashMap<u8, DispenserState>>>` — write lock only
   during state updates, read lock for API handlers.

6. **Command injection:** Use `tokio::sync::mpsc::channel(16)` to send commands
   (Authorize, Stop, UpdatePrice) from API handlers into the poll loop task.

7. **Volume is BCD:** `0x09 0x97` means `"0997"` parsed as decimal = `9.97 L`.
   Do NOT treat as hex integer. Each nibble is one decimal digit.

8. **Amount is BCD:** `0x10 0x46 0x85` means `"104685"` = 104,685 sum.

9. **CRC init=0:** This is critical. Using `0xFFFF` as init will produce wrong
   checksums. The algorithm is EuropumpProtocol-style with `crc = 0` at start.

10. **Poll interval:** 140ms per dispenser × 4 dispensers = ~560ms per full round.
    Use `tokio::time::MissedTickBehavior::Skip` to avoid burst polling after delays.

---

## Development checklist

Before running against real hardware:
- [ ] All CRC test vectors pass
- [ ] Frame builder produces exact bytes shown in this document
- [ ] Config loads and validates without panic
- [ ] Service starts on configured COM port without error
- [ ] Poll loop sends `[addr] 20 FA` every 140ms per dispenser
- [ ] Dispenser responds with `[addr] 70 FA` (visible in service logs)
- [ ] State transitions log correctly
- [ ] REST `/status` returns all 4 dispensers
- [ ] WebSocket sends `dispenser.status` events
- [ ] Tauri desktop connects and shows live status

---

*End of build prompt. Start with Phase 1, Step 1: scaffold the Cargo workspace.*
