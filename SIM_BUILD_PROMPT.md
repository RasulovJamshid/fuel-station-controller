# AZS Manager — Wayne Simulator Build Prompt

You are building **wayne-sim**, a software simulator that pretends to be
Wayne 3490D fuel dispensers connected via an ASIS PCC485 RS232 converter.
It enables full development and testing of the AZS Manager dispenser-service
and desktop app without any real hardware.

Read this entire document before writing any code.

---

## Context

This simulator is part of the **azs-dispenser** Cargo workspace.
The workspace already contains (or will contain):

```
azs-dispenser/
├── crates/
│   ├── config/              ← SiteConfig types
│   ├── types/               ← DispenserState, Transaction, WsEvent
│   ├── protocol-trait/      ← ProtocolDriver trait
│   └── wayne-europump/      ← CRC, frame parser, frame builder
├── services/
│   └── dispenser-service/   ← the service being tested
├── apps/
│   └── desktop/             ← Tauri desktop being tested
└── tools/
    └── simulators/
        └── wayne-sim/       ← THIS project
```

The simulator MUST reuse `crates/wayne-europump` for CRC and frame building.
Do NOT duplicate CRC or frame logic inside the simulator.

---

## What the simulator does

1. Opens one end of a virtual serial port pair (created externally with socat)
2. Simulates 4 Wayne dispenser sides (P0 0x50, P1 0x51, P2 0x52, P3 0x53)
3. Responds to every frame the dispenser-service sends
4. Has an HTTP control API so tests can trigger events (nozzle up, nozzle down,
   go offline, run scenario)
5. Reproduces every behavior observed in real captured logs

---

## Project structure

```
tools/simulators/wayne-sim/
├── src/
│   ├── main.rs           ← entry point, wires serial + API + engine
│   ├── config.rs         ← load sim.config.json
│   ├── dispenser.rs      ← SimDispenser state machine (one per address)
│   ├── engine.rs         ← serial read loop + frame dispatcher
│   ├── frames.rs         ← response frame builders (wraps wayne-europump)
│   ├── api.rs            ← axum HTTP control API on :3002
│   └── scenarios.rs      ← scripted test scenario runner
├── scenarios/
│   ├── normal_fill.json
│   ├── emergency_stop.json
│   ├── two_simultaneous.json
│   ├── ghost_fill.json
│   └── long_disconnect.json
├── sim.config.json
└── Cargo.toml
```

---

## Cargo.toml

```toml
[package]
name    = "wayne-sim"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "wayne-sim"
path = "src/main.rs"

[dependencies]
# workspace shared crates
azs-types          = { path = "../../../crates/types" }
azs-config         = { path = "../../../crates/config" }
wayne-europump     = { path = "../../../crates/wayne-europump" }

# async + web
tokio              = { workspace = true }
axum               = { workspace = true }
serde              = { workspace = true }
serde_json         = { workspace = true }
anyhow             = { workspace = true }
tracing            = { workspace = true }
tracing-subscriber = { workspace = true }

# serial port
serialport         = { workspace = true }

# time
chrono             = { workspace = true }
tokio-cron-scheduler = "0.10"
```

---

## sim.config.json

Place this file at `tools/simulators/wayne-sim/sim.config.json`.
The simulator loads it at startup.

```json
{
  "virtual_port": "/tmp/wayne-sim",
  "baud_rate":    9600,
  "parity":       "odd",
  "api_port":     3002,
  "log_frames":   true,
  "dispensers": [
    {
      "addr":         "P0",
      "byte":         80,
      "label":        "Dispenser 1 Side A",
      "product":      5,
      "product_name": "AI-92",
      "price":        10500,
      "fill_rate_lps": 1.2
    },
    {
      "addr":         "P1",
      "byte":         81,
      "label":        "Dispenser 1 Side B",
      "product":      5,
      "product_name": "AI-92",
      "price":        10500,
      "fill_rate_lps": 1.1
    },
    {
      "addr":         "P2",
      "byte":         82,
      "label":        "Dispenser 2 Side A",
      "product":      5,
      "product_name": "AI-92",
      "price":        10500,
      "fill_rate_lps": 1.3
    },
    {
      "addr":         "P3",
      "byte":         83,
      "label":        "Dispenser 2 Side B",
      "product":      5,
      "product_name": "AI-92",
      "price":        10500,
      "fill_rate_lps": 1.2
    }
  ]
}
```

---

## src/config.rs

```rust
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct SimConfig {
    pub virtual_port: String,       // "/tmp/wayne-sim" on Linux
    pub baud_rate:    u32,
    pub parity:       String,       // "odd"
    pub api_port:     u16,
    pub log_frames:   bool,
    pub dispensers:   Vec<SimDispenserConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SimDispenserConfig {
    pub addr:         String,       // "P0"
    pub byte:         u8,           // 0x50
    pub label:        String,
    pub product:      u8,
    pub product_name: String,
    pub price:        u32,
    pub fill_rate_lps: f64,
}

impl SimConfig {
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&text)?)
    }
}
```

