use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use wayne_europump::build_frame;

/// All possible states of a simulated dispenser side
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SimStatus {
    Idle,
    NozzleUp,
    /// Transient: emits one NozzleReturned frame then falls to Idle.
    NozzleDown,
    Authorized,
    Delivering,
    Done,
    Stopped,
}

#[derive(Debug, Clone)]
pub struct SimDispenser {
    pub fp_id: String,
    pub addr: u8,
    pub label: String,
    pub status: SimStatus,
    pub product: u8,
    pub product_name: String,
    pub nozzle: u8,
    pub price: u32,
    pub volume: f64,
    pub amount: u64,
    pub fill_rate: f64,
    pub seq: u8,
    pub respond: bool,
    pub settle_rounds: u8,
    pub last_tick: Option<Instant>,
    pub default_product: u8,
    pub default_product_name: String,
    pub default_price: u32,
    pub default_fill_rate: f64,
    /// True when authorize arrived while idle (pre-auth); false when authorize after nozzle up.
    pub authorized_from_idle: bool,
    /// Expected nozzle/product after desktop pre-authorize (simulator only).
    pub preauth_nozzle: Option<u8>,
    pub preauth_product: Option<u8>,
    pub preauth_product_name: Option<String>,
    /// Volume limit decoded from the CONFIG frame's preset block (None = full tank).
    pub preset_volume_liters: Option<f64>,
    /// True when tick_volume hit the preset limit (nozzle still in tank).
    /// False when the operator explicitly holstered (replace_nozzle while Delivering).
    pub preset_completed: bool,
    /// Emit one final Data frame at the capped preset volume before switching
    /// to idle polling while the nozzle is still up.
    pub preset_final_data_pending: bool,
}

impl SimDispenser {
    pub fn new(
        fp_id: &str,
        addr: u8,
        label: &str,
        product: u8,
        product_name: &str,
        price: u32,
        fill_rate: f64,
    ) -> Self {
        Self {
            fp_id: fp_id.to_string(),
            addr,
            label: label.to_string(),
            status: SimStatus::Idle,
            product,
            product_name: product_name.to_string(),
            nozzle: 1,
            price,
            volume: 0.0,
            amount: 0,
            fill_rate,
            seq: 0x31,
            respond: true,
            settle_rounds: 0,
            last_tick: None,
            default_product: product,
            default_product_name: product_name.to_string(),
            default_price: price,
            default_fill_rate: fill_rate,
            authorized_from_idle: false,
            preauth_nozzle: None,
            preauth_product: None,
            preauth_product_name: None,
            preset_volume_liters: None,
            preset_completed: false,
            preset_final_data_pending: false,
        }
    }

    pub fn set_preauth_expectation(
        &mut self,
        nozzle: u8,
        product: u8,
        product_name: Option<String>,
    ) {
        self.preauth_nozzle = Some(nozzle);
        self.preauth_product = Some(product);
        self.preauth_product_name = product_name;
    }

    /// Align sim lane with desktop pre-authorization (holstered, ready for grade lift).
    /// Stays Idle on the wire until the service sends authorize (0x04) or the operator lifts.
    pub fn prepare_preauth_lane(&mut self, nozzle: u8, product: u8, product_name: Option<String>) {
        self.set_preauth_expectation(nozzle, product, product_name);
        self.product = product;
        self.nozzle = nozzle;
        if let Some(name) = self.preauth_product_name.clone() {
            self.product_name = name;
        }
        self.volume = 0.0;
        self.amount = 0;
        self.last_tick = None;
        if self.status == SimStatus::Delivering || self.status == SimStatus::Done {
            self.status = SimStatus::Idle;
            self.authorized_from_idle = false;
        }
        // Do NOT clear authorized_from_idle unconditionally — if the service already
        // sent CONFIG (sim is Authorized with authorized_from_idle=true), clearing it
        // would cause the sim to jump straight to Delivering without a nozzle lift.
    }

    pub fn clear_preauth_expectation(&mut self) {
        self.preauth_nozzle = None;
        self.preauth_product = None;
        self.preauth_product_name = None;
    }

