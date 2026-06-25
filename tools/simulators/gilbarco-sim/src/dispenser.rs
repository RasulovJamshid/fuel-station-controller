use std::sync::{Arc, Mutex};
use std::time::Instant;

pub type SharedDispensers = Arc<Mutex<Vec<SimDispenser>>>;

#[derive(Debug, PartialEq, Clone)]
pub enum SimStatus {
    Idle,
    NozzleLifted,
    Ready,
    Delivering,
    TransactionComplete,
    Stopped,
}

#[derive(Debug, Clone)]
pub struct NozzleCfg {
    pub index: u8,
    pub price: u32,
}

pub struct SimDispenser {
    pub fp_id: String,
    pub addr: u8,
    pub label: String,
    pub status: SimStatus,
    pub respond: bool,

    // Current transaction
    pub nozzle: u8,
    pub price: u32,
    pub volume_ml: u64,
    pub amount_raw: u64,

    // Running shift totals per nozzle (index = nozzle.index - 1)
    pub volume_totals: Vec<u64>,
    pub amount_totals: Vec<u64>,

    // All nozzles on this FP (from site config)
    pub nozzles: Vec<NozzleCfg>,

    // Fill parameters
    pub fill_rate: f64,
    last_tick: Option<Instant>,

    // Polls remaining in TransactionComplete phase (A0 then B0 then Idle)
    tc_polls: u8,

    // Polls remaining in Ready phase before auto-transitioning to Delivering
    ready_polls: u8,

    // Money preset from the PC's preset_amount frame (same units as amount_raw).
    // 0 or None means "full tank" (no limit).
    preset_amount_raw: Option<u64>,
}

impl SimDispenser {
    pub fn new(
        fp_id: &str,
        addr: u8,
        label: &str,
        nozzles: Vec<NozzleCfg>,
        fill_rate: f64,
    ) -> Self {
        let default_price = nozzles.first().map(|n| n.price).unwrap_or(11000);
        let default_nozzle = nozzles.first().map(|n| n.index).unwrap_or(1);
        let n = nozzles.len();
        Self {
            fp_id: fp_id.to_string(),
            addr,
            label: label.to_string(),
            status: SimStatus::Idle,
            respond: true,
            nozzle: default_nozzle,
            price: default_price,
            volume_ml: 0,
            amount_raw: 0,
            volume_totals: vec![0u64; n],
            amount_totals: vec![0u64; n],
            nozzles,
            fill_rate,
            last_tick: None,
            tc_polls: 0,
            ready_polls: 0,
            preset_amount_raw: None,
        }
    }

    // ── API actions ───────────────────────────────────────────────────────────

    pub fn lift_nozzle(&mut self, nozzle: Option<u8>, price: Option<u32>) -> anyhow::Result<()> {
        if self.status != SimStatus::Idle {
            anyhow::bail!("cannot lift nozzle: current status is {:?}", self.status);
        }
        self.nozzle = nozzle.unwrap_or_else(|| self.nozzles.first().map(|n| n.index).unwrap_or(1));
        self.price = price.unwrap_or_else(|| {
            self.nozzles
                .iter()
                .find(|n| n.index == self.nozzle)
                .map(|n| n.price)
                .unwrap_or(self.price)
        });
        self.volume_ml = 0;
        self.amount_raw = 0;
        self.preset_amount_raw = None;
        self.last_tick = None;
        self.status = SimStatus::NozzleLifted;
        Ok(())
    }

    pub fn replace_nozzle(&mut self) -> anyhow::Result<()> {
        match self.status {
            SimStatus::NozzleLifted | SimStatus::Ready | SimStatus::Delivering => {
                self.commit_totals();
                self.preset_amount_raw = None;
                self.status = SimStatus::TransactionComplete;
                self.tc_polls = 2;
                self.last_tick = None;
                Ok(())
            }
            SimStatus::Stopped => {
                // Totals were already committed when the pump was stopped (halt or force_stop).
                self.preset_amount_raw = None;
                self.status = SimStatus::TransactionComplete;
                self.tc_polls = 2;
                self.last_tick = None;
                Ok(())
            }
            _ => anyhow::bail!("cannot holster nozzle: status is {:?}", self.status),
        }
    }