---

## src/dispenser.rs — core state machine

This is the most important file. Implement it exactly as specified.

```rust
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};

/// All possible states of a simulated dispenser side
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SimStatus {
    Idle,
    NozzleUp,     // nozzle lifted, waiting for PC to authorize
    Authorized,   // PC sent authorize, waiting for config/fill start
    Delivering,   // actively dispensing, volume increasing
    Done,         // nozzle replaced, transaction complete, waiting for DONE ack
    Stopped,      // emergency stopped mid-fill
}

#[derive(Debug, Clone, Serialize)]
pub struct SimDispenser {
    pub addr:         u8,           // 0x50-0x53
    pub label:        String,
    pub status:       SimStatus,

    // product on nozzle
    pub product:      u8,
    pub product_name: String,
    pub nozzle:       u8,
    pub price:        u32,          // sum per liter

    // transaction data
    pub volume:       f64,          // liters dispensed so far (0.01 precision)
    pub amount:       u64,          // sum charged so far
    pub fill_rate:    f64,          // liters per second

    // protocol state
    pub seq:          u8,           // 0x31-0x3F rolling
    pub respond:      bool,         // false = simulate offline (no response)
    pub settle_rounds: u8,          // send data flush frames on reconnect

    // timing
    pub last_tick:    Option<Instant>,

    // default values (from config, reset on each transaction)
    pub default_product:      u8,
    pub default_product_name: String,
    pub default_price:        u32,
    pub default_fill_rate:    f64,
}

impl SimDispenser {
    pub fn new(
        addr: u8,
        label: &str,
        product: u8,
        product_name: &str,
        price: u32,
        fill_rate: f64,
    ) -> Self {
        Self {
            addr, label: label.to_string(),
            status: SimStatus::Idle,
            product, product_name: product_name.to_string(),
            nozzle: 1, price,
            volume: 0.0, amount: 0,
            fill_rate,
            seq: 0x31,
            respond: true,
            settle_rounds: 0,
            last_tick: None,
            default_product: product,
            default_product_name: product_name.to_string(),
            default_price: price,
            default_fill_rate: fill_rate,
        }
    }

    // ── Called by serial engine when poll frame arrives ──────

    /// Main entry point: PC sent a frame addressed to this dispenser.
    /// Returns the bytes to write back, or None if offline.
    pub fn handle_frame(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        if !self.respond {
            return None;
        }

        // drain reconnect flush frames first
        if self.settle_rounds > 0 {
            self.settle_rounds -= 1;
            return Some(self.data_frame_zeros());
        }

        // identify command type by byte[1]
        let cmd = if frame.len() >= 2 { frame[1] } else { 0x20 };

        match cmd {
            0x20 => self.handle_poll(),

            0x30 | 0x31 => {
                // parse params
                if frame.len() >= 5 {
                    self.handle_command(frame)
                } else {
                    Some(vec![self.addr, 0xC0, 0xFA])
                }
            }

            _ => Some(self.idle_or_status_frame()),
        }
    }

    fn handle_poll(&mut self) -> Option<Vec<u8>> {
        self.tick_volume();

        match &self.status {
            SimStatus::Idle =>
                Some(vec![self.addr, 0x70, 0xFA]),

            SimStatus::NozzleUp =>
                Some(self.nozzle_up_frame()),

            SimStatus::Authorized | SimStatus::Delivering =>
                Some(self.data_frame()),

            SimStatus::Done =>
                Some(self.done_frame()),

            SimStatus::Stopped =>
                Some(self.stopped_frame()),
        }
    }

    fn handle_command(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        // frame: [addr][0x30][0x01][0x01][cmd_byte][...]
        if frame.len() < 5 { return Some(vec![self.addr, 0xC0, 0xFA]); }

        let cmd_byte = frame[4];

        match cmd_byte {
            // AUTH initial — [addr] 30 01 01 04 01 01 05 [CK] 03 FA
            0x04 if frame.len() > 5 => {
                if self.status == SimStatus::NozzleUp {
                    self.status = SimStatus::Authorized;
                }
                Some(vec![self.addr, 0xC0, 0xFA])
            }

            // CONFIG — [addr] 30 01 01 05 [long config] [CK] 03 FA
            // Sent twice by PC — first time: move to Delivering
            0x05 if frame.len() > 8 => {
                if self.status == SimStatus::Authorized {
                    self.volume    = 0.0;
                    self.amount    = 0;
                    self.last_tick = Some(Instant::now());
                    self.status    = SimStatus::Delivering;
                } else if self.status == SimStatus::Done {
                    // DONE ack from PC
                    self.status = SimStatus::Idle;
                    self.volume = 0.0;
                    self.amount = 0;
                }
                Some(vec![self.addr, 0xC0, 0xFA])
            }

            // DONE ack — short form [addr] 30 01 01 05 [CK] 03 FA
            0x05 if frame.len() <= 8 => {
                if self.status == SimStatus::Done {
                    self.status = SimStatus::Idle;
                    self.volume = 0.0;
                    self.amount = 0;
                }
                Some(vec![self.addr, 0xC0, 0xFA])
            }

            // BUSY keepalive — [addr] 30 01 01 04 [CK] 03 FA
            0x04 => Some(vec![self.addr, 0xC0, 0xFA]),

            // STOP — [addr] 30 01 01 08 [CK] 03 FA
            0x08 => {
                if self.status == SimStatus::Delivering {
                    self.status = SimStatus::Stopped;
                }
                Some(vec![self.addr, 0xC1, 0xFA])
            }

            _ => Some(vec![self.addr, 0xC0, 0xFA]),
        }
    }

    fn idle_or_status_frame(&self) -> Vec<u8> {
        vec![self.addr, 0x70, 0xFA]
    }

    // ── Simulator control (called by HTTP API) ───────────────

    /// Operator lifts nozzle
    pub fn lift_nozzle(
        &mut self,
        product: Option<u8>,
        product_name: Option<String>,
        nozzle: Option<u8>,
        price: Option<u32>,
    ) -> anyhow::Result<()> {
        if self.status != SimStatus::Idle {
            anyhow::bail!("Dispenser {:02X} is not idle (current: {:?})",
                self.addr, self.status);
        }
        self.product      = product.unwrap_or(self.default_product);
        self.product_name = product_name.unwrap_or(self.default_product_name.clone());
        self.nozzle       = nozzle.unwrap_or(1);
        self.price        = price.unwrap_or(self.default_price);
        self.status       = SimStatus::NozzleUp;
        Ok(())
    }

    /// Operator replaces nozzle (complete transaction)
    pub fn replace_nozzle(&mut self) -> anyhow::Result<()> {
        if self.status != SimStatus::Delivering {
            anyhow::bail!("Dispenser {:02X} is not delivering", self.addr);
        }
        self.status = SimStatus::Done;
        Ok(())
    }

    /// Go offline — stop responding
    pub fn go_offline(&mut self) {
        self.respond = false;
    }

    /// Come back online
    pub fn go_online(&mut self, with_flush: bool) {
        self.respond = true;
        if with_flush {
            self.settle_rounds = 3; // send 3 data flush rounds like real hardware
        }
    }

    /// Reset to clean idle state
    pub fn reset(&mut self) {
        self.status      = SimStatus::Idle;
        self.volume      = 0.0;
        self.amount      = 0;
        self.respond     = true;
        self.settle_rounds = 0;
        self.last_tick   = None;
        self.product      = self.default_product;
        self.product_name = self.default_product_name.clone();
        self.price        = self.default_price;
    }

    // ── Volume ticker ────────────────────────────────────────

    fn tick_volume(&mut self) {
        if self.status != SimStatus::Delivering {
            self.last_tick = None;
            return;
        }
        let now = Instant::now();
        let elapsed = match self.last_tick {
            Some(t) => now.duration_since(t).as_secs_f64(),
            None    => { self.last_tick = Some(now); return; }
        };
        self.last_tick = Some(now);
        self.volume  += self.fill_rate * elapsed;
        self.volume   = (self.volume * 100.0).floor() / 100.0; // 0.01L precision
        self.amount   = (self.volume * self.price as f64).floor() as u64;
    }

    // ── Frame builders ───────────────────────────────────────

    fn next_seq(&mut self) -> u8 {
        let s = self.seq;
        self.seq = if self.seq >= 0x3F { 0x31 } else { self.seq + 1 };
        s
    }

    fn nozzle_up_frame(&mut self) -> Vec<u8> {
        let seq = self.next_seq();
        wayne_europump::builder::build_frame(&[
            self.addr, seq,
            0x03, 0x04, 0x01, self.product,
            0x00, self.nozzle,
        ])
    }

    fn data_frame(&mut self) -> Vec<u8> {
        let seq = self.next_seq();
        let v1_bcd = to_bcd_byte((self.volume as u32 / 100) % 100);
        let v2_bcd = to_bcd_byte((self.volume as u32) % 100);
        let a1_bcd = to_bcd_byte((self.amount / 10000) as u32 % 100);
        let a2_bcd = to_bcd_byte((self.amount / 100)   as u32 % 100);
        let a3_bcd = to_bcd_byte(self.amount            as u32 % 100);
        wayne_europump::builder::build_frame(&[
            self.addr, seq,
            0x02, 0x08, 0x00, 0x00,
            v1_bcd, v2_bcd, 0x00,
            a1_bcd, a2_bcd, a3_bcd,
        ])
    }

    fn data_frame_zeros(&mut self) -> Vec<u8> {
        let seq = self.next_seq();
        wayne_europump::builder::build_frame(&[
            self.addr, seq,
            0x02, 0x08, 0x00, 0x00,
            0x00, 0x00, 0x00,
            0x00, 0x00, 0x00,
        ])
    }

    fn done_frame(&mut self) -> Vec<u8> {
        let seq = self.next_seq();
        wayne_europump::builder::build_frame(&[
            self.addr, seq, 0x01, 0x01, 0x05,
        ])
    }

    fn stopped_frame(&mut self) -> Vec<u8> {
        let seq = self.next_seq();
        wayne_europump::builder::build_frame(&[
            self.addr, seq, 0x01, 0x01, 0x01,
        ])
    }
}

fn to_bcd_byte(v: u32) -> u8 {
    (((v / 10) << 4) | (v % 10)) as u8
}

// Shared state type used across all modules
pub type SharedDispensers = Arc<Mutex<Vec<SimDispenser>>>;
```

