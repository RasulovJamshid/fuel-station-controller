//! Simulated AZT 2.0 TRK (fuel dispenser) state machine.
//!
//! Implements the status graph from разд. 6 of the protocol document and the
//! command semantics from разд. 7, for a single-hose dispenser per network
//! address. All wire framing is delegated to the `azt` crate, so the simulator
//! doubles as an integration test of the codec.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use azt::frame::encode_digits;
use azt::{encode_data_response, encode_short_response, TrkRequest, ACK, CAN, NAK};

pub type SharedDispensers = Arc<Mutex<Vec<SimDispenser>>>;

/// TRK identifier reported to the '7' type query: type 'A' → L=6, M=4, T=6.
/// Real pumps report ASCII letters (a bench scan captured 0x48 'H'), matching
/// `TrkType::from_identifier`'s 'A'..'H' table.
const TRK_IDENTIFIER: u8 = b'A';
/// Maximum dose in "full tank" mode, 0.01 L units (990.00 L per spec §7.13).
const FULL_TANK_CAP_CL: u64 = 99_000;

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum SimStatus {
    /// '0' — off, nozzle holstered.
    OffHolstered,
    /// '1' — off, nozzle lifted.
    OffLifted,
    /// '2' — authorization accepted, waiting for pump start.
    Authorized,
    /// '3' — dispensing.
    Dispensing,
    /// '4' + reason — finished ('0' normal, '1' overfill/unauthorized).
    Finished { overfill: bool },
}

#[derive(Debug, Clone)]
pub struct NozzleCfg {
    pub index: u8,
    pub price: u32,
}

pub struct SimDispenser {
    pub fp_id: String,
    /// Site-config address byte; network number = `addr & 0x0F` (1..=15).
    pub addr: u8,
    pub label: String,
    pub status: SimStatus,
    pub respond: bool,
    pub nozzle_lifted: bool,

    // Current sale registers.
    pub nozzle: u8,
    /// Price per litre in minor currency units (4 wire digits).
    pub price: u32,
    /// Dispensed volume of the current sale, 0.01 L.
    pub volume_cl: u64,
    /// Preset dose, 0.01 L (None until a dose command arrives).
    pub dose_cl: Option<u64>,
    pub full_tank: bool,

    // Lifetime totalizers (equal digit width on the wire, разд. 7.6).
    pub volume_total_cl: u64,
    pub amount_total_min: u64,

    /// Non-resettable transaction counter (UINTR, разд. 7.20).
    pub uintr: u64,

    pub nozzles: Vec<NozzleCfg>,
    pub fill_rate: f64,
    last_tick: Option<Instant>,
}

impl SimDispenser {
    pub fn new(
        fp_id: &str,
        addr: u8,
        label: &str,
        nozzles: Vec<NozzleCfg>,
        fill_rate: f64,
    ) -> Self {
        let default_price = nozzles.first().map(|n| n.price).unwrap_or(670);
        let default_nozzle = nozzles.first().map(|n| n.index).unwrap_or(1);
        Self {
            fp_id: fp_id.to_string(),
            addr,
            label: label.to_string(),
            status: SimStatus::OffHolstered,
            respond: true,
            nozzle_lifted: false,
            nozzle: default_nozzle,
            price: default_price,
            volume_cl: 0,
            dose_cl: None,
            full_tank: false,
            volume_total_cl: 0,
            amount_total_min: 0,
            uintr: 0,
            nozzles,
            fill_rate,
            last_tick: None,
        }
    }

    /// Cost of the current sale in minor units, rounded per §7.5 note 2.
    pub fn cost_min(&self) -> u64 {
        // volume_cl (0.01 L) × price (minor/L) / 100, rounded half-up.
        (self.volume_cl * self.price as u64 + 50) / 100
    }

    fn is_idle(&self) -> bool {
        matches!(self.status, SimStatus::OffHolstered | SimStatus::OffLifted)
    }

    fn idle_status(&self) -> SimStatus {
        if self.nozzle_lifted {
            SimStatus::OffLifted
        } else {
            SimStatus::OffHolstered
        }
    }

    fn commit_totals(&mut self) {
        self.volume_total_cl += self.volume_cl;
        self.amount_total_min += self.cost_min();
    }

    /// Advance the fill simulation by wall-clock time.
    pub fn tick(&mut self) {
        let now = Instant::now();
        let dt = self
            .last_tick
            .replace(now)
            .map(|t| now.duration_since(t).as_secs_f64())
            .unwrap_or(0.0);

        // Authorized + nozzle up → pump starts (§6 п.3.1).
        if self.status == SimStatus::Authorized && self.nozzle_lifted {
            self.status = SimStatus::Dispensing;
        }

        if self.status == SimStatus::Dispensing {
            let cap = if self.full_tank {
                FULL_TANK_CAP_CL
            } else {
                self.dose_cl.unwrap_or(FULL_TANK_CAP_CL)
            };
            self.volume_cl += (self.fill_rate * dt * 100.0) as u64;
            if self.volume_cl >= cap {
                self.volume_cl = cap;
                self.finish(false);
            }
        }
    }

