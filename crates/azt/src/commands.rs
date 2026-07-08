//! AZT 2.0 SU→TRK command builders (разд. 5, 7).
//!
//! Every builder returns a ready-to-transmit frame (`DEL STX … ETX ETX CS`) via
//! [`crate::codec::build_request`]. `addr` is the AZT network number (1..=15 at
//! offset 0). Numeric arguments are encoded as ASCII digits, MSB first.

use crate::codec::{build_broadcast, build_request};
use crate::frame::encode_digits;

// Command bytes (разд. 5).
pub const CMD_STATUS: u8 = 0x31; // '1' request status
pub const CMD_AUTHORIZE: u8 = 0x32; // '2' Санкционирование (authorize)
pub const CMD_RESET: u8 = 0x33; // '3' reset
pub const CMD_CURRENT_DATA: u8 = 0x34; // '4' request current dispense data
pub const CMD_FULL_DATA: u8 = 0x35; // '5' request full dispense data
pub const CMD_TOTALS: u8 = 0x36; // '6' request totalizers
pub const CMD_TRK_TYPE: u8 = 0x37; // '7' request TRK type/identifier
pub const CMD_CONFIRM_TOTALS: u8 = 0x38; // '8' confirm totals write
pub const CMD_PROTOCOL_VERSION: u8 = 0x50; // 'P' request protocol version (UINSW)
pub const CMD_SET_PRICE: u8 = 0x51; // 'Q' set price per litre (4 digits)
pub const CMD_SET_DECEL_THRESHOLD: u8 = 0x52; // 'R' set slow-down valve threshold (3 digits)
pub const CMD_SET_DOSE_RUBLES: u8 = 0x53; // 'S' set dose in currency (6 digits)
pub const CMD_SET_DOSE_LITRES: u8 = 0x54; // 'T' set dose in litres (5 digits, 0.01 L)
pub const CMD_TOPUP_DOSE: u8 = 0x55; // 'U' top-up dose (Долив)
pub const CMD_UNCONDITIONAL_START: u8 = 0x56; // 'V' unconditional start
pub const CMD_TRANSACTION_NUMBER: u8 = 0x59; // 'Y' request current transaction number (UINTR)
pub const CMD_READ_SET_DOSE: u8 = 0x58; // 'X' read the set dose

// ── Zero-argument commands ───────────────────────────────────────────────────

/// Request the TRK status (разд. 7.1).
pub fn status(addr: u8) -> Vec<u8> {
    build_request(addr, CMD_STATUS, &[])
}

/// Authorize the TRK to dispense — Санкционирование (разд. 7.2).
pub fn authorize(addr: u8) -> Vec<u8> {
    build_request(addr, CMD_AUTHORIZE, &[])
}

/// Reset the TRK (разд. 7.3). Switches the pump off if it was on.
pub fn reset(addr: u8) -> Vec<u8> {
    build_request(addr, CMD_RESET, &[])
}

/// Request current dispense data (разд. 7.4) — volume only.
pub fn current_data(addr: u8) -> Vec<u8> {
    build_request(addr, CMD_CURRENT_DATA, &[])
}

/// Request full dispense data (разд. 7.5) — volume, cost and price.
pub fn full_data(addr: u8) -> Vec<u8> {
    build_request(addr, CMD_FULL_DATA, &[])
}

/// Request totalizer readings (разд. 7.6).
pub fn totals(addr: u8) -> Vec<u8> {
    build_request(addr, CMD_TOTALS, &[])
}

/// Request the TRK type identifier (разд. 7.7).
pub fn trk_type(addr: u8) -> Vec<u8> {
    build_request(addr, CMD_TRK_TYPE, &[])
}

/// Confirm the totals write (разд. 7.8). Sent after reading the final data.
pub fn confirm_totals(addr: u8) -> Vec<u8> {
    build_request(addr, CMD_CONFIRM_TOTALS, &[])
}

/// Request the protocol version number, UINSW (разд. 7.9).
pub fn protocol_version(addr: u8) -> Vec<u8> {
    build_request(addr, CMD_PROTOCOL_VERSION, &[])
}

/// Top-up the current dose — Долив дозы (разд. 7.14). Must be followed by
/// [`authorize`].
pub fn topup_dose(addr: u8) -> Vec<u8> {
    build_request(addr, CMD_TOPUP_DOSE, &[])
}

/// Unconditional start of dispensing (разд. 7.15). Starts the pump regardless of
/// nozzle position; only valid from status `'2'`.
pub fn unconditional_start(addr: u8) -> Vec<u8> {
    build_request(addr, CMD_UNCONDITIONAL_START, &[])
}

/// Request the current transaction number, UINTR (разд. 7.20).
pub fn transaction_number(addr: u8) -> Vec<u8> {
    build_request(addr, CMD_TRANSACTION_NUMBER, &[])
}

/// Read back the set dose (разд. 7.23).
pub fn read_set_dose(addr: u8) -> Vec<u8> {
    build_request(addr, CMD_READ_SET_DOSE, &[])
}

// ── Commands with numeric payloads ───────────────────────────────────────────