---

## src/engine.rs — serial read loop

```rust
use std::io::Read;
use crate::dispenser::{SharedDispensers};
use tracing::{info, warn, debug};

/// Spawn the serial read loop.
/// Reads incoming frames from dispenser-service, dispatches to SimDispenser,
/// writes response back.
pub fn spawn_serial_loop(
    port_name: String,
    baud:      u32,
    parity:    serialport::Parity,
    dispensers: SharedDispensers,
    log_frames: bool,
) {
    std::thread::spawn(move || {
        loop {
            info!("Opening virtual serial port: {}", port_name);

            let port_result = serialport::new(&port_name, baud)
                .parity(parity)
                .data_bits(serialport::DataBits::Eight)
                .stop_bits(serialport::StopBits::One)
                .timeout(std::time::Duration::from_millis(50))
                .open();

            let mut port = match port_result {
                Ok(p) => p,
                Err(e) => {
                    warn!("Cannot open port {}: {} — retrying in 2s", port_name, e);
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    continue;
                }
            };

            info!("Virtual port {} opened — simulator ready", port_name);

            let mut buf = Vec::with_capacity(64);

            loop {
                let mut byte = [0u8; 1];
                match port.read(&mut byte) {
                    Ok(1) => {
                        buf.push(byte[0]);
                        // frame complete when last 2 bytes are 03 FA
                        if buf.len() >= 3
                            && buf[buf.len() - 2] == 0x03
                            && buf[buf.len() - 1] == 0xFA
                        {
                            let frame = buf.clone();
                            buf.clear();

                            if log_frames {
                                debug!("RX: {}", hex_str(&frame));
                            }

                            // find which dispenser this is for
                            let addr = frame[0];
                            if addr < 0x50 || addr > 0x53 {
                                continue; // garbage byte — skip
                            }

                            let response = {
                                let mut disps = dispensers.lock().unwrap();
                                let d = disps.iter_mut()
                                    .find(|d| d.addr == addr);
                                match d {
                                    Some(d) => d.handle_frame(&frame),
                                    None => None,
                                }
                            };

                            if let Some(resp) = response {
                                if log_frames {
                                    debug!("TX: {}", hex_str(&resp));
                                }
                                if let Err(e) = port.write_all(&resp) {
                                    warn!("Serial write error: {}", e);
                                    break;
                                }
                            }
                        }

                        // safety: discard buffer if it gets too long
                        if buf.len() > 64 {
                            warn!("Buffer overflow — clearing");
                            buf.clear();
                        }
                    }
                    Ok(_) | Err(_) => {
                        // timeout or error — just continue
                    }
                }
            }

            warn!("Serial port lost — reconnecting in 1s");
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
}

fn hex_str(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02X}", x)).collect::<Vec<_>>().join(" ")
}
```

