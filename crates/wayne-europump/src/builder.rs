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
///
/// Used for both unit prices (whole currency units) and volumes (scaled by
/// 10_000 to get 4 implied decimal places — see `authorize_config`).
///
/// Examples:
///   price  10500 → "010500" → [0x01, 0x05, 0x00]
///   volume 50000 (= 5.0 L × 10_000) → "050000" → [0x05, 0x00, 0x00]
fn encode_bcd_3(val: u32) -> [u8; 3] {
    let digits = format!("{:06}", val.min(999_999));
    let b = digits.as_bytes();
    [
        ((b[0] - b'0') << 4) | (b[1] - b'0'),
        ((b[2] - b'0') << 4) | (b[3] - b'0'),
        ((b[4] - b'0') << 4) | (b[5] - b'0'),
    ]
}

/// CONFIG frame (§6) — sent TWICE after AUTH on the first Data frame.
///
/// `grade_prices`: current unit price for each active grade (whole currency
///   units, e.g. UZS), ordered by ascending nozzle index. 1–4 grades.
///
/// `vol_limit`: when `Some(liters)`, injects a hardware volume cap in the
///   preset record (type-04). Volume is encoded with 4 implied decimal places:
///   5.0 L → 50_000 → "050000" → `[0x05, 0x00, 0x00]`. When `None`, the
///   type-03 unit-price record is used and any currency cap is enforced by the
///   service software.
pub fn authorize_config(addr: u8, grade_prices: &[u32], vol_limit: Option<f64>) -> Vec<u8> {
    let n = grade_prices.len().clamp(1, 4);

    let mut payload = vec![addr, 0x30];
    payload.extend([0x01, 0x01, 0x05]); // GO_IDLE

    // Nozzle map: [type=0x02, count, nozzle_code_1, ..., nozzle_code_n]
    payload.push(0x02);
    payload.push(n as u8);
    for i in 1..=(n as u8) {
        payload.push(i);
    }

    // Price table: [type=0x05, len=n×3, grade_1_bcd, ..., grade_n_bcd]
    payload.push(0x05);
    payload.push((n * 3) as u8);
    for &price in grade_prices.iter().take(n) {
        payload.extend_from_slice(&encode_bcd_3(price));
    }

    // Preset / limit record
    if let Some(liters) = vol_limit.filter(|&v| v > 0.0) {
        // Hardware volume cap (type-04): encode liters with 4 implied decimal places.
        let vol = encode_bcd_3((liters * 10_000.0).round() as u32);
        payload.extend([0x04, 0x04, 0x00]);
        payload.extend_from_slice(&vol);
    } else {
        // No hardware volume cap (type-03): send unit price of grade 1.
        // Software enforces any currency / volume cap via live metering.
        let price = encode_bcd_3(grade_prices.first().copied().unwrap_or(0));
        payload.extend([0x03, 0x04, 0x00]);
        payload.extend_from_slice(&price);
    }

    payload.extend([0x01, 0x01, 0x06]); // AUTHORISE
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
                0x53, 0x30, 0x01, 0x01, 0x08, 0x01, 0x01, 0x05, 0x01, 0x01, 0x04, 0x26, 0x68, 0x03,
                0xFA
            ]
        );
    }
}