    fn finish(&mut self, overfill: bool) {
        self.commit_totals();
        self.status = SimStatus::Finished { overfill };
    }

    // ── Wire protocol ─────────────────────────────────────────────────────────

    /// Handle one decoded SU request. `None` = no response (offline, broadcast,
    /// or a status-inappropriate broadcast per §7.18).
    pub fn handle_request(&mut self, req: &TrkRequest) -> Option<Vec<u8>> {
        if !self.respond {
            return None;
        }
        self.tick();

        let resp = match req.cmd {
            // '1' status (§7.1)
            0x31 => match self.status {
                SimStatus::Finished { overfill } => {
                    encode_data_response(&[0x34, if overfill { 0x31 } else { 0x30 }])
                }
                s => encode_data_response(&[status_char(s)]),
            },

            // '2' authorize (§7.2): from '0'/'1' (('8' when we model БМУ)).
            0x32 => {
                if self.is_idle() {
                    self.status = SimStatus::Authorized;
                    self.volume_cl = 0; // §7.2: full-data register zeroed on ACK
                    self.uintr += 1;
                    encode_short_response(ACK)
                } else {
                    encode_short_response(CAN)
                }
            }

            // '3' reset (§7.3): from '2'/'3' → '4'+reason; pump switches off.
            0x33 => match self.status {
                SimStatus::Authorized | SimStatus::Dispensing => {
                    self.finish(false);
                    encode_short_response(ACK)
                }
                _ => encode_short_response(CAN),
            },

            // '4' current data (§7.4): '0' + 5 volume digits (0.01 L).
            0x34 => {
                let mut d = vec![0x30];
                d.extend(encode_digits(self.volume_cl, 5));
                encode_data_response(&d)
            }

            // '5' full data (§7.5, type A widths: L=6 T=6 M=4).
            0x35 => {
                let mut d = Vec::with_capacity(16);
                d.extend(encode_digits(self.volume_cl, 6));
                d.extend(encode_digits(self.cost_min(), 6));
                d.extend(encode_digits(self.price as u64, 4));
                encode_data_response(&d)
            }

            // '6' totals (§7.6): 8 litre digits (0.01 L) + 8 amount digits.
            0x36 => {
                let mut d = Vec::with_capacity(16);
                d.extend(encode_digits(self.volume_total_cl, 8));
                d.extend(encode_digits(self.amount_total_min, 8));
                encode_data_response(&d)
            }

            // '7' TRK type (§7.7).
            0x37 => encode_data_response(&[TRK_IDENTIFIER]),

            // '8' confirm totals write (§7.8): from '4' → '0'/'1'.
            0x38 => match self.status {
                SimStatus::Finished { .. } => {
                    self.status = self.idle_status();
                    self.dose_cl = None;
                    self.full_tank = false;
                    encode_short_response(ACK)
                }
                _ => encode_short_response(CAN),
            },

            // 'P' protocol version (§7.9).
            0x50 => encode_data_response(&encode_digits(2, 8)),

            // 'Q' set price (§7.10): from '0'/'1'; previous sale data cleared.
            0x51 => {
                if self.is_idle() && req.data.len() >= 4 {
                    match azt::frame::decode_digits(&req.data[..4]) {
                        Some(p) => {
                            self.price = p as u32;
                            self.volume_cl = 0;
                            self.uintr += 1; // §7.20: UINTR bumps on price set
                            encode_short_response(ACK)
                        }
                        None => encode_short_response(CAN),
                    }
                } else {
                    encode_short_response(CAN)
                }
            }

            // 'S' dose in currency (§7.12): 6 digits of minor units.
            0x53 => {
                if self.is_idle() && self.price > 0 && req.data.len() >= 6 {
                    match azt::frame::decode_digits(&req.data[..6]) {
                        Some(minor) => {
                            // §7.12 note 1: the largest dose whose ROUNDED cost
                            // (half-up to whole minor units, §7.5 note 2) does not
                            // exceed the requested amount. round((cl·p+50)/100) ≤ m
                            // ⇔ cl ≤ (m·100+49)/p. Spec example: 100.03 at 6.70/L
                            // → 14.93 L (14.93·6.70 = 100.031 → rounds to 100.03).
                            self.dose_cl = Some((minor * 100 + 49) / self.price as u64);
                            self.full_tank = false;
                            encode_short_response(ACK)
                        }
                        None => encode_short_response(CAN),
                    }
                } else {
                    encode_short_response(CAN)
                }
            }

            // 'T' dose in litres (§7.13): 5 digits of 0.01 L (+full-tank flag).
            0x54 => {
                if self.is_idle() && req.data.len() >= 5 {
                    match azt::frame::decode_digits(&req.data[..5]) {
                        Some(cl) => {
                            self.dose_cl = Some(cl);
                            self.full_tank = req.data.get(5) == Some(&0x31);
                            encode_short_response(ACK)
                        }
                        None => encode_short_response(CAN),
                    }
                } else {
                    encode_short_response(CAN)
                }
            }

            // 'U' top-up (§7.14): re-arm without clearing the sale register.
            0x55 => {
                if self.is_idle() {
                    encode_short_response(ACK)
                } else {
                    encode_short_response(CAN)
                }
            }

            // 'V' unconditional start (§7.15): from '2' only.
            0x56 => {
                if self.status == SimStatus::Authorized {
                    self.status = SimStatus::Dispensing;
                    encode_short_response(ACK)
                } else {
                    encode_short_response(CAN)
                }
            }

            // 'X' read set dose (§7.23).
            0x58 => match self.dose_cl {
                Some(cl) if self.is_idle() => {
                    let mut d = vec![0x30];
                    d.extend(encode_digits(cl, 5));
                    encode_data_response(&d)
                }
                _ => encode_short_response(CAN),
            },

            // 'Y' transaction number (§7.20).
            0x59 => encode_data_response(&encode_digits(self.uintr, 8)),

            // 'W' broadcast general params (§7.18): never answered.
            0x57 => return None,

            // Unknown command → NAK (§2.2).
            _ => encode_short_response(NAK),
        };
        Some(resp)
    }