---

## src/api.rs — HTTP control interface

```rust
use axum::{
    Router, Json,
    routing::{get, post},
    extract::State,
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use crate::dispenser::{SharedDispensers, SimStatus};

pub fn router(dispensers: SharedDispensers) -> Router {
    Router::new()
        .route("/sim/state",        get(get_state))
        .route("/sim/nozzle-up",    post(nozzle_up))
        .route("/sim/nozzle-down",  post(nozzle_down))
        .route("/sim/go-offline",   post(go_offline))
        .route("/sim/go-online",    post(go_online))
        .route("/sim/estop",        post(estop_all))
        .route("/sim/reset",        post(reset_all))
        .route("/sim/scenario",     post(run_scenario))
        .with_state(dispensers)
}

// ── Request / Response types ─────────────────────────────────

#[derive(Deserialize)]
pub struct NozzleUpCmd {
    pub addr:         String,           // "P2"
    pub product:      Option<u8>,
    pub product_name: Option<String>,
    pub nozzle:       Option<u8>,
    pub price:        Option<u32>,
}

#[derive(Deserialize)]
pub struct AddrCmd {
    pub addr: String,
}

#[derive(Deserialize)]
pub struct OfflineCmd {
    pub addr:  String,
    pub flush: Option<bool>,            // true = send data flush on reconnect
}

#[derive(Deserialize)]
pub struct ScenarioCmd {
    pub name: String,
}

#[derive(Serialize)]
pub struct ApiResponse {
    pub ok:      bool,
    pub message: Option<String>,
}

#[derive(Serialize)]
pub struct DispenserInfo {
    pub addr:    String,
    pub label:   String,
    pub status:  String,
    pub volume:  f64,
    pub amount:  u64,
    pub respond: bool,
}

// ── Handlers ─────────────────────────────────────────────────

async fn get_state(
    State(disps): State<SharedDispensers>
) -> Json<Vec<DispenserInfo>> {
    let disps = disps.lock().unwrap();
    let info = disps.iter().map(|d| DispenserInfo {
        addr:    format!("P{}", d.addr - 0x50),
        label:   d.label.clone(),
        status:  format!("{:?}", d.status),
        volume:  d.volume,
        amount:  d.amount,
        respond: d.respond,
    }).collect();
    Json(info)
}

async fn nozzle_up(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<NozzleUpCmd>,
) -> (StatusCode, Json<ApiResponse>) {
    let byte = addr_to_byte(&cmd.addr);
    let mut disps = disps.lock().unwrap();
    match disps.iter_mut().find(|d| d.addr == byte) {
        None => (StatusCode::NOT_FOUND, Json(ApiResponse {
            ok: false, message: Some(format!("addr {} not found", cmd.addr))
        })),
        Some(d) => match d.lift_nozzle(
            cmd.product, cmd.product_name, cmd.nozzle, cmd.price
        ) {
            Ok(_)  => (StatusCode::OK, Json(ApiResponse { ok: true, message: None })),
            Err(e) => (StatusCode::CONFLICT, Json(ApiResponse {
                ok: false, message: Some(e.to_string())
            })),
        }
    }
}

async fn nozzle_down(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<AddrCmd>,
) -> (StatusCode, Json<ApiResponse>) {
    let byte = addr_to_byte(&cmd.addr);
    let mut disps = disps.lock().unwrap();
    match disps.iter_mut().find(|d| d.addr == byte) {
        None => (StatusCode::NOT_FOUND, Json(ApiResponse {
            ok: false, message: Some("addr not found".into())
        })),
        Some(d) => match d.replace_nozzle() {
            Ok(_)  => (StatusCode::OK, Json(ApiResponse { ok: true, message: None })),
            Err(e) => (StatusCode::CONFLICT, Json(ApiResponse {
                ok: false, message: Some(e.to_string())
            })),
        }
    }
}

async fn go_offline(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<OfflineCmd>,
) -> Json<ApiResponse> {
    let byte = addr_to_byte(&cmd.addr);
    let mut disps = disps.lock().unwrap();
    if let Some(d) = disps.iter_mut().find(|d| d.addr == byte) {
        d.go_offline();
    }
    Json(ApiResponse { ok: true, message: None })
}

async fn go_online(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<OfflineCmd>,
) -> Json<ApiResponse> {
    let byte = addr_to_byte(&cmd.addr);
    let flush = cmd.flush.unwrap_or(false);
    let mut disps = disps.lock().unwrap();
    if let Some(d) = disps.iter_mut().find(|d| d.addr == byte) {
        d.go_online(flush);
    }
    Json(ApiResponse { ok: true, message: None })
}

async fn estop_all(
    State(disps): State<SharedDispensers>,
) -> Json<ApiResponse> {
    let mut disps = disps.lock().unwrap();
    for d in disps.iter_mut() {
        if d.status == SimStatus::Delivering {
            d.status = crate::dispenser::SimStatus::Stopped;
        }
    }
    Json(ApiResponse { ok: true, message: None })
}

async fn reset_all(
    State(disps): State<SharedDispensers>,
) -> Json<ApiResponse> {
    let mut disps = disps.lock().unwrap();
    for d in disps.iter_mut() {
        d.reset();
    }
    Json(ApiResponse { ok: true, message: None })
}

async fn run_scenario(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<ScenarioCmd>,
) -> (StatusCode, Json<ApiResponse>) {
    let disps_clone = disps.clone();
    let name = cmd.name.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::scenarios::run(&name, disps_clone).await {
            tracing::error!("Scenario {} failed: {}", name, e);
        }
    });
    (StatusCode::OK, Json(ApiResponse {
        ok: true,
        message: Some(format!("Scenario '{}' started", cmd.name))
    }))
}

pub fn addr_to_byte(addr: &str) -> u8 {
    match addr {
        "P0" => 0x50, "P1" => 0x51,
        "P2" => 0x52, "P3" => 0x53,
        _    => 0x50,
    }
}
```

