use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use anyhow::Result;
use site_config::{FuelingPositionConfig, SiteConfig};
use tokio::sync::{broadcast, RwLock};
use types::WsEvent;

use crate::engine::serial::ReconnectingSerial;
use crate::engine::state::RuntimeFp;

pub(in crate::engine) use types::preset_metadata;

pub enum SerialBackend {
    Real(Arc<ReconnectingSerial>),
    Mock(Arc<std::sync::Mutex<MockSerial>>),
}

pub struct MockSerial {
    out: VecDeque<u8>,
}

impl MockSerial {
    pub fn new() -> Self {
        Self {
            out: VecDeque::new(),
        }
    }

    fn on_write(&mut self, data: &[u8]) {
        if data.len() >= 4 && data[data.len() - 2] == 0x03 && data[data.len() - 1] == 0xFA {
            let addr = data[0];
            if addr != 0 {
                self.out.extend([addr, 0xC0, 0xFA]);
            }
            return;
        }
        if data.len() >= 3 {
            let n = data.len();
            let addr = data[n - 3];
            if data[n - 2] == 0x20 && data[n - 1] == 0xFA && addr != 0 {
                self.out.push_back(addr);
                self.out.push_back(0x70);
                self.out.push_back(0xFA);
            }
        }
    }

    fn read_available(&mut self, max: usize) -> Vec<u8> {
        let mut v = Vec::new();
        for _ in 0..max {
            if let Some(b) = self.out.pop_front() {
                v.push(b);
            } else {
                break;
            }
        }
        v
    }
}

pub(in crate::engine) fn exchange_serial(backend: &SerialBackend, out: &[u8]) -> Result<Vec<u8>> {
    match backend {
        SerialBackend::Real(real) => real.exchange(out),
        SerialBackend::Mock(m) => {
            let mut g = m.lock().unwrap();
            g.on_write(out);
            Ok(g.read_available(512))
        }
    }
}

/// Write-only serial send — used for short ACK frames (`C0 FA`) where the
/// protocol does not expect an immediate response from the dispenser.
pub(in crate::engine) fn write_serial(backend: &SerialBackend, out: &[u8]) -> Result<()> {
    match backend {
        SerialBackend::Real(real) => real.write_only(out),
        SerialBackend::Mock(_) => Ok(()),
    }
}

pub(in crate::engine) fn active_positions_by_byte(
    cfg: &SiteConfig,
) -> HashMap<u8, FuelingPositionConfig> {
    cfg.fueling_positions
        .iter()
        .filter(|fp| fp.active)
        .map(|fp| (fp.address_byte, fp.clone()))
        .collect()
}

pub(in crate::engine) async fn broadcast_status(
    byte: u8,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
) {
    let st = {
        let map = runtimes.read().await;
        map.get(&byte).map(|r| r.snapshot_state())
    };
    if let Some(s) = st {
        let _ = events.send(WsEvent::Status(s));
    }
}
