use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimState {
    Idle,
    Armed,
    Dispensing,
    Synchronizing,
    Final,
}

pub struct ShelfSimulator {
    pub fp_id: String,
    pub address: u8,
    pub state: SimState,
    pub nozzle_lifted: bool,
    pub volume_steps: u32,
    pub price: u32,
    pub online: bool,
    cap_steps: u32,
    total_steps: u32,
    fill_rate_steps_per_second: f64,
    last_tick: Instant,
}

impl ShelfSimulator {
    pub fn new(fp_id: String, address: u8, price: u32, rate_m3_s: f64) -> Self {
        Self {
            fp_id,
            address,
            state: SimState::Idle,
            nozzle_lifted: false,
            volume_steps: 0,
            price,
            online: true,
            cap_steps: 0,
            total_steps: 0,
            fill_rate_steps_per_second: rate_m3_s * 100.0,
            last_tick: Instant::now(),
        }
    }

    pub fn amount(&self) -> u32 {
        ((self.volume_steps as u64 * self.price as u64 + 50) / 100) as u32
    }

    pub fn lift(&mut self) -> anyhow::Result<()> {
        if self.nozzle_lifted {
            anyhow::bail!("nozzle already lifted");
        }
        self.nozzle_lifted = true;
        if self.state == SimState::Armed {
            self.state = SimState::Dispensing;
        }
        self.last_tick = Instant::now();
        Ok(())
    }

    pub fn holster(&mut self) -> anyhow::Result<()> {
        if !self.nozzle_lifted {
            anyhow::bail!("nozzle already holstered");
        }
        self.nozzle_lifted = false;
        if matches!(self.state, SimState::Dispensing | SimState::Armed) {
            self.finish();
        }
        Ok(())
    }

    pub fn reset(&mut self) {
        self.state = SimState::Idle;
        self.nozzle_lifted = false;
        self.volume_steps = 0;
        self.cap_steps = 0;
        self.last_tick = Instant::now();
    }

    pub fn tick(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_tick).as_secs_f64();
        self.last_tick = now;
        if self.state == SimState::Armed && self.nozzle_lifted {
            self.state = SimState::Dispensing;
        }
        if self.state == SimState::Dispensing {
            self.volume_steps = self
                .volume_steps
                .saturating_add((elapsed * self.fill_rate_steps_per_second) as u32);
            if self.cap_steps > 0 && self.volume_steps >= self.cap_steps {
                self.volume_steps = self.cap_steps;
                self.finish();
            }
        }
    }

    fn finish(&mut self) {
        self.total_steps = self.total_steps.saturating_add(self.volume_steps);
        self.state = SimState::Synchronizing;
    }

    pub fn handle(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        if !self.online || frame.len() < 7 {
            return None;
        }
        let address = frame[1];
        let index = frame[2];
        let request = shelf_v22::decode_response(address, index, frame)?;
        if address != self.address {
            return None;
        }
        self.tick();
        let (command, data) = match request.command {
            0x01 => self.status_response(),
            0x02 => (0x91, (self.price as u16).to_le_bytes().to_vec()),
            0x03 if request.data.len() == 2 => {
                self.price = u16::from_le_bytes([request.data[0], request.data[1]]) as u32;
                (0x00, vec![])
            }
            0x04 if self.state == SimState::Final => self.final_response(),
            0x04 => (0x92, u24(self.volume_steps).to_vec()),
            0x05 if request.data.len() == 7 && self.state == SimState::Idle => {
                self.volume_steps = 0;
                self.cap_steps = read_u24(&request.data[2..5]);
                self.price = u16::from_le_bytes([request.data[5], request.data[6]]) as u32;
                self.state = if self.nozzle_lifted {
                    SimState::Dispensing
                } else {
                    SimState::Armed
                };
                (0x84, self.active_data())
            }
            0x09 if request.data.len() == 3 && self.state == SimState::Idle => {
                let amount = read_u24(&request.data);
                self.volume_steps = 0;
                self.cap_steps = amount.saturating_mul(100) / self.price.max(1);
                self.state = if self.nozzle_lifted {
                    SimState::Dispensing
                } else {
                    SimState::Armed
                };
                (0x84, self.active_data())
            }
            0x0C if matches!(self.state, SimState::Dispensing | SimState::Armed) => {
                self.finish();
                (0x00, vec![])
            }
            0x15 if self.state == SimState::Idle || self.state == SimState::Final => {
                (0xA0, self.total_steps.to_le_bytes().to_vec())
            }
            0x19 => (0xA3, u24(2_000).to_vec()),
            _ => (0xFF, vec![]),
        };
        shelf_v22::build_request(address, index, command, &data)
    }

    fn status_response(&mut self) -> (u8, Vec<u8>) {
        match self.state {
            SimState::Idle => (
                0x81,
                vec![self.guns(), if self.nozzle_lifted { 0x21 } else { 0x20 }],
            ),
            SimState::Armed | SimState::Dispensing => (0x84, self.active_data()),
            SimState::Synchronizing => {
                self.state = SimState::Final;
                let mut data = self.active_data();
                data.extend_from_slice(&[0; 6]);
                (0x85, data)
            }
            SimState::Final => {
                let response = self.final_response();
                self.state = SimState::Idle;
                response
            }
        }
    }

    fn guns(&self) -> u8 {
        if self.nozzle_lifted {
            0x02
        } else {
            0x00
        }
    }

    fn active_data(&self) -> Vec<u8> {
        let dispenser = 0x01
            | if self.state == SimState::Dispensing {
                0x80
            } else {
                0
            };
        let mut data = vec![self.guns(), dispenser, 0x01, self.address];
        data.extend_from_slice(&u24(self.volume_steps));
        data
    }

    fn final_response(&self) -> (u8, Vec<u8>) {
        let mut data = vec![self.guns(), 0x01];
        data.extend_from_slice(&u24(self.volume_steps));
        data.extend_from_slice(&u24(self.amount()));
        data.extend_from_slice(&(self.price as u16).to_le_bytes());
        (0x93, data)
    }
}

fn read_u24(bytes: &[u8]) -> u32 {
    bytes[0] as u32 | ((bytes[1] as u32) << 8) | ((bytes[2] as u32) << 16)
}
fn u24(value: u32) -> [u8; 3] {
    [value as u8, (value >> 8) as u8, (value >> 16) as u8]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        sim: &mut ShelfSimulator,
        index: u8,
        command: u8,
        data: &[u8],
    ) -> shelf_v22::Response {
        let frame = shelf_v22::build_request(sim.address, index, command, data).unwrap();
        let reply = sim.handle(&frame).unwrap();
        shelf_v22::decode_response(sim.address, index, &reply).unwrap()
    }

    #[test]
    fn full_sale_workflow_reaches_mar_with_exact_totals() {
        let mut sim = ShelfSimulator::new("FP1".into(), 10, 162, 1.0);
        sim.lift().unwrap();
        let volume_data = [0, 0, 0x2C, 0x01, 0, 0xA2, 0]; // 3.00 m³, price 162
        assert_eq!(request(&mut sim, 1, 0x05, &volume_data).command, 0x84);
        sim.volume_steps = 300;
        sim.finish();
        assert_eq!(request(&mut sim, 2, 0x01, &[]).command, 0x85);
        let final_reply = request(&mut sim, 3, 0x01, &[]);
        let sale = shelf_v22::parse_final_sale(&final_reply).unwrap();
        assert_eq!(sale.volume_steps, 300);
        assert_eq!(sale.amount, 486);
        assert_eq!(sale.price, 162);
    }
}