---

## src/scenarios.rs — scripted test sequences

```rust
use tokio::time::{sleep, Duration};
use crate::dispenser::SharedDispensers;

pub async fn run(name: &str, disps: SharedDispensers) -> anyhow::Result<()> {
    match name {
        "normal_fill"       => normal_fill(disps).await,
        "emergency_stop"    => emergency_stop(disps).await,
        "two_simultaneous"  => two_simultaneous(disps).await,
        "ghost_fill"        => ghost_fill(disps).await,
        "long_disconnect"   => long_disconnect(disps).await,
        "all_scenarios"     => all_scenarios(disps).await,
        _                   => anyhow::bail!("Unknown scenario: {}", name),
    }
}

/// Standard fill — P2 lifts nozzle, service authorizes, 15 seconds,
/// nozzle replaced, transaction completes
async fn normal_fill(disps: SharedDispensers) -> anyhow::Result<()> {
    tracing::info!("[scenario] normal_fill start");
    reset_all(&disps);

    // lift nozzle on P2
    {
        let mut d = disps.lock().unwrap();
        d.iter_mut().find(|x| x.addr == 0x52).unwrap()
            .lift_nozzle(None, None, None, None)?;
    }
    tracing::info!("[scenario] P2 nozzle up — waiting for service to authorize...");

    // wait for service to authorize and start delivery
    sleep(Duration::from_millis(2000)).await;

    // wait while fuel dispenses (~15 seconds = ~18L at 1.2 L/s)
    sleep(Duration::from_millis(15000)).await;

    // replace nozzle
    {
        let mut d = disps.lock().unwrap();
        if let Some(disp) = d.iter_mut().find(|x| x.addr == 0x52) {
            let _ = disp.replace_nozzle();
            tracing::info!("[scenario] P2 nozzle down — vol={:.2}L amt={}sum",
                disp.volume, disp.amount);
        }
    }

    sleep(Duration::from_millis(2000)).await;
    tracing::info!("[scenario] normal_fill complete");
    Ok(())
}

/// Stop mid-fill — P2 fills for 5 seconds then service stops it
async fn emergency_stop(disps: SharedDispensers) -> anyhow::Result<()> {
    tracing::info!("[scenario] emergency_stop start");
    reset_all(&disps);

    {
        let mut d = disps.lock().unwrap();
        d.iter_mut().find(|x| x.addr == 0x52).unwrap()
            .lift_nozzle(None, None, None, None)?;
    }

    // let service authorize
    sleep(Duration::from_millis(1500)).await;

    // deliver for 5 seconds
    sleep(Duration::from_millis(5000)).await;

    // trigger stop from simulator side (tests that service handles it)
    // Note: in real scenario the stop comes from the SERVICE not the sim
    // This scenario just verifies P2 is delivering at this point
    {
        let d = disps.lock().unwrap();
        let disp = d.iter().find(|x| x.addr == 0x52).unwrap();
        tracing::info!("[scenario] P2 delivering: vol={:.2}L — service should stop",
            disp.volume);
    }

    sleep(Duration::from_millis(3000)).await;
    tracing::info!("[scenario] emergency_stop complete");
    Ok(())
}

/// Two dispensers filling simultaneously
async fn two_simultaneous(disps: SharedDispensers) -> anyhow::Result<()> {
    tracing::info!("[scenario] two_simultaneous start");
    reset_all(&disps);

    {
        let mut d = disps.lock().unwrap();
        d.iter_mut().find(|x| x.addr == 0x51).unwrap()
            .lift_nozzle(None, None, None, None)?;
    }
    sleep(Duration::from_millis(200)).await;
    {
        let mut d = disps.lock().unwrap();
        d.iter_mut().find(|x| x.addr == 0x52).unwrap()
            .lift_nozzle(None, None, None, None)?;
    }

    tracing::info!("[scenario] P1 and P2 nozzles up");
    sleep(Duration::from_millis(20000)).await;

    {
        let mut d = disps.lock().unwrap();
        let _ = d.iter_mut().find(|x| x.addr == 0x51).unwrap().replace_nozzle();
    }
    sleep(Duration::from_millis(3000)).await;
    {
        let mut d = disps.lock().unwrap();
        let _ = d.iter_mut().find(|x| x.addr == 0x52).unwrap().replace_nozzle();
    }

    sleep(Duration::from_millis(3000)).await;
    tracing::info!("[scenario] two_simultaneous complete");
    Ok(())
}

/// Ghost fill — nozzle lifted and replaced immediately without fueling
async fn ghost_fill(disps: SharedDispensers) -> anyhow::Result<()> {
    tracing::info!("[scenario] ghost_fill start");
    reset_all(&disps);

    {
        let mut d = disps.lock().unwrap();
        d.iter_mut().find(|x| x.addr == 0x52).unwrap()
            .lift_nozzle(None, None, None, None)?;
    }
    tracing::info!("[scenario] P2 nozzle up");
    sleep(Duration::from_millis(500)).await;

    // replace immediately — no fuel dispensed
    {
        let mut d = disps.lock().unwrap();
        if let Some(disp) = d.iter_mut().find(|x| x.addr == 0x52) {
            // force back to idle without going through Delivering
            disp.status = crate::dispenser::SimStatus::Idle;
        }
    }
    tracing::info!("[scenario] P2 nozzle down immediately (ghost fill)");
    sleep(Duration::from_millis(2000)).await;
    tracing::info!("[scenario] ghost_fill complete");
    Ok(())
}

/// 133-second disconnect then reconnect with data flush
async fn long_disconnect(disps: SharedDispensers) -> anyhow::Result<()> {
    tracing::info!("[scenario] long_disconnect start — going offline");

    {
        let mut d = disps.lock().unwrap();
        for disp in d.iter_mut() { disp.go_offline(); }
    }

    // simulate 133 second disconnect
    tracing::info!("[scenario] all dispensers offline for 10s (shortened for testing)");
    sleep(Duration::from_millis(10000)).await;

    {
        let mut d = disps.lock().unwrap();
        for disp in d.iter_mut() { disp.go_online(true); }  // with flush frames
    }
    tracing::info!("[scenario] all dispensers online — sending data flush frames");
    sleep(Duration::from_millis(3000)).await;
    tracing::info!("[scenario] long_disconnect complete — service should be back to normal");
    Ok(())
}

/// Run all scenarios sequentially with 5s gap between each
async fn all_scenarios(disps: SharedDispensers) -> anyhow::Result<()> {
    normal_fill(disps.clone()).await?;
    sleep(Duration::from_millis(5000)).await;
    emergency_stop(disps.clone()).await?;
    sleep(Duration::from_millis(5000)).await;
    two_simultaneous(disps.clone()).await?;
    sleep(Duration::from_millis(5000)).await;
    ghost_fill(disps.clone()).await?;
    sleep(Duration::from_millis(5000)).await;
    long_disconnect(disps.clone()).await?;
    Ok(())
}

fn reset_all(disps: &SharedDispensers) {
    let mut d = disps.lock().unwrap();
    for disp in d.iter_mut() { disp.reset(); }
}
```