    // ── API actions (operator side of the forecourt) ──────────────────────────

    pub fn lift_nozzle(&mut self, nozzle: Option<u8>, price: Option<u32>) -> anyhow::Result<()> {
        if self.nozzle_lifted {
            anyhow::bail!("nozzle already lifted (status {:?})", self.status);
        }
        self.nozzle_lifted = true;
        if let Some(n) = nozzle {
            self.nozzle = n;
        }
        if let Some(p) = price {
            self.price = p;
        }
        if self.status == SimStatus::OffHolstered {
            self.status = SimStatus::OffLifted;
        }
        // Authorized + lift → tick() starts the pump on the next poll.
        self.last_tick = None;
        Ok(())
    }

    pub fn replace_nozzle(&mut self) -> anyhow::Result<()> {
        if !self.nozzle_lifted {
            anyhow::bail!("nozzle already holstered");
        }
        self.nozzle_lifted = false;
        match self.status {
            // §6 п.4.1: holstering during a fill ends the sale.
            SimStatus::Dispensing => self.finish(false),
            SimStatus::OffLifted => self.status = SimStatus::OffHolstered,
            _ => {}
        }
        Ok(())
    }

    /// Physical/forecourt emergency stop: end the sale where it stands.
    pub fn force_stop(&mut self) {
        if matches!(
            self.status,
            SimStatus::Authorized | SimStatus::Dispensing
        ) {
            self.finish(false);
        }
    }

    /// Hard reset from the control API (not the wire '3' command).
    pub fn reset(&mut self) {
        self.status = self.idle_status();
        self.volume_cl = 0;
        self.dose_cl = None;
        self.full_tank = false;
        self.last_tick = None;
    }

    pub fn go_offline(&mut self) {
        self.respond = false;
    }

    pub fn go_online(&mut self) {
        self.respond = true;
    }
}