    /// Immediately stop an active delivery without going through TransactionComplete.
    /// Called by the E-stop API so the pump shows Stopped until nozzle-down.
    pub fn force_stop(&mut self) {
        if matches!(
            self.status,
            SimStatus::NozzleLifted | SimStatus::Ready | SimStatus::Delivering
        ) {
            self.commit_totals();
            self.status = SimStatus::Stopped;
            self.last_tick = None;
        }
    }

    pub fn go_offline(&mut self) {
        self.respond = false;
    }

    pub fn go_online(&mut self) {
        self.respond = true;
    }

    pub fn reset(&mut self) {
        self.status = SimStatus::Idle;
        self.volume_ml = 0;
        self.amount_raw = 0;
        self.preset_amount_raw = None;
        self.last_tick = None;
        self.tc_polls = 0;
        self.ready_polls = 0;
        self.respond = true;
    }

    // ── Protocol command handlers ─────────────────────────────────────────────

    /// Handle a single-byte command (status poll, authorize, halt, GetDisplay,
    /// GetTransaction, GetTotals, GetAll, command_mode, or nozzle trigger 0xFF).
    pub fn handle_byte(&mut self, b: u8) -> Option<Vec<u8>> {
        if !self.respond {
            return None;
        }
        let addr_nibble = self.addr & 0x0F;

        match b {
            // Status poll: addr byte = 0x00|addr_nibble
            a if a == addr_nibble => Some(self.status_response()),

            // command_mode: 0x20|addr → reply 0xD0|addr
            a if a == 0x20 | addr_nibble => Some(vec![0xD0 | addr_nibble]),

            // authorize: 0x10|addr → transition NozzleLifted → Ready; no reply.
            // Stopped pumps do NOT respond to authorize on real hardware; they must
            // go through nozzle-down → TC → Idle first.
            a if a == 0x10 | addr_nibble => {
                if self.status == SimStatus::NozzleLifted {
                    self.ready_polls = 2;
                    self.status = SimStatus::Ready;
                }
                None
            }

            // halt: 0x30|addr → transition to Stopped; no reply
            a if a == 0x30 | addr_nibble => {
                if matches!(
                    self.status,
                    SimStatus::Delivering | SimStatus::Ready | SimStatus::NozzleLifted
                ) {
                    self.commit_totals();
                    self.status = SimStatus::Stopped;
                    self.last_tick = None;
                }
                None
            }

            // GetDisplay: 0x60|addr → 6 display bytes
            a if a == 0x60 | addr_nibble => Some(self.get_display_response()),

            // GetTransaction: 0x40|addr → 33-byte frame
            a if a == 0x40 | addr_nibble => Some(self.get_transaction_response()),

            // GetTotals: 0x50|addr → totals frame
            a if a == 0x50 | addr_nibble => Some(self.get_totals_response()),

            // GetAll: 0xF0 → 19-byte all-pump frame
            0xF0 => Some(self.get_all_response()),

            // Nozzle trigger (inside listen mode after command_mode): reply nozzle payload
            0xFF => {
                if self.status == SimStatus::NozzleLifted {
                    Some(vec![0xE9, 0xFE, 0xE0, 0xE1, 0xE0, 0xFB, 0xEE])
                } else {
                    None
                }
            }

            _ => None,
        }
    }