---

## src/main.rs

```rust
mod config;
mod dispenser;
mod engine;
mod api;
mod scenarios;

use std::sync::{Arc, Mutex};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // logging
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info"))
        )
        .init();

    // load config
    let cfg_path = std::env::args().nth(1)
        .unwrap_or_else(|| "sim.config.json".to_string());
    let cfg = config::SimConfig::load(&cfg_path)?;

    tracing::info!("Wayne Simulator starting");
    tracing::info!("Virtual port: {}", cfg.virtual_port);
    tracing::info!("API port:     {}", cfg.api_port);

    // create simulated dispensers
    let dispensers: dispenser::SharedDispensers = Arc::new(Mutex::new(
        cfg.dispensers.iter().map(|d| {
            let disp = dispenser::SimDispenser::new(
                d.byte, &d.label,
                d.product, &d.product_name,
                d.price, d.fill_rate_lps,
            );
            tracing::info!("  Dispenser {} ({}) ready", d.addr, d.label);
            disp
        }).collect()
    ));

    // parity
    let parity = match cfg.parity.as_str() {
        "odd"  => serialport::Parity::Odd,
        "even" => serialport::Parity::Even,
        _      => serialport::Parity::None,
    };

    // start serial engine on dedicated OS thread
    engine::spawn_serial_loop(
        cfg.virtual_port.clone(),
        cfg.baud_rate,
        parity,
        dispensers.clone(),
        cfg.log_frames,
    );

    // start HTTP API
    let app    = api::router(dispensers.clone());
    let addr   = format!("0.0.0.0:{}", cfg.api_port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("Control API listening on http://{}", addr);
    tracing::info!("Ready. Waiting for dispenser-service to connect...");

    axum::serve(listener, app).await?;
    Ok(())
}
```

