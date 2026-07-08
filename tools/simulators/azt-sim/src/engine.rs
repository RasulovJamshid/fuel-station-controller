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

        'serial: loop {
            match port.read(&mut buf) {
                Ok(n) if n > 0 => {
                    accum.extend_from_slice(&buf[..n]);
                    if log_frames {
                        debug!("RX raw: {}", hex_str(&buf[..n]));
                    }
                    while let Some(req) = azt::pop_request(&mut accum) {
                        if log_frames {
                            debug!(
                                "REQ addr={:?} cmd={:02X} data={}",
                                req.addr,
                                req.cmd,
                                hex_str(&req.data)
                            );
                        }
                        let response = {
                            let mut disps = dispensers.lock().unwrap();
                            match req.addr {
                                Some(net) => disps
                                    .iter_mut()
                                    .find(|d| (d.addr & 0x0F) == net)
                                    .and_then(|d| d.handle_request(&req)),
                                None => {
                                    // Broadcast: deliver to every dispenser, никогда
                                    // не отвечаем (§7.18).
                                    for d in disps.iter_mut() {
                                        let _ = d.handle_request(&req);
                                    }
                                    None
                                }
                            }
                        };
                        if let Some(resp) = response {
                            if log_frames {
                                debug!("TX: {}", hex_str(&resp));
                            }
                            if let Err(e) = port.write_all(&resp) {
                                warn!("Serial write error: {}", e);
                                break 'serial;
                            }
                            if let Err(e) = port.flush() {
                                warn!("Serial flush error: {}", e);
                                break 'serial;
                            }
                        }
                    }
                }
                Ok(_) | Err(_) => {
                    // Idle: advance fills so time-based transitions (dose reached)
                    // happen even between polls.
                    let mut disps = dispensers.lock().unwrap();
                    for d in disps.iter_mut() {
                        d.tick();
                    }
                }
            }
        }

        warn!("Serial session ended — reconnecting in 1s");
        accum.clear();
        std::thread::sleep(std::time::Duration::from_secs(1));
    });
}

fn hex_str(b: &[u8]) -> String {
    b.iter()
        .map(|x| format!("{:02X}", x))
        .collect::<Vec<_>>()
        .join(" ")
}
