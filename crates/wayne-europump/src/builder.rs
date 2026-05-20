use crate::crc::build_frame;

pub fn poll(addr: u8) -> Vec<u8> {
    vec![addr, 0x20, 0xFA]
}

/// Short ACK frame (PC acknowledges a received data frame or a C1 stop-ack).
/// `[addr] C0 FA` — no CRC, §5.1.
pub fn ack(addr: u8) -> Vec<u8> {
    vec![addr, 0xC0, 0xFA]
}

pub fn busy(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x30, 0x01, 0x01, 0x04])
}

pub fn stop(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x30, 0x01, 0x01, 0x08])
}

/// STOP PRE-COMMAND — `0x31` variant, sent **before** the regular `0x30` STOP
/// when delivery is active (§8.2). Dispenser replies with `C1 FA`; PC must
/// then send `ack()` before issuing `stop_frame()`.
pub fn stop_pre_frame(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x31, 0x01, 0x01, 0x08])
}

pub fn done(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x30, 0x01, 0x01, 0x05])
}

pub fn authorize_initial(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x30, 0x01, 0x01, 0x04, 0x01, 0x01, 0x05])
}

/// Compound abort after ghost fill: HALT + GO_IDLE + GET_DISP.
/// Sniffer log: `30 01 01 08 01 01 05 01 01 04`.
pub fn ghost_fill_abort(addr: u8) -> Vec<u8> {
    build_frame(&[
        addr, 0x30, 0x01, 0x01, 0x08, 0x01, 0x01, 0x05, 0x01, 0x01, 0x04,
    ])
}

/// Pack a unit price (UZS/L) into 3 BCD bytes for the auth-block type-03 record.
fn encode_unit_price_bcd(price: u32) -> [u8; 3] {
    let digits = format!("{:06}", price.min(999_999));
    let mut out = [0u8; 3];
    for (i, chunk) in digits.as_bytes().chunks(2).enumerate() {
        let hi = chunk[0].wrapping_sub(b'0');
        let lo = if chunk.len() > 1 {
            chunk[1].wrapping_sub(b'0')
        } else {
            0
        };
        out[i] = (hi << 4) | lo;
    }
    out
}

/// CONFIG frame (§6) — sent TWICE after AUTH on first zero-volume Data.
///
/// Layout matches sniffer captures: GO_IDLE + nozzle map + product block +
/// preset/price + AUTHORISE (`01 01 06`). For zero-volume ghost fill the
/// working app uses preset record `04 04 00 05 00 00`; full-tank arming uses
/// `03 04 00 09 99 00`.
pub fn authorize_config(addr: u8, unit_price: u32, zero_volume: bool) -> Vec<u8> {
    let price = encode_unit_price_bcd(unit_price);
    let mut payload = vec![
        addr, 0x30, 0x01, 0x01, 0x05,
        // nozzle / grade count
        0x02, 0x04,
        // nozzle codes 1–4 (from sniffer captures)
        0x01, 0x02, 0x03, 0x04,
        // product channel block (12 bytes — site-specific dispenser layout)
        0x05, 0x0C, 0x01, 0x43,
        0x00, 0x01, 0x05,
        0x00, 0x01, 0x24,
        0x00, 0x01, 0x43, 0x30,
    ];
    if zero_volume {
        // Ghost fill / zero-volume arming preset from sniffer log.
        payload.extend([0x04, 0x04, 0x00, 0x05, 0x00, 0x00]);
    } else {
        payload.extend([0x03, 0x04, 0x00, price[0], price[1], price[2]]);
    }
    payload.extend([0x01, 0x01, 0x06]);
    build_frame(&payload)
}

/// Hardcoded STOP frames per address (emergency broadcast).
pub fn stop_frame(addr: u8) -> Vec<u8> {
    match addr {
        0x50 => vec![0x50, 0x30, 0x01, 0x01, 0x08, 0x9E, 0x9A, 0x03, 0xFA],
        0x51 => vec![0x51, 0x30, 0x01, 0x01, 0x08, 0xA3, 0x5A, 0x03, 0xFA],
        0x52 => vec![0x52, 0x30, 0x01, 0x01, 0x08, 0xE7, 0x5A, 0x03, 0xFA],
        0x53 => vec![0x53, 0x30, 0x01, 0x01, 0x08, 0xDA, 0x9A, 0x03, 0xFA],
        _ => stop(addr),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_p2() {
        assert_eq!(poll(0x52), vec![0x52, 0x20, 0xFA]);
    }

    #[test]
    fn ack_short_frame() {
        assert_eq!(ack(0x52), vec![0x52, 0xC0, 0xFA]);
    }

    #[test]
    fn busy_matches_doc() {
        assert_eq!(
            busy(0x52),
            vec![0x52, 0x30, 0x01, 0x01, 0x04, 0xE7, 0x5F, 0x03, 0xFA]
        );
    }

    #[test]
    fn stop_matches_doc() {
        assert_eq!(
            stop(0x52),
            vec![0x52, 0x30, 0x01, 0x01, 0x08, 0xE7, 0x5A, 0x03, 0xFA]
        );
    }

    #[test]
    fn stop_pre_frame_matches_doc() {
        // Protocol doc §6 STOP CONFIRM test vectors
        assert_eq!(
            stop_pre_frame(0x52),
            vec![0x52, 0x31, 0x01, 0x01, 0x08, 0xE6, 0xA6, 0x03, 0xFA]
        );
        assert_eq!(
            stop_pre_frame(0x53),
            vec![0x53, 0x31, 0x01, 0x01, 0x08, 0xDB, 0x66, 0x03, 0xFA]
        );
        assert_eq!(
            stop_pre_frame(0x50),
            vec![0x50, 0x31, 0x01, 0x01, 0x08, 0x9F, 0x66, 0x03, 0xFA]
        );
        assert_eq!(
            stop_pre_frame(0x51),
            vec![0x51, 0x31, 0x01, 0x01, 0x08, 0xA2, 0xA6, 0x03, 0xFA]
        );
    }

    #[test]
    fn done_matches_doc() {
        assert_eq!(
            done(0x52),
            vec![0x52, 0x30, 0x01, 0x01, 0x05, 0x26, 0x9F, 0x03, 0xFA]
        );
    }

    #[test]
    fn authorize_matches_doc() {
        // Protocol doc §6 AUTHORIZE test vectors
        assert_eq!(
            authorize_initial(0x52),
            vec![0x52, 0x30, 0x01, 0x01, 0x04, 0x01, 0x01, 0x05, 0x19, 0x94, 0x03, 0xFA]
        );
        assert_eq!(
            authorize_initial(0x53),
            vec![0x53, 0x30, 0x01, 0x01, 0x04, 0x01, 0x01, 0x05, 0xD8, 0x58, 0x03, 0xFA]
        );
    }

    #[test]
    fn ghost_fill_abort_matches_sniffer() {
        assert_eq!(
            ghost_fill_abort(0x53),
            vec![
                0x53, 0x30, 0x01, 0x01, 0x08, 0x01, 0x01, 0x05, 0x01, 0x01, 0x04, 0x26, 0x68,
                0x03, 0xFA
            ]
        );
    }
}