fn status_char(s: SimStatus) -> u8 {
    match s {
        SimStatus::OffHolstered => 0x30,
        SimStatus::OffLifted => 0x31,
        SimStatus::Authorized => 0x32,
        SimStatus::Dispensing => 0x33,
        SimStatus::Finished { .. } => 0x34,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use azt::{decode_response, Response};

    fn sim() -> SimDispenser {
        SimDispenser::new(
            "fp1",
            0x01,
            "Lane 1",
            vec![NozzleCfg {
                index: 1,
                price: 670,
            }],
            2.0,
        )
    }

    fn req(cmd: u8, data: &[u8]) -> TrkRequest {
        TrkRequest {
            addr: Some(1),
            cmd,
            data: data.to_vec(),
        }
    }

    fn expect_data(resp: Option<Vec<u8>>) -> Vec<u8> {
        match decode_response(&resp.expect("response")).expect("decodes") {
            Response::Data(d) => d,
            other => panic!("expected data, got {other:?}"),
        }
    }

    fn expect_short(resp: Option<Vec<u8>>, code: u8) {
        match decode_response(&resp.expect("response")).expect("decodes") {
            Response::Short(c) => assert_eq!(c, code),
            other => panic!("expected short {code:02X}, got {other:?}"),
        }
    }

    #[test]
    fn full_cycle_dose_by_litres() {
        let mut d = sim();
        // idle holstered
        assert_eq!(expect_data(d.handle_request(&req(0x31, &[]))), vec![0x30]);
        // set price 6.70 → ACK; set dose 10.00 L → ACK; authorize → ACK
        expect_short(d.handle_request(&req(0x51, b"0670")), ACK);
        expect_short(d.handle_request(&req(0x54, b"01000")), ACK);
        expect_short(d.handle_request(&req(0x32, &[])), ACK);
        assert_eq!(expect_data(d.handle_request(&req(0x31, &[]))), vec![0x32]);
        // lift → dispensing on next poll
        d.lift_nozzle(None, None).unwrap();
        assert_eq!(expect_data(d.handle_request(&req(0x31, &[]))), vec![0x33]);
        // force-complete the dose (simulate elapsed fill)
        d.volume_cl = 1000;
        d.tick();
        let st = expect_data(d.handle_request(&req(0x31, &[])));
        assert_eq!(st, vec![0x34, 0x30]);
        // full data: 001000 / 006700 / 0670  (10 L × 6.70 = 67.00)
        let fd = expect_data(d.handle_request(&req(0x35, &[])));
        assert_eq!(&fd[..6], b"001000");
        assert_eq!(&fd[6..12], b"006700");
        assert_eq!(&fd[12..16], b"0670");
        // confirm → idle lifted; totals committed
        expect_short(d.handle_request(&req(0x38, &[])), ACK);
        assert_eq!(expect_data(d.handle_request(&req(0x31, &[]))), vec![0x31]);
        let totals = expect_data(d.handle_request(&req(0x36, &[])));
        assert_eq!(&totals[..8], b"00001000");
        assert_eq!(&totals[8..], b"00006700");
        // UINTR bumped by set-price + authorize
        let tr = expect_data(d.handle_request(&req(0x59, &[])));
        assert_eq!(tr, b"00000002");
    }

    #[test]
    fn authorize_refused_while_dispensing() {
        let mut d = sim();
        expect_short(d.handle_request(&req(0x54, b"01000")), ACK);
        expect_short(d.handle_request(&req(0x32, &[])), ACK);
        d.lift_nozzle(None, None).unwrap();
        d.tick();
        assert_eq!(d.status, SimStatus::Dispensing);
        expect_short(d.handle_request(&req(0x32, &[])), CAN);
        expect_short(d.handle_request(&req(0x51, b"0670")), CAN);
    }

    #[test]
    fn reset_mid_fill_finishes_with_partial_data() {
        let mut d = sim();
        expect_short(d.handle_request(&req(0x54, b"03000")), ACK);
        expect_short(d.handle_request(&req(0x32, &[])), ACK);
        d.lift_nozzle(None, None).unwrap();
        d.tick();
        d.volume_cl = 500; // 5.00 L into a 30 L dose
        expect_short(d.handle_request(&req(0x33, &[])), ACK);
        let st = expect_data(d.handle_request(&req(0x31, &[])));
        assert_eq!(st, vec![0x34, 0x30]);
        let fd = expect_data(d.handle_request(&req(0x35, &[])));
        assert_eq!(&fd[..6], b"000500");
    }

    #[test]
    fn dose_in_currency_floors_volume() {
        let mut d = sim();
        // 100.03 at 6.70/L → 14.93 L (§7.12 example).
        expect_short(d.handle_request(&req(0x51, b"0670")), ACK);
        expect_short(d.handle_request(&req(0x53, b"010003")), ACK);
        assert_eq!(d.dose_cl, Some(1493));
    }

    #[test]
    fn unknown_command_naks() {
        let mut d = sim();
        expect_short(d.handle_request(&req(0x7A, &[])), NAK);
    }

    #[test]
    fn read_dose_before_authorize() {
        let mut d = sim();
        expect_short(d.handle_request(&req(0x58, &[])), CAN);
        expect_short(d.handle_request(&req(0x54, b"01000")), ACK);
        let dose = expect_data(d.handle_request(&req(0x58, &[])));
        assert_eq!(dose, b"001000".to_vec());
    }

    #[test]
    fn offline_returns_nothing() {
        let mut d = sim();
        d.go_offline();
        assert_eq!(d.handle_request(&req(0x31, &[])), None);
    }
}