---

## Scenario files (place in scenarios/ directory)

### scenarios/normal_fill.json
```json
{
  "name":        "normal_fill",
  "description": "Standard fill on P2 — lift nozzle, authorize, 15s fill, replace nozzle",
  "addr":        "P2",
  "duration_ms": 17000
}
```

### scenarios/emergency_stop.json
```json
{
  "name":        "emergency_stop",
  "description": "Fill starts on P2, service sends STOP at 5 seconds",
  "addr":        "P2",
  "duration_ms": 9000
}
```

### scenarios/two_simultaneous.json
```json
{
  "name":        "two_simultaneous",
  "description": "P1 and P2 fill at the same time",
  "addrs":       ["P1", "P2"],
  "duration_ms": 26000
}
```

### scenarios/ghost_fill.json
```json
{
  "name":        "ghost_fill",
  "description": "Nozzle lifted and replaced immediately, no fuel dispensed",
  "addr":        "P2",
  "duration_ms": 3000
}
```

### scenarios/long_disconnect.json
```json
{
  "name":        "long_disconnect",
  "description": "All dispensers go offline for 10s then reconnect with data flush",
  "duration_ms": 13000
}
```

---

## How to run the full test stack

### Step 1 — Create virtual serial port pair (one-time terminal)
```bash
socat -d -d \
    pty,raw,echo=0,link=/tmp/wayne-real \
    pty,raw,echo=0,link=/tmp/wayne-sim
```
Keep this terminal open. It creates two linked ports:
- dispenser-service connects to `/tmp/wayne-real`
- wayne-sim connects to `/tmp/wayne-sim`

