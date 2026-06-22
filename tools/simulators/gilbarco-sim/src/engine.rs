use std::io::{Read, Write};

use tracing::{debug, info, warn};

use crate::dispenser::SharedDispensers;

pub fn spawn_serial_loop(
    port_name: String,
    baud: u32,
    parity: serialport::Parity,
    dispensers: SharedDispensers,
    log_frames: bool,
) {
    std::thread::spawn(move || loop {
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

        let mut buf = [0u8; 64];
        let mut accum: Vec<u8> = Vec::new();
        // Tracks which dispenser (addr nibble) was last put into command_mode (0x2N),
        // so that 0xFF and 0xF0 can be routed to the correct dispenser.
        let mut last_listen_addr: Option<u8> = None;

        'serial: loop {
            match port.read(&mut buf) {
                Ok(n) if n > 0 => {
                    accum.extend_from_slice(&buf[..n]);
                    if log_frames {
                        debug!("RX raw: {}", hex_str(&buf[..n]));
                    }
                    while let Some(response) =
                        process_next(&mut accum, &dispensers, log_frames, &mut last_listen_addr)
                    {
                        if log_frames {
                            debug!("TX: {}", hex_str(&response));
                        }
                        if let Err(e) = port.write_all(&response) {
                            warn!("Serial write error: {}", e);
                            break 'serial;
                        }
                        if let Err(e) = port.flush() {
                            warn!("Serial flush error: {}", e);
                            break 'serial;
                        }
                    }
                }
                Ok(_) | Err(_) => {}
            }
        }

        warn!("Serial session ended — reconnecting in 1s");
        accum.clear();
        std::thread::sleep(std::time::Duration::from_secs(1));
    });
}

/// Try to extract and dispatch one complete command from `accum`.
/// Returns `Some(response)` if a command was consumed and produced a reply,
/// `Some(empty)` if a command was consumed with no reply (write-only), or
/// `None` if the accumulator doesn't yet hold a complete command.
///
/// `last_listen_addr` tracks the addr nibble of the dispenser last put into
/// command_mode (0x2N), so that 0xFF (nozzle trigger) and 0xF0 (GetAll) —
/// which carry no addr nibble — can be routed to the correct dispenser.
fn process_next(
    accum: &mut Vec<u8>,
    dispensers: &SharedDispensers,
    log_frames: bool,
    last_listen_addr: &mut Option<u8>,
) -> Option<Vec<u8>> {
    if accum.is_empty() {
        return None;
    }

    // 13-byte multi-byte frame: 0xFF 0xE5 ...
    if accum[0] == 0xFF && accum.len() >= 2 && accum[1] == 0xE5 {
        if accum.len() < 13 {
            return None; // wait for full frame
        }
        let frame: Vec<u8> = accum.drain(..13).collect();
        if log_frames {
            debug!("CMD set_price/preset_amount: {}", hex_str(&frame));
        }
        // Route only to the dispenser that was last put into command_mode (0x2N).
        // Broadcasting to all dispensers would corrupt prices/presets on other pumps.
        let mut disps = dispensers.lock().unwrap();
        if let Some(addr) = *last_listen_addr {
            if let Some(d) = disps.iter_mut().find(|d| (d.addr & 0x0F) == addr) {
                d.handle_frame(&frame);
            }
        }
        return Some(vec![]);
    }

    // Single-byte command
    let b = accum.remove(0);
    if log_frames {
        debug!("CMD byte: {:02X}", b);
    }

    // 0xFF (nozzle trigger) and 0xF0 (GetAll) carry no addr nibble.
    // Route them to the dispenser last put into command_mode (0x2N).
    if b == 0xFF || b == 0xF0 {
        let mut disps = dispensers.lock().unwrap();
        let response = if let Some(addr) = *last_listen_addr {
            disps
                .iter_mut()
                .find(|d| (d.addr & 0x0F) == addr)
                .and_then(|d| d.handle_byte(b))
        } else {
            // Fallback: find first dispenser that claims ownership
            disps.iter_mut().find_map(|d| d.handle_byte(b))
        };
        return Some(response.unwrap_or_default());
    }

    let mut disps = dispensers.lock().unwrap();
    let addr_nibble = b & 0x0F;
    let response = disps
        .iter_mut()
        .find(|d| (d.addr & 0x0F) == addr_nibble)
        .and_then(|d| d.handle_byte(b));

    // Track command_mode (0x20–0x2F): the dispenser that acknowledged becomes
    // the target for subsequent 0xFF / 0xF0 commands.
    if b & 0xF0 == 0x20 && response.is_some() {
        *last_listen_addr = Some(addr_nibble);
    }

    Some(response.unwrap_or_default())
}

fn hex_str(b: &[u8]) -> String {
    b.iter()
        .map(|x| format!("{:02X}", x))
        .collect::<Vec<_>>()
        .join(" ")
}