    /// Handle a complete multi-byte frame (set_price / preset_amount, 13 bytes).
    /// These are write-only commands from the PC; no response is expected.
    pub fn handle_frame(&mut self, frame: &[u8]) {
        if !self.respond {
            return;
        }
        // 0xFF 0xE5 0xF4 0xF6 nozzle_id 0xF7 d0 d1 d2 d3 0xFB lrc 0xF0 → set_price
        // 0xFF 0xE5 0xF2 0xF8 d0 d1 d2 d3 d4 d5 0xFB lrc 0xF0 → preset_amount
        if frame.len() < 13 || frame[0] != 0xFF || frame[1] != 0xE5 {
            return;
        }
        if frame[2] == 0xF4 && frame[3] == 0xF6 {
            // set_price: frame[4] = 0xE0|(nozzle_index-1); bytes 6-9 are 4 LE BCD price digits.
            // Only apply if this frame targets the current nozzle.
            let target_nozzle = (frame[4] & 0x0F).wrapping_add(1);
            if target_nozzle == self.nozzle {
                if let Some(raw) = decode_e_digits_le(&frame[6..10]) {
                    self.price = raw as u32 * 10;
                }
            }
        } else if frame[2] == 0xF2 && frame[3] == 0xF8 {
            // preset_amount: bytes 4-9 are 6 LE BCD digits of amount_raw (0 = full tank / no limit)
            if let Some(raw) = decode_e_digits_le(&frame[4..10]) {
                self.preset_amount_raw = if raw == 0 { None } else { Some(raw) };
            }
        }
    }

    // ── Status response ───────────────────────────────────────────────────────

    fn status_response(&mut self) -> Vec<u8> {
        self.tick_volume();
        let addr_nibble = self.addr & 0x0F;
        let b = match &self.status {
            SimStatus::Idle => 0x60 | addr_nibble,
            SimStatus::NozzleLifted => 0x70 | addr_nibble,
            SimStatus::Ready => {
                if self.ready_polls > 0 {
                    self.ready_polls -= 1;
                    if self.ready_polls == 0 {
                        self.status = SimStatus::Delivering;
                        self.last_tick = None;
                        return vec![0x90 | addr_nibble];
                    }
                    0x80 | addr_nibble
                } else {
                    self.status = SimStatus::Delivering;
                    self.last_tick = None;
                    0x90 | addr_nibble
                }
            }
            SimStatus::Delivering => 0x90 | addr_nibble,
            SimStatus::TransactionComplete => {
                if self.tc_polls > 1 {
                    self.tc_polls -= 1;
                    0xA0 | addr_nibble
                } else if self.tc_polls == 1 {
                    self.tc_polls -= 1;
                    0xB0 | addr_nibble
                } else {
                    self.status = SimStatus::Idle;
                    0x60 | addr_nibble
                }
            }
            SimStatus::Stopped => 0xC0 | addr_nibble,
        };
        vec![b]
    }

    // ── Volume accumulation ───────────────────────────────────────────────────

    fn tick_volume(&mut self) {
        if self.status != SimStatus::Delivering {
            self.last_tick = None;
            return;
        }
        let now = Instant::now();
        let elapsed = match self.last_tick {
            Some(t) => now.duration_since(t).as_secs_f64(),
            None => {
                self.last_tick = Some(now);
                return;
            }
        };
        self.last_tick = Some(now);
        let delta_ml = (self.fill_rate * elapsed * 1000.0) as u64;
        self.volume_ml = self.volume_ml.saturating_add(delta_ml);
        // amount_raw = volume_mL × price_soum_per_L / 10000
        self.amount_raw = self.volume_ml.saturating_mul(self.price as u64) / 10_000;
        // cap at 9 999 999 (6-digit BCD max for amount)
        self.amount_raw = self.amount_raw.min(9_999_999);

        // Stop at preset limit (preset_amount_raw uses the same units as amount_raw)
        if let Some(limit) = self.preset_amount_raw {
            if self.amount_raw >= limit {
                self.amount_raw = limit;
                // Recalculate volume to match the capped amount
                self.volume_ml = limit * 10_000 / self.price.max(1) as u64;
                self.commit_totals();
                self.preset_amount_raw = None;
                self.status = SimStatus::TransactionComplete;
                self.tc_polls = 2;
                self.last_tick = None;
            }
        }
    }

