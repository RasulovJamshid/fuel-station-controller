use crate::frame::{GilbarcoStatus, TransactionData};

/// Classify the status byte from a pump's 2-byte status response.
pub fn parse_status_byte(b: u8) -> GilbarcoStatus {
    match b {
        0x61..=0x6F => GilbarcoStatus::Idle,
        0x71..=0x7F => GilbarcoStatus::NozzleLifted,
        0x81..=0x8F => GilbarcoStatus::Authorized,
        0x91..=0x9F => GilbarcoStatus::Delivering,
        0xA1..=0xBF => GilbarcoStatus::TransactionComplete,
        0xC1..=0xCF => GilbarcoStatus::Stopped,
        0xD1..=0xDF => GilbarcoStatus::ListenMode,
        _ => GilbarcoStatus::Offline,
    }
}

/// Parse the GetDisplay response (7 bytes): `[status] [6 amount bytes, LSB first]`.
/// Returns the raw BCD integer (no decimal scaling applied).
pub fn parse_display_response(buf: &[u8]) -> Option<u64> {
    if buf.len() < 7 {
        return None;
    }
    Some(decode_bcd_lsb(&buf[1..7]))
}

/// Parse the GetTransaction response (≥31 bytes).
/// Fixed offsets per reference implementation:
/// - unit_price: bytes 13..17 (4 bytes, LSB first)
/// - volume:     bytes 18..24 (6 bytes, LSB first)
/// - amount:     bytes 25..31 (6 bytes, LSB first)
pub fn parse_transaction_response(buf: &[u8]) -> Option<TransactionData> {
    if buf.len() < 31 {
        return None;
    }
    Some(TransactionData {
        unit_price_raw: decode_bcd_lsb(&buf[13..17]),
        volume_raw: decode_bcd_lsb(&buf[18..24]),
        amount_raw: decode_bcd_lsb(&buf[25..31]),
    })
}

/// Parse the GetNozzle response (28 bytes) → 1-based nozzle index.
/// Nozzle identifier is at byte offset 23: 0xB1=nozzle 1, 0xB2=nozzle 2, etc.
pub fn parse_nozzle_response(buf: &[u8]) -> Option<u8> {
    if buf.len() < 28 {
        return None;
    }
    match buf[23] {
        0xB1 => Some(1),
        0xB2 => Some(2),
        0xB3 => Some(3),
        0xB4 => Some(4),
        _ => None,
    }
}

/// Decode Gilbarco LSB-first BCD bytes (each byte = `0xEd` where `d` is one decimal digit).
fn decode_bcd_lsb(bytes: &[u8]) -> u64 {
    // bytes[0] = least-significant digit; iterate in reverse for MSB-first accumulation
    bytes
        .iter()
        .rev()
        .fold(0u64, |acc, &b| acc * 10 + (b & 0x0F) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_ranges() {
        assert_eq!(parse_status_byte(0x61), GilbarcoStatus::Idle);
        assert_eq!(parse_status_byte(0x6F), GilbarcoStatus::Idle);
        assert_eq!(parse_status_byte(0x71), GilbarcoStatus::NozzleLifted);
        assert_eq!(parse_status_byte(0x7F), GilbarcoStatus::NozzleLifted);
        assert_eq!(parse_status_byte(0x81), GilbarcoStatus::Authorized);
        assert_eq!(parse_status_byte(0x91), GilbarcoStatus::Delivering);
        assert_eq!(parse_status_byte(0x9F), GilbarcoStatus::Delivering);
        assert_eq!(parse_status_byte(0xA1), GilbarcoStatus::TransactionComplete);
        assert_eq!(parse_status_byte(0xBF), GilbarcoStatus::TransactionComplete);
        assert_eq!(parse_status_byte(0xC1), GilbarcoStatus::Stopped);
        assert_eq!(parse_status_byte(0xCF), GilbarcoStatus::Stopped);
        assert_eq!(parse_status_byte(0xD1), GilbarcoStatus::ListenMode);
        assert_eq!(parse_status_byte(0xDF), GilbarcoStatus::ListenMode);
        assert_eq!(parse_status_byte(0xFF), GilbarcoStatus::Offline);
        assert_eq!(parse_status_byte(0x00), GilbarcoStatus::Offline);
    }

    #[test]
    fn decode_bcd_lsb_30000() {
        // 30.000 L with 3 dp → raw 30000
        // bytes LSB first: d0=0, d1=0, d2=0, d3=0, d4=3, d5=0
        let bytes = [0xE0, 0xE0, 0xE0, 0xE0, 0xE3, 0xE0];
        assert_eq!(decode_bcd_lsb(&bytes), 30000);
    }

    #[test]
    fn decode_bcd_lsb_123456() {
        // 123456 raw
        let bytes = [0xE6, 0xE5, 0xE4, 0xE3, 0xE2, 0xE1];
        assert_eq!(decode_bcd_lsb(&bytes), 123456);
    }

    #[test]
    fn parse_nozzle_codes() {
        let mut buf = [0u8; 28];
        buf[23] = 0xB1;
        assert_eq!(parse_nozzle_response(&buf), Some(1));
        buf[23] = 0xB3;
        assert_eq!(parse_nozzle_response(&buf), Some(3));
        buf[23] = 0xB0;
        assert_eq!(parse_nozzle_response(&buf), None);
    }
}