### Step 2 — Start simulator
```bash
cargo run --bin wayne-sim -- tools/simulators/wayne-sim/sim.config.json
```

Expected output:
```
Wayne Simulator starting
Virtual port: /tmp/wayne-sim
API port:     3002
  Dispenser P0 (Dispenser 1 Side A) ready
  Dispenser P1 (Dispenser 1 Side B) ready
  Dispenser P2 (Dispenser 2 Side A) ready
  Dispenser P3 (Dispenser 2 Side B) ready
Control API listening on http://0.0.0.0:3002
Ready. Waiting for dispenser-service to connect...
```

### Step 3 — Start dispenser-service (with virtual port in config)
Edit `services/dispenser-service/site.config.json`:
```json
"connection": {
    "port": "/tmp/wayne-real",
    ...
}
```

```bash
cargo run --bin dispenser-service -- run
```

Expected output from service:
```
[wayne-service] Opened COM /tmp/wayne-real at 9600 8O1
[P0] POLL → 50 20 FA
[P0] IDLE ← 50 70 FA
[P1] POLL → 51 20 FA
[P1] IDLE ← 51 70 FA
...
```

### Step 4 — Control simulator via HTTP

```bash
# Check current state of all dispensers
curl http://localhost:3002/sim/state | jq

# Lift nozzle on P2
curl -X POST http://localhost:3002/sim/nozzle-up \
     -H "Content-Type: application/json" \
     -d '{"addr":"P2","price":10500}'

# Watch service logs show P2 changing to NOZZLE_UP, then DELIVERING
# Then replace nozzle to complete transaction
curl -X POST http://localhost:3002/sim/nozzle-down \
     -d '{"addr":"P2"}'

# Run emergency stop scenario
curl -X POST http://localhost:3002/sim/scenario \
     -d '{"name":"emergency_stop"}'

# Simulate P3 going offline
curl -X POST http://localhost:3002/sim/go-offline \
     -d '{"addr":"P3"}'

# Bring P3 back online (with data flush like real hardware)
curl -X POST http://localhost:3002/sim/go-online \
     -d '{"addr":"P3","flush":true}'

# Run ALL scenarios in sequence
curl -X POST http://localhost:3002/sim/scenario \
     -d '{"name":"all_scenarios"}'

# Reset everything to idle
curl -X POST http://localhost:3002/sim/reset
```

---

## Add to workspace Cargo.toml

```toml
[workspace]
members = [
    "crates/config",
    "crates/types",
    "crates/protocol-trait",
    "crates/wayne-europump",
    "services/dispenser-service",
    "apps/desktop/src-tauri",
    "tools/simulators/wayne-sim",    ← ADD THIS LINE
]
```

---

## Protocol accuracy notes

The simulator is built from real capture data (695 frames from actual Wayne 3490D
dispensers). Key behaviors that match real hardware:

| Behavior | Simulated |
|---|---|
| Poll: `[addr] 20 FA` → Idle: `[addr] 70 FA` | ✓ |
| Nozzle up frame with product/nozzle bytes | ✓ |
| Data frame with BCD volume + amount | ✓ |
| `C0 FA` ACK responses | ✓ |
| `C1 FA` after STOP commands | ✓ |
| Done frame `01 01 05` on nozzle replace | ✓ |
| Stopped frame `01 01 01` after STOP | ✓ |
| Data flush frames on long reconnect | ✓ |
| Garbage bytes skipped (0xFA in frame) | ✓ (parser handles it) |
| Sequence counter rolling 0x31-0x3F | ✓ |
| CRC16 init=0 on all frames | ✓ (via wayne-europump crate) |
| Fill rate realistic (~1.2 L/s = 72 L/min) | ✓ |
| Volume precision 0.01L (BCD centiliters) | ✓ |

---

## Build checklist

Before running against dispenser-service:
- [ ] `cargo build --bin wayne-sim` compiles without errors
- [ ] `socat` creates port pair at `/tmp/wayne-sim` and `/tmp/wayne-real`
- [ ] Simulator opens `/tmp/wayne-sim` successfully
- [ ] Service connects to `/tmp/wayne-real` successfully
- [ ] Service logs show `[P0..P3] IDLE` responses from simulator
- [ ] `GET /sim/state` returns 4 dispensers all IDLE
- [ ] `POST /sim/nozzle-up {"addr":"P2"}` causes service to log NOZZLE_UP
- [ ] Service sends AUTHORIZE — simulator logs `on_authorize P2`
- [ ] Service logs show data frames with increasing volume
- [ ] `POST /sim/nozzle-down` completes transaction
- [ ] Service logs final volume and amount
- [ ] Transaction appears in SQLite database
- [ ] Desktop UI shows correct status changes throughout

---

*End of simulator build prompt.*
*Start with main.rs scaffold, then dispenser.rs state machine, then engine.rs.*