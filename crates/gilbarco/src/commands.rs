use crate::lrc::gilbarco_lrc;

// ── Single-byte commands ──────────────────────────────────────────────────────

/// Poll pump status: send `[addr]`, pump responds with its current state byte.
pub fn status(addr: u8) -> [u8; 1] {
    [addr]
}

/// Request live display data during delivery: `0x60 | addr`.
///
/// Pump responds with 6 E-prefixed bytes: `E{d0}..E{d5}`.
/// Decode with `parse_display_response` as an amount counter in units of 10 soum.
pub fn get_display(addr: u8) -> [u8; 1] {
    [0x60 | (addr & 0x0F)]
}

/// Request final transaction record (first frame): `0x40 | addr`.
///
/// Pump responds with a 33-byte frame starting `FF`.
/// Decoded by `parse_transaction_response`.
pub fn get_transaction(addr: u8) -> [u8; 1] {
    [0x40 | (addr & 0x0F)]
}

/// Request totals/secondary frame: `0x50 | addr`.
///
/// ASFuelControl names this command `GetTotals`; decode with `parse_totals_response`.
pub fn get_transaction2(addr: u8) -> [u8; 1] {
    [0x50 | (addr & 0x0F)]
}

/// Request accumulated per-nozzle totals: `0x50 | addr`.
pub fn get_totals(addr: u8) -> [u8; 1] {
    get_transaction2(addr)
}

/// Query which nozzle is currently lifted.
///
/// Send `[0x20 | addr, 0xFF]` as a two-byte command.
/// Pump responds: `0xD0|addr` (ack) + `FF` (frame start) + 7 bytes (nozzle data + LRC).
/// Full raw response is `[0x20|addr, 0xD0|addr, 0xFF, <6-bytes>, <LRC>]` = 10 bytes
/// before echo stripping; see `parse_nozzle_response`.
pub fn get_nozzle(addr: u8) -> [u8; 2] {
    [0x20 | (addr & 0x0F), 0xFF]
}

/// Request all-pump status: `F0`.
///
/// Pump responds with a 19-byte frame encoding the status of all pump addresses.
/// Used for initialization and periodic bus health checks.
pub fn get_all() -> [u8; 1] {
    [0xF0]
}

/// Authorize pump to start fueling: `0x10 | addr`.
///
/// Confirmed from all 9600 fill logs: PC sends this automatically ~20ms after
/// detecting NozzleLifted (`0x70|addr`). Pump transitions to Delivering (`0x90|addr`)
/// on the very next poll.
///
/// Amount/volume presets are sent separately with `preset_amount` before this byte.
pub fn authorize(addr: u8) -> [u8; 1] {
    [0x10 | (addr & 0x0F)]
}

