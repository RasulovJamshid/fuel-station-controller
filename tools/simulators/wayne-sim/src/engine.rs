use std::io::{Read, Write};

use tracing::{debug, info, warn};
use wayne_europump::FrameAccumulator;

use crate::dispenser::SharedDispensers;

pub fn spawn_serial_loop(
    port_name: String,
    baud: u32,
    parity: serialport::Parity,
    dispensers: SharedDispensers,
    log_frames: bool,
) {
    std::thread::spawn(move || {
        let mut accum = FrameAccumulator::default();
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

            let mut read_buf = [0u8; 64];

            'serial: loop {
                match port.read(&mut read_buf) {
                    Ok(n) if n > 0 => {
                        for frame in accum.push_bytes(&read_buf[..n]) {
                            if log_frames {
                                debug!("RX: {}", hex_str(&frame));
                            }

                            let addr = frame
                                .first()
                                .copied()
                                .filter(|&b| (0x50..=0x5F).contains(&b));
                            let Some(addr) = addr else {
                                continue;
                            };

                            let response = {
                                let mut disps = dispensers.lock().unwrap();
                                let d = disps.iter_mut().find(|d| d.addr == addr);
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
                                    break 'serial;
                                }
                                if let Err(e) = port.flush() {
                                    warn!("Serial flush error: {}", e);
                                    break 'serial;
                                }
                            }
                        }
                    }
                    Ok(_) | Err(_) => {}
                }
            }

            warn!("Serial session ended — reconnecting in 1s");
            accum = FrameAccumulator::default();
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
}

fn hex_str(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02X}", x)).collect::<Vec<_>>().join(" ")
}
