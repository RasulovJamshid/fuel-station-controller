use crate::lrc::gilbarco_lrc;

// ── Single-byte commands ──────────────────────────────────────────────────────

/// Status request: `[addr]`.
pub fn status(addr: u8) -> [u8; 1] {
    [addr]
}

/// Authorize fueling position: `[addr + 16]`.
pub fn authorize(addr: u8) -> [u8; 1] {
    [addr.wrapping_add(16)]
}

/// Enter listen mode: `[addr + 32]`.
/// Required before SetPrice, GetNozzle, or PresetAmount.
pub fn listen_mode(addr: u8) -> [u8; 1] {
    [addr.wrapping_add(32)]
}

/// Halt pump: `[addr + 48]`.
pub fn halt(addr: u8) -> [u8; 1] {
    [addr.wrapping_add(48)]
}

/// Request final transaction data: `[addr + 64]`.
pub fn get_transaction(addr: u8) -> [u8; 1] {
    [addr.wrapping_add(64)]
}

/// Request accumulated pump totals: `[addr + 80]`.
pub fn get_totals(addr: u8) -> [u8; 1] {
    [addr.wrapping_add(80)]
}

/// Request live display data during delivery: `[addr + 96]`.
pub fn get_display(addr: u8) -> [u8; 1] {
    [addr.wrapping_add(96)]
}

// ── Multi-byte commands ───────────────────────────────────────────────────────

/// Query which nozzle is currently lifted.
/// Pump must already be in listen mode (response 0xD1..0xDF) before sending.
pub fn get_nozzle() -> [u8; 9] {
    [0xFF, 0xE9, 0xFE, 0xE0, 0xE1, 0xE0, 0xFB, 0xEE, 0xF0]
}

/// Build a SetPrice frame for the given 1-based nozzle index and price integer.
///
/// `price_int` is the raw integer as used by the pump's internal price register
/// (typically 4 digits max, e.g. 1050 → 10.50 per litre with 2 dp on the pump).
/// The value must match the price scale the pump is configured for.
///
/// Frame layout: `FF E5 F4 F6 [NozzleID=223+idx] F7 [p_lsb..p_msb] FB [LRC] F0`
pub fn set_price(nozzle_index: u8, price_int: u32) -> Vec<u8> {
    let nozzle_id = 223u8.wrapping_add(nozzle_index);
    let digits = encode_4digit(price_int);
    // digits[0] = LSB (units), digits[3] = MSB (thousands)
    let cmd: Vec<u8> = vec![
        0xFF, 0xE5, 0xF4, 0xF6, nozzle_id, 0xF7,
        digits[0], digits[1], digits[2], digits[3], // units first (LSB-first per protocol)
        0xFB,
    ];
    let lrc = gilbarco_lrc(&cmd);
    let mut buf = cmd;
    buf.push(lrc);
    buf.push(0xF0);
    buf
}

/// Build a PresetAmount frame (money preset).
///
/// `amount_int`: raw 5-digit amount integer in the pump's currency scale.
pub fn preset_amount(amount_int: u32) -> Vec<u8> {
    let digits = encode_5digit(amount_int);
    let cmd: Vec<u8> = vec![
        0xFF, 0xE6, 0xF2, 0xF8,
        digits[0], digits[1], digits[2], digits[3], digits[4], // units first (LSB-first)
        0xFB,
    ];
    let lrc = gilbarco_lrc(&cmd);
    let mut buf = cmd;
    buf.push(lrc);
    buf.push(0xF0);
    buf
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

/// Encode a 4-digit integer as 4 Gilbarco data bytes (0xE0|digit), index 0 = LSB.
pub fn encode_4digit(val: u32) -> [u8; 4] {
    [
        0xE0 | ((val) % 10) as u8,
        0xE0 | ((val / 10) % 10) as u8,
        0xE0 | ((val / 100) % 10) as u8,
        0xE0 | ((val / 1000) % 10) as u8,
    ]
}

/// Encode a 5-digit integer as 5 Gilbarco data bytes (0xE0|digit), index 0 = LSB.
pub fn encode_5digit(val: u32) -> [u8; 5] {
    [
        0xE0 | ((val) % 10) as u8,
        0xE0 | ((val / 10) % 10) as u8,
        0xE0 | ((val / 100) % 10) as u8,
        0xE0 | ((val / 1000) % 10) as u8,
        0xE0 | ((val / 10000) % 10) as u8,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_byte_commands() {
        assert_eq!(status(0), [0x00]);
        assert_eq!(authorize(0), [0x10]);
        assert_eq!(listen_mode(0), [0x20]);
        assert_eq!(halt(0), [0x30]);
        assert_eq!(get_transaction(0), [0x40]);
        assert_eq!(get_totals(0), [0x50]);
        assert_eq!(get_display(0), [0x60]);

        assert_eq!(status(2), [0x02]);
        assert_eq!(authorize(2), [0x12]);
        assert_eq!(halt(2), [0x32]);
    }

    #[test]
    fn encode_4digit_values() {
        let d = encode_4digit(1234);
        // index 0 = units digit = 4, index 3 = thousands digit = 1
        assert_eq!(d, [0xE4, 0xE3, 0xE2, 0xE1]);
        let d0 = encode_4digit(0);
        assert_eq!(d0, [0xE0, 0xE0, 0xE0, 0xE0]);
    }

    #[test]
    fn set_price_frame_structure() {
        let frame = set_price(1, 1050);
        // NozzleID = 223 + 1 = 224 = 0xE0
        assert_eq!(frame[0], 0xFF);
        assert_eq!(frame[4], 0xE0); // nozzle id
        assert_eq!(frame[5], 0xF7); // price header
        // Last byte is always 0xF0
        assert_eq!(*frame.last().unwrap(), 0xF0);
        // Second-to-last is LRC (0xE0..0xEF)
        let lrc = frame[frame.len() - 2];
        assert!((0xE0..=0xEF).contains(&lrc));
    }
}