    /// PC sent a complete frame addressed to this dispenser (already routed by addr).
    pub fn handle_frame(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        if !self.respond {
            return None;
        }

        if self.settle_rounds > 0 {
            self.settle_rounds -= 1;
            return Some(self.data_frame_zeros());
        }

        if frame.len() == 3 && frame[0] == self.addr && frame[2] == 0xFA {
            match frame[1] {
                0x20 => return self.handle_poll(),
                0xC0 => return None,
                _ => {}
            }
        }

        if frame.len() >= 2 {
            let cmd = frame[1];
            if (cmd == 0x30 || cmd == 0x31) && frame.len() >= 9 {
                return self.handle_command(frame);
            }
        }

        Some(self.idle_or_status_frame())
    }

    fn handle_poll(&mut self) -> Option<Vec<u8>> {
        if self.status == SimStatus::Authorized && !self.authorized_from_idle {
            self.status = SimStatus::Delivering;
            self.last_tick = Some(Instant::now());
        }
        self.tick_volume();

        match &self.status {
            SimStatus::Idle => Some(vec![self.addr, 0x70, 0xFA]),
            SimStatus::NozzleUp => Some(self.nozzle_up_frame()),
            SimStatus::NozzleDown => {
                let frame = self.nozzle_returned_frame();
                self.status = SimStatus::Idle;
                self.volume = 0.0;
                self.amount = 0;
                self.last_tick = None;
                self.authorized_from_idle = false;
                self.preset_volume_liters = None;
                self.preset_completed = false;
                self.preset_final_data_pending = false;
                self.clear_preauth_expectation();
                Some(frame)
            }
            // Pre-auth while holstered: stay idle on the wire until the nozzle is lifted.
            SimStatus::Authorized if self.authorized_from_idle => Some(vec![self.addr, 0x70, 0xFA]),
            SimStatus::Authorized | SimStatus::Delivering => Some(self.data_frame()),
            SimStatus::Done => {
                if self.preset_completed {
                    if self.preset_final_data_pending {
                        self.preset_final_data_pending = false;
                        // Emit capped totals once so the backend records the full preset
                        // amount before waiting for the physical holster event.
                        Some(self.data_frame())
                    } else {
                        // Nozzle is still in the tank — return Idle so the service closes
                        // the transaction without triggering the CompleteGhostFill GO_IDLE loop.
                        // The lane stays Done until the operator explicitly holsters (nozzle-down).
                        Some(vec![self.addr, 0x70, 0xFA])
                    }
                } else {
                    Some(self.done_frame())
                }
            }
            SimStatus::Stopped => Some(self.stopped_frame()),
        }
    }