/// Halt pump mid-delivery: `0x30 | addr`.
///
/// Confirmed from log `maybe9600_fill_midfillstop_from_app.log`: PC transmits `0x32`
/// (addr=2) during a Delivering (`0x92`) → Stopped (`0xC2`) transition triggered by
/// the app. Next status poll returns `0xC0|addr` (Stopped). No pump ack byte is sent;
/// effect is confirmed by the subsequent poll.
pub fn halt(addr: u8) -> [u8; 1] {
    [0x30 | (addr & 0x0F)]
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

/// Encode a 6-digit integer as 6 Gilbarco data bytes (0xE0|digit), index 0 = LSB.
pub fn encode_6digit(val: u32) -> [u8; 6] {
    [
        0xE0 | ((val) % 10) as u8,
        0xE0 | ((val / 10) % 10) as u8,
        0xE0 | ((val / 100) % 10) as u8,
        0xE0 | ((val / 1000) % 10) as u8,
        0xE0 | ((val / 10000) % 10) as u8,
        0xE0 | ((val / 100000) % 10) as u8,
    ]
}

/// Build a set-price frame for a 1-based nozzle.
///
/// Confirmed from `30L_AI92RUS_2NDPUMP_100000SUM_AI92RUS_3RDPUMP.log`:
/// `FF E5 F4 F6 E0 F7 E0 E3 E1 E1 FB EB F0` sets nozzle 1 price raw 1130
/// (11300 sum/L on this site).
pub fn set_price(nozzle_index: u8, price_raw: u32) -> Vec<u8> {
    let nozzle_id = 0xDFu8.wrapping_add(nozzle_index);
    let digits = encode_4digit(price_raw);
    let mut frame = vec![
        0xFF, 0xE5, 0xF4, 0xF6, nozzle_id, 0xF7, digits[0], digits[1], digits[2], digits[3], 0xFB,
    ];
    frame.push(gilbarco_lrc(&frame));
    frame.push(0xF0);
    frame
}

/// Build a money preset frame.
///
/// `amount_raw` is real amount / 10, matching live display and final transaction
/// amount scale. Confirmed frames:
/// - 339000 sum -> raw 33900 -> `FF E5 F2 F8 E0 E0 E9 E3 E3 E0 FB E8 F0`
/// - 100000 sum -> raw 10000 -> `FF E5 F2 F8 E0 E0 E0 E0 E1 E0 FB E6 F0`
pub fn preset_amount(amount_raw: u32) -> Vec<u8> {
    let digits = encode_6digit(amount_raw);
    let mut frame = vec![
        0xFF, 0xE5, 0xF2, 0xF8, digits[0], digits[1], digits[2], digits[3], digits[4], digits[5],
        0xFB,
    ];
    frame.push(gilbarco_lrc(&frame));
    frame.push(0xF0);
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_byte() {
        assert_eq!(status(0x01), [0x01]);
        assert_eq!(status(0x03), [0x03]);
    }

    #[test]
    fn get_display_bytes() {
        // addr 02 → 0x60|0x02 = 0x62
        assert_eq!(get_display(0x02), [0x62]);
        // addr 03 → 0x60|0x03 = 0x63
        assert_eq!(get_display(0x03), [0x63]);
    }

    #[test]
    fn get_transaction_bytes() {
        // addr 02 → 0x40|0x02 = 0x42
        assert_eq!(get_transaction(0x02), [0x42]);
        // addr 03 → 0x40|0x03 = 0x43
        assert_eq!(get_transaction(0x03), [0x43]);
    }

    #[test]
    fn get_transaction2_bytes() {
        assert_eq!(get_transaction2(0x02), [0x52]);
        assert_eq!(get_transaction2(0x03), [0x53]);
        assert_eq!(get_totals(0x02), [0x52]);
    }

    #[test]
    fn get_nozzle_bytes() {
        // addr 02 → [0x22, 0xFF]
        assert_eq!(get_nozzle(0x02), [0x22, 0xFF]);
        // addr 03 → [0x23, 0xFF]
        assert_eq!(get_nozzle(0x03), [0x23, 0xFF]);
    }

    #[test]
    fn get_all_byte() {
        assert_eq!(get_all(), [0xF0]);
    }

    #[test]
    fn authorize_bytes() {
        // Confirmed from all 9600 fill logs: every NozzleLifted is followed by 0x1N
        assert_eq!(authorize(0x02), [0x12]);
        assert_eq!(authorize(0x03), [0x13]);
    }

    #[test]
    fn halt_bytes() {
        // Confirmed from log: addr 2 → 0x32, addr 1 → 0x31
        assert_eq!(halt(0x02), [0x32]);
        assert_eq!(halt(0x01), [0x31]);
    }

    #[test]
    fn encode_4digit_values() {
        let d = encode_4digit(1234);
        assert_eq!(d, [0xE4, 0xE3, 0xE2, 0xE1]);
        assert_eq!(encode_4digit(0), [0xE0, 0xE0, 0xE0, 0xE0]);
    }

    #[test]
    fn set_price_frame_from_preset_log() {
        assert_eq!(
            set_price(1, 1130),
            vec![0xFF, 0xE5, 0xF4, 0xF6, 0xE0, 0xF7, 0xE0, 0xE3, 0xE1, 0xE1, 0xFB, 0xEB, 0xF0]
        );
    }

    #[test]
    fn preset_amount_frames_from_preset_log() {
        assert_eq!(
            preset_amount(33900),
            vec![0xFF, 0xE5, 0xF2, 0xF8, 0xE0, 0xE0, 0xE9, 0xE3, 0xE3, 0xE0, 0xFB, 0xE8, 0xF0]
        );
        assert_eq!(
            preset_amount(10000),
            vec![0xFF, 0xE5, 0xF2, 0xF8, 0xE0, 0xE0, 0xE0, 0xE0, 0xE1, 0xE0, 0xFB, 0xE6, 0xF0]
        );
        assert_eq!(
            preset_amount(0),
            vec![0xFF, 0xE5, 0xF2, 0xF8, 0xE0, 0xE0, 0xE0, 0xE0, 0xE0, 0xE0, 0xFB, 0xE7, 0xF0]
        );
    }
}