    fn commit_totals(&mut self) {
        if let Some(i) = self.nozzles.iter().position(|n| n.index == self.nozzle) {
            if let Some(v) = self.volume_totals.get_mut(i) {
                *v = v.saturating_add(self.volume_ml);
            }
            if let Some(a) = self.amount_totals.get_mut(i) {
                *a = a.saturating_add(self.amount_raw);
            }
        }
    }

    // ── Response frame builders ───────────────────────────────────────────────

    fn get_display_response(&self) -> Vec<u8> {
        encode_e_digits_le_vec(self.amount_raw, 6)
    }

    fn get_all_response(&self) -> Vec<u8> {
        let pump = self.addr & 0x0F;
        let nozzle = match self.status {
            SimStatus::NozzleLifted | SimStatus::Ready | SimStatus::Delivering => {
                self.nozzle & 0x0F
            }
            _ => 0,
        };
        let mut frame = vec![
            0xBA,
            0xB0,
            0xB3,
            0xB0 | pump,
            0xB0,
            0xB1,
            0xB0,
            0xB0,
            0xB0,
            0xB0,
            0xB1,
            0xB1,
            0xB1,
            0xB1,
            0xB0 | nozzle,
            0xC2,
        ];
        let lrc = gilbarco::gilbarco_lrc(&frame);
        frame.push(lrc);
        frame.extend_from_slice(&[0x8D, 0x8A]);
        frame
    }

    fn get_transaction_response(&self) -> Vec<u8> {
        let unit_price_raw = self.price as u64 / 10;
        let nozzle_id = self.nozzle & 0x0F;
        let grade = nozzle_id;

        let mut frame = vec![
            0xFF,
            0xF1,
            0xF8,
            0xEB,
            0xE0 | nozzle_id,
            0xE0,
            0xE0,
            0xE0,
            0xF6,
            0xE0 | grade,
            0xF4,
            0xF7,
        ];
        frame.extend(encode_e_digits_le_vec(unit_price_raw, 4));
        frame.push(0xF9);
        frame.extend(encode_e_digits_le_vec(self.volume_ml, 6));
        frame.push(0xFA);
        frame.extend(encode_e_digits_le_vec(self.amount_raw, 6));
        frame.push(0xFB);
        let lrc = gilbarco::gilbarco_lrc(&frame);
        frame.push(lrc);
        frame.push(0xF0);
        frame
    }

    fn get_totals_response(&self) -> Vec<u8> {
        let mut frame = vec![0xFF];
        for (i, nc) in self.nozzles.iter().enumerate() {
            let vol = self.volume_totals.get(i).copied().unwrap_or(0);
            let amt = self.amount_totals.get(i).copied().unwrap_or(0);
            let price_raw = nc.price as u64 / 10;
            frame.push(0xF6);
            frame.push(0xE0 | i as u8);
            frame.push(0xF9);
            frame.extend(encode_e_digits_le_vec(vol, 8));
            frame.push(0xFA);
            frame.extend(encode_e_digits_le_vec(amt, 8));
            frame.push(0xF4);
            frame.extend(encode_e_digits_le_vec(price_raw, 4));
            frame.push(0xF5);
            frame.extend_from_slice(&[0xE0; 4]);
        }
        frame.push(0xFB);
        let lrc = gilbarco::gilbarco_lrc(&frame);
        frame.push(lrc);
        frame.push(0xF0);
        frame
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Encode `val` as `n` little-endian BCD bytes: byte[i] = 0xE0 | digit_i.
fn encode_e_digits_le_vec(mut val: u64, n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(0xE0 | (val % 10) as u8);
        val /= 10;
    }
    out
}

/// Decode little-endian BCD bytes (0xE0|digit format) to u64.
fn decode_e_digits_le(bytes: &[u8]) -> Option<u64> {
    bytes.iter().enumerate().try_fold(0u64, |acc, (i, &b)| {
        if b & 0xF0 != 0xE0 || b & 0x0F > 9 {
            return None;
        }
        Some(acc + (b & 0x0F) as u64 * 10u64.pow(i as u32))
    })
}