    fn handle_command(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        let ack = || vec![self.addr, 0xC0, 0xFA];
        if frame.len() < 9 {
            return Some(ack());
        }
        let inner = &frame[..frame.len() - 4];
        if inner.len() < 5 || inner[0] != self.addr {
            return Some(ack());
        }

        let cmd_byte = inner[4];

        match cmd_byte {
            0x08 => {
                if self.status == SimStatus::Authorized {
                    self.last_tick = None;
                    self.status = SimStatus::Idle;
                    self.volume = 0.0;
                    self.amount = 0;
                    self.authorized_from_idle = false;
                    self.clear_preauth_expectation();
                } else if self.status == SimStatus::Delivering {
                    self.last_tick = None;
                    // Stopped (not Done) so the service keeps E-stop continuation state.
                    self.status = SimStatus::Stopped;
                }
                Some(vec![self.addr, 0xC1, 0xFA])
            }
            0x05 => {
                if inner.len() == 5 {
                    // GO_IDLE: for a normal holster-then-done flow (preset_completed=false) the
                    // service sends this after recording the transaction — sim goes Idle.
                    // For a preset-triggered Done (preset_completed=true) the nozzle is still in
                    // the tank; ignore GO_IDLE and wait for nozzle-down instead.
                    if self.status == SimStatus::Done && !self.preset_completed {
                        self.status = SimStatus::Idle;
                        self.volume = 0.0;
                        self.amount = 0;
                        self.preset_volume_liters = None;
                        self.preset_final_data_pending = false;
                    }
                    Some(ack())
                } else if inner.len() > 8 {
                    // Large frame = full CONFIG+AUTHORISE from service.
                    // Accept from Authorized (normal path) or NozzleUp (operator
                    // authorized while nozzle was already lifted).
                    if (self.status == SimStatus::Authorized && !self.authorized_from_idle)
                        || self.status == SimStatus::NozzleUp
                    {
                        self.volume = 0.0;
                        self.amount = 0;
                        self.last_tick = Some(Instant::now());
                        self.status = SimStatus::Delivering;
                        self.preset_final_data_pending = false;
                    } else if self.status == SimStatus::Done || self.status == SimStatus::Idle {
                        // Holstered preauth (or new preauth after a preset-completed Done):
                        // store the config and wait for the nozzle lift.
                        self.volume = 0.0;
                        self.amount = 0;
                        self.authorized_from_idle = true;
                        self.preset_completed = false;
                        self.preset_final_data_pending = false;
                        self.status = SimStatus::Authorized;
                    }
                    self.preset_volume_liters = parse_preset_from_config(inner);
                    Some(ack())
                } else {
                    Some(ack())
                }
            }
            0x04 => {
                if inner.len() >= 8
                    && inner.get(5).copied() == Some(0x01)
                    && inner.get(6).copied() == Some(0x01)
                    && inner.get(7).copied() == Some(0x05)
                {
                    if self.status == SimStatus::Idle {
                        self.status = SimStatus::Authorized;
                        self.authorized_from_idle = true;
                    } else if self.status == SimStatus::NozzleUp {
                        // Nozzle already lifted — authorize starts delivery on next poll.
                        self.status = SimStatus::Authorized;
                        self.authorized_from_idle = false;
                    } else if self.status == SimStatus::Stopped {
                        // Re-authorize after pause: segment counter resets; poll or lift starts delivery.
                        self.volume = 0.0;
                        self.amount = 0;
                        self.last_tick = None;
                        self.status = SimStatus::Authorized;
                        self.authorized_from_idle = false;
                    }
                    Some(ack())
                } else {
                    Some(ack())
                }
            }
            _ => Some(ack()),
        }
    }

    fn idle_or_status_frame(&self) -> Vec<u8> {
        vec![self.addr, 0x70, 0xFA]
    }

    pub fn lift_nozzle(
        &mut self,
        product: Option<u8>,
        product_name: Option<String>,
        nozzle: Option<u8>,
        price: Option<u32>,
    ) -> anyhow::Result<()> {
        let lift_product = product.unwrap_or(self.default_product);
        let lift_nozzle = nozzle.unwrap_or(1);
        let lift_name = product_name.unwrap_or_else(|| self.default_product_name.clone());
        self.price = price.unwrap_or(self.default_price);

        if let (Some(exp_n), Some(exp_p)) = (self.preauth_nozzle, self.preauth_product) {
            if lift_nozzle != exp_n || lift_product != exp_p {
                let expected_name = self
                    .preauth_product_name
                    .as_deref()
                    .unwrap_or("the authorized grade");
                return Err(anyhow::anyhow!(
                    "Wrong fuel grade: this sale is for {expected_name}, not {lift_name}. Holster the nozzle and lift {expected_name}."
                ));
            }
        }

        self.product = lift_product;
        self.product_name = lift_name;
        self.nozzle = lift_nozzle;

        match &self.status {
            SimStatus::Idle => {
                self.status = SimStatus::NozzleUp;
                Ok(())
            }
            SimStatus::Authorized => {
                self.volume = 0.0;
                self.amount = 0;
                // Always emit nozzle-up on the next poll so the service can match grade / start delivery.
                self.status = SimStatus::NozzleUp;
                Ok(())
            }
            // Pre-auth: nozzle already up — fields validated/updated above.
            SimStatus::NozzleUp if self.authorized_from_idle || self.preauth_nozzle.is_some() => {
                Ok(())
            }
            SimStatus::NozzleUp => Ok(()),
            // Nozzle went down but NozzleReturned hasn't been sent yet — re-lift cancels it.
            SimStatus::NozzleDown => {
                self.status = SimStatus::NozzleUp;
                Ok(())
            }
            SimStatus::Delivering => Ok(()),
            SimStatus::Done => {
                self.volume = 0.0;
                self.amount = 0;
                self.last_tick = None;
                self.authorized_from_idle = false;
                self.preset_final_data_pending = false;
                self.status = SimStatus::NozzleUp;
                Ok(())
            }
            SimStatus::Stopped => {
                self.authorized_from_idle = false;
                self.status = SimStatus::Delivering;
                self.last_tick = Some(Instant::now());
                Ok(())
            }
        }
    }

