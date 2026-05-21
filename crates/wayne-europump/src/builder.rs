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

/// Pack a u32 into 3 BCD-packed bytes (6 decimal digits, high nibble first).
pub fn encode_bcd_3(val: u32) -> [u8; 3] {
    let digits = format!("{:06}", val.min(999_999));
    let b = digits.as_bytes();
    [
        ((b[0] - b'0') << 4) | (b[1] - b'0'),
        ((b[2] - b'0') << 4) | (b[3] - b'0'),
        ((b[4] - b'0') << 4) | (b[5] - b'0'),
    ]
}

/// CONFIG frame (§6) — price/preset block sent twice after AUTH (or with holstered pre-auth).
///
/// `product_codes`: Wayne PP bytes per active nozzle (index order), e.g. `[0x05, 0x43, 0x24]`.
/// `limit_bcd`: 3-byte preset/limit from [`encode_preset_limit_bcd`].
pub fn authorize_config(addr: u8, product_codes: &[u8], limit_bcd: [u8; 3]) -> Vec<u8> {
    let n = product_codes.len().clamp(1, 4);

    let mut payload = vec![addr, 0x30];
    payload.extend([0x01, 0x01, 0x05]); // GO_IDLE

    // Transaction context (sniffer: `02 04 01 02 03 04`).
    payload.push(0x02);
    payload.push(n as u8);
    for i in 1..=(n as u8) {
        payload.push(i);
    }

    // Channel / product map (sniffer: `05 0C` + triplets `01 PP 00`).
    payload.push(0x05);
    payload.push((n * 3) as u8);
    for &pp in product_codes.iter().take(n) {
        payload.extend([0x01, pp, 0x00]);
    }

    // Preset limit (`03 04 00` + 3 BCD bytes — volume, amount, or `09 99 00` full).
    payload.extend([0x03, 0x04, 0x00]);
    payload.extend_from_slice(&limit_bcd);

    payload.extend([0x01, 0x01, 0x06]); // AUTHORISE
    build_frame(&payload)
}

/// Hardware preset bytes inside CONFIG (`03 04 00` + 3 BCD bytes).
pub fn encode_preset_limit_bcd(full_tank: bool, volume_liters: Option<f64>, amount_uzs: Option<u64>) -> [u8; 3] {
    if full_tank {
        return [0x09, 0x99, 0x00];
    }
    if let Some(l) = volume_liters.filter(|&v| v > 0.0) {
        // Sniffer: 10.0 L → `00 00 10 00` (liters × 100).
        return encode_bcd_3((l * 100.0).round() as u32);
    }
    if let Some(a) = amount_uzs.filter(|&v| v > 0) {
        return encode_bcd_3(a.min(999_999) as u32);
    }
    [0x09, 0x99, 0x00]
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
    fn authorize_matches_doc() {
        assert_eq!(
            authorize_initial(0x53),
            vec![0x53, 0x30, 0x01, 0x01, 0x04, 0x01, 0x01, 0x05, 0xD8, 0x58, 0x03, 0xFA]
        );
    }

    #[test]
    fn config_volume_10l_matches_sniffer_layout() {
        let frame = authorize_config(0x52, &[0x05, 0x43, 0x24, 0x43], encode_bcd_3(1000));
        assert!(frame.starts_with(&[0x52, 0x30, 0x01, 0x01, 0x05]));
        assert!(frame.windows(6).any(|w| w == [0x03, 0x04, 0x00, 0x00, 0x10, 0x00]));
        assert!(frame.ends_with(&[0x03, 0xFA]));
    }

    #[test]
    fn config_full_preset_bytes() {
        let frame = authorize_config(0x53, &[0x05], [0x09, 0x99, 0x00]);
        assert!(frame.windows(6).any(|w| w == [0x03, 0x04, 0x00, 0x09, 0x99, 0x00]));
    }
}