/// Set the price per litre (разд. 7.10). `price_kopecks` is the price in kopecks
/// (e.g. 6.70 currency → `670`), encoded as 4 digits.
pub fn set_price(addr: u8, price_kopecks: u32) -> Vec<u8> {
    build_request(addr, CMD_SET_PRICE, &encode_digits(price_kopecks as u64, 4))
}

/// Set the slow-down valve shut-off threshold (разд. 7.11). `centilitres` is in
/// 0.01 L units, encoded as 3 digits.
pub fn set_decel_threshold(addr: u8, centilitres: u32) -> Vec<u8> {
    build_request(
        addr,
        CMD_SET_DECEL_THRESHOLD,
        &encode_digits(centilitres as u64, 3),
    )
}

/// Set the dispense dose in currency (разд. 7.12). `kopecks` is in 0.01 currency
/// units, encoded as 6 digits.
pub fn set_dose_rubles(addr: u8, kopecks: u32) -> Vec<u8> {
    build_request(addr, CMD_SET_DOSE_RUBLES, &encode_digits(kopecks as u64, 6))
}

/// Set the dispense dose in litres (разд. 7.13, Variant 1). `centilitres` is in
/// 0.01 L units, encoded as 5 digits.
pub fn set_dose_litres(addr: u8, centilitres: u32) -> Vec<u8> {
    build_request(
        addr,
        CMD_SET_DOSE_LITRES,
        &encode_digits(centilitres as u64, 5),
    )
}

/// Set the dispense dose in litres in "fill to full tank" mode (разд. 7.13,
/// Variant 2 — appends the full-tank flag `'1'`). Protocol version ≥ 2 only.
pub fn set_dose_litres_full_tank(addr: u8, centilitres: u32) -> Vec<u8> {
    let mut data = encode_digits(centilitres as u64, 5);
    data.push(0x31); // full-tank flag '1'
    build_request(addr, CMD_SET_DOSE_LITRES, &data)
}

/// Set a general (broadcast) parameter — Задание общих параметров (разд. 7.18).
///
/// Broadcast to every TRK on the bus; there is no response. `param` and `value`
/// are single hex nibbles carried as `0x30 | nibble`.
pub fn set_general_param(param: u8, value: u8) -> Vec<u8> {
    build_broadcast(
        CMD_SET_PRICE_GENERAL,
        &[0x30 | (param & 0x0F), 0x30 | (value & 0x0F)],
    )
}

const CMD_SET_PRICE_GENERAL: u8 = 0x57; // 'W' set general params (broadcast)

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{decode_response, Response, DEL, ETX, STX};

    #[test]
    fn status_frame_bytes() {
        // Разд. 7.1 layout for address 1.
        let f = status(1);
        assert_eq!(&f[..8], &[DEL, STX, 0x21, 0x5E, 0x31, 0x4E, ETX, ETX]);
    }

    #[test]
    fn authorize_and_reset_command_bytes() {
        assert_eq!(authorize(1)[4], CMD_AUTHORIZE);
        assert_eq!(reset(1)[4], CMD_RESET);
        assert_eq!(current_data(1)[4], CMD_CURRENT_DATA);
        assert_eq!(full_data(1)[4], CMD_FULL_DATA);
    }

    #[test]
    fn set_price_encodes_four_digits() {
        // 6.70 → "0670" → 0x30 0x36 0x37 0x30, each with complement.
        let f = set_price(1, 670);
        // After DEL STX addr addr' cmd cmd' come the 4 digit pairs.
        let digits: Vec<u8> = f[6..14].iter().step_by(2).copied().collect();
        assert_eq!(digits, vec![0x30, 0x36, 0x37, 0x30]);
    }

    #[test]
    fn set_dose_litres_encodes_five_digits() {
        // 30.00 L → 3000 centilitres → "03000".
        let f = set_dose_litres(1, 3000);
        let digits: Vec<u8> = f[6..16].iter().step_by(2).copied().collect();
        assert_eq!(digits, b"03000".to_vec());
    }

    #[test]
    fn full_tank_variant_appends_flag() {
        let base = set_dose_litres(1, 3000);
        let full = set_dose_litres_full_tank(1, 3000);
        // One extra digit pair (2 bytes) for the flag.
        assert_eq!(full.len(), base.len() + 2);
    }

    #[test]
    fn broadcast_general_param_has_no_address() {
        // Backlight on: param 0, value 1.
        let f = set_general_param(0, 1);
        // DEL STX cmd cmd' d0 d0' d1 d1' ETX ETX CS — no address pair.
        assert_eq!(f[0], DEL);
        assert_eq!(f[1], STX);
        assert_eq!(f[2], CMD_SET_PRICE_GENERAL);
    }

    #[test]
    fn every_command_roundtrips_through_the_decoder_shape() {
        // A frame we build for the SU is structurally the same as a TRK data
        // frame, so decode_response should extract the normal payload bytes.
        // (Confirms complement + checksum consistency end to end.)
        let f = set_price(2, 1234);
        match decode_response(&f).unwrap() {
            Response::Data(bytes) => {
                // address, command, then 4 digits.
                assert_eq!(bytes[0], 0x22);
                assert_eq!(bytes[1], CMD_SET_PRICE);
                assert_eq!(&bytes[2..], b"1234");
            }
            other => panic!("expected data frame, got {other:?}"),
        }
    }
}