    /// Simulate the nozzle being returned to the holster (`POST /sim/nozzle-down`).
    ///
    /// Mid-delivery this ends the fill (`Delivering` → `Done`). Earlier in the flow
    /// (`NozzleUp` / `Authorized`) it normally cancels back to `Idle` — except during
    /// pre-authorization, where holstering must keep the sale so the customer can lift
    /// the correct grade.
    pub fn replace_nozzle(&mut self) -> anyhow::Result<()> {
        match self.status {
            SimStatus::Idle => Ok(()),
            SimStatus::Authorized if self.authorized_from_idle => {
                // Pre-auth while holstered: already down; keep authorization.
                Ok(())
            }
            SimStatus::NozzleUp if self.authorized_from_idle => {
                // Pre-auth: holster after wrong/correct lift attempt — stay authorized.
                self.status = SimStatus::Authorized;
                self.volume = 0.0;
                self.amount = 0;
                self.last_tick = None;
                Ok(())
            }
            SimStatus::NozzleUp => {
                // Emit one NozzleReturned frame on the next poll before going idle.
                self.status = SimStatus::NozzleDown;
                Ok(())
            }
            SimStatus::Authorized => {
                self.status = SimStatus::Idle;
                self.volume = 0.0;
                self.amount = 0;
                self.last_tick = None;
                self.authorized_from_idle = false;
                self.clear_preauth_expectation();
                Ok(())
            }
            SimStatus::Delivering => {
                // Physical holster during delivery should emit NozzleReturned first.
                // Backend finalizes history from this event in simulator mode.
                self.status = SimStatus::NozzleDown;
                Ok(())
            }
            SimStatus::NozzleDown => Ok(()), // already going to Idle
            SimStatus::Done => {
                // Real pump emits NozzleReturned on holster, then goes Idle.
                // Transition through NozzleDown so the next poll sends that frame.
                self.status = SimStatus::NozzleDown;
                Ok(())
            }
            SimStatus::Stopped => {
                // Nozzle holstered after E-stop. Go directly to Idle so the service
                // can keep its stopped_context intact for Resume/Close.
                self.status = SimStatus::Idle;
                self.volume = 0.0;
                self.amount = 0;
                self.last_tick = None;
                Ok(())
            }
        }
    }

    pub fn go_offline(&mut self) {
        self.respond = false;
    }

    pub fn go_online(&mut self, with_flush: bool) {
        self.respond = true;
        if with_flush {
            self.settle_rounds = 3;
        }
    }

    pub fn reset(&mut self) {
        self.status = SimStatus::Idle;
        self.volume = 0.0;
        self.amount = 0;
        self.respond = true;
        self.settle_rounds = 0;
        self.last_tick = None;
        self.authorized_from_idle = false;
        self.product = self.default_product;
        self.product_name = self.default_product_name.clone();
        self.price = self.default_price;
        self.fill_rate = self.default_fill_rate;
        self.preset_volume_liters = None;
        self.preset_completed = false;
        self.preset_final_data_pending = false;
    }

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
        self.volume += self.fill_rate * elapsed;
        self.volume = (self.volume * 100.0).floor() / 100.0;
        self.amount = (self.volume * self.price as f64).floor() as u64;

        if let Some(limit) = self.preset_volume_liters {
            if self.volume >= limit {
                self.volume = (limit * 100.0).floor() / 100.0;
                self.amount = (self.volume * self.price as f64).floor() as u64;
                self.last_tick = None;
                self.preset_completed = true; // nozzle still in tank
                self.preset_final_data_pending = true;
                self.status = SimStatus::Done;
            }
        }
    }

    fn next_seq(&mut self) -> u8 {
        let s = self.seq;
        self.seq = if self.seq >= 0x3F { 0x31 } else { self.seq + 1 };
        s
    }

    fn nozzle_up_frame(&mut self) -> Vec<u8> {
        let seq = self.next_seq();
        // Wayne protocol: lift codes are nozzle_index + 0x10 (0x11=nozzle1, 0x12=nozzle2, …).
        let hose_lift_code = self.nozzle + 0x10;
        let frame = build_frame(&[
            self.addr,
            seq,
            0x03,
            0x04,
            0x01,
            self.product,
            0x00,
            hose_lift_code,
        ]);
        // Pre-auth: after emitting one NozzleUp for the service to verify the grade,
        // transition to Authorized (non-pre-auth). The next poll will start delivery.
        if self.authorized_from_idle {
            self.authorized_from_idle = false;
            self.status = SimStatus::Authorized;
        }
        frame
    }

    fn nozzle_returned_frame(&mut self) -> Vec<u8> {
        let seq = self.next_seq();
        // Holster code = nozzle_index (1, 2, 3 — all < 0x10).
        build_frame(&[
            self.addr,
            seq,
            0x03,
            0x04,
            0x01,
            self.product,
            0x00,
            self.nozzle,
        ])
    }

    fn data_frame(&mut self) -> Vec<u8> {
        let seq = self.next_seq();
        let hundredths = (self.volume * 100.0).round() as u32;
        let vx1_bcd = to_bcd_byte((hundredths / 1_000_000) % 100);
        let vx2_bcd = to_bcd_byte((hundredths / 10_000) % 100);
        let v1_bcd = to_bcd_byte((hundredths / 100) % 100);
        let v2_bcd = to_bcd_byte(hundredths % 100);
        let a = self.amount.min(9_999_999);
        let a1_bcd = to_bcd_byte(((a / 10000) % 100) as u32);
        let a2_bcd = to_bcd_byte(((a / 100) % 100) as u32);
        let a3_bcd = to_bcd_byte((a % 100) as u32);
        build_frame(&[
            self.addr, seq, 0x02, 0x08, vx1_bcd, vx2_bcd, v1_bcd, v2_bcd, 0x00, a1_bcd, a2_bcd,
            a3_bcd,
        ])
    }

    fn data_frame_zeros(&mut self) -> Vec<u8> {
        let seq = self.next_seq();
        build_frame(&[
            self.addr, seq, 0x02, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ])
    }

    fn done_frame(&mut self) -> Vec<u8> {
        let seq = self.next_seq();
        build_frame(&[self.addr, seq, 0x01, 0x01, 0x05])
    }

    fn stopped_frame(&mut self) -> Vec<u8> {
        let seq = self.next_seq();
        build_frame(&[self.addr, seq, 0x01, 0x01, 0x01])
    }
}

fn to_bcd_byte(v: u32) -> u8 {
    let tens = (v / 10) % 10;
    let ones = v % 10;
    ((tens << 4) | ones) as u8
}

/// Scan a CONFIG frame body for the `03 04 00 B1 B2 B3` preset-limit block and
/// decode it as a volume in litres.  Returns `None` for full-tank (`09 99 00`).
fn parse_preset_from_config(inner: &[u8]) -> Option<f64> {
    for i in 0..inner.len().saturating_sub(5) {
        if inner[i] == 0x03 && inner[i + 1] == 0x04 && inner[i + 2] == 0x00 {
            let [b1, b2, b3] = [inner[i + 3], inner[i + 4], inner[i + 5]];
            let hundredths = (b1 >> 4) as u32 * 100_000
                + (b1 & 0xF) as u32 * 10_000
                + (b2 >> 4) as u32 * 1_000
                + (b2 & 0xF) as u32 * 100
                + (b3 >> 4) as u32 * 10
                + (b3 & 0xF) as u32;
            // 09 99 00 → 99900 hundredths ≈ 999 L (full tank sentinel)
            return if hundredths >= 99_900 {
                None
            } else {
                Some(hundredths as f64 / 100.0)
            };
        }
    }
    None
}

pub type SharedDispensers = Arc<Mutex<Vec<SimDispenser>>>;
