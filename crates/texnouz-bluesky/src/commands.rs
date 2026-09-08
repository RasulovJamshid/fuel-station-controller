//! Command codes and request builders (разд. 6).
//!
//! Every builder takes the hose address (`ADDR = base + hose number`, разд. 3).
//! Builders that encode a number return `None` when the value does not fit its
//! BCD field, so an out-of-range price or dose is refused here rather than being
//! truncated on the wire.

use crate::codec::{build_request, encode_bcd};

// ── Command codes ────────────────────────────────────────────────────────────

/// Read pump state; reply is one byte of status bits (разд. 7).
pub const READ_STATUS: u8 = 0xD5;
/// Read dispense data; reply is 4 B volume + 4 B amount.
pub const READ_FILL: u8 = 0xD9;
/// Read unit price; reply is 3 B price.
pub const READ_PRICE: u8 = 0xB6;
/// Write unit price; 3 B price, status reply.
pub const WRITE_PRICE: u8 = 0xB2;
/// Preset dose by money; 4 B amount, general reply.
pub const DOSE_BY_AMOUNT: u8 = 0xB5;
/// Preset dose by volume; 4 B of 0.01 L, general reply.
pub const DOSE_BY_VOLUME: u8 = 0xB9;
/// Start dispensing; status reply, succeeds only when a dose is set.
pub const START: u8 = 0xC3;
/// Stop dispensing; answered only while a fill is running.
pub const STOP: u8 = 0xCA;
/// Pause dispensing.
pub const PAUSE: u8 = 0xBA;
/// Resume a paused fill.
pub const RESUME: u8 = 0xB3;
/// Read lifetime totalizer; 6 B volume + 6 B amount.
pub const READ_TOTAL: u8 = 0xC5;
/// Read shift totalizer; 6 B volume + 6 B amount.
pub const READ_SHIFT: u8 = 0xC7;
/// Clear the shift totalizer.
pub const CLEAR_SHIFT: u8 = 0xEA;
/// Take remote control of the pump.
pub const TAKE_CONTROL: u8 = 0xE5;
/// Hand control back to the pump keypad.
pub const RELEASE_CONTROL: u8 = 0xE7;
/// Select the active hose; 1 B hose address, status reply.
pub const SELECT_HOSE: u8 = 0xA1;
/// Read the pending preset; 1 B type + 4 B value.
pub const READ_PRESET: u8 = 0xA7;
/// Read card ID; 4 B.
pub const READ_CARD_ID: u8 = 0xA8;
/// Read error code; 1 B (0 = no error).
pub const READ_ERROR: u8 = 0xA9;
/// Read device ID; 4 B.
pub const READ_DEVICE_ID: u8 = 0xD7;
/// Clear the "dose set from keypad" flag.
pub const CLEAR_KEYPAD_PRESET: u8 = 0xAA;
/// Clear the latched error flag; status reply.
pub const CLEAR_ERROR: u8 = 0xAB;
/// Read solenoid state; 2 B.
pub const READ_VALVE: u8 = 0xD6;
/// Write solenoid state; 1 B, status reply.
pub const WRITE_VALVE: u8 = 0xD2;

// ── Field widths (разд. 5) ───────────────────────────────────────────────────

/// Price field: 3 BCD bytes, per litre.
pub const PRICE_BYTES: usize = 3;
/// Volume and money fields: 4 BCD bytes.
pub const FILL_BYTES: usize = 4;
/// Totalizer fields: 6 BCD bytes.
pub const TOTALS_BYTES: usize = 6;

/// Largest price the 3-byte field can carry (разд. 5: макс. 99999).
pub const MAX_PRICE: u64 = 99_999;
/// Largest dose either 4-byte field can carry.
pub const MAX_DOSE: u64 = 99_999_999;

/// Requests that carry no payload are all the same shape; `unwrap` is safe
/// because an empty payload always fits the length nibble.
fn bare(addr: u8, cmd: u8) -> Vec<u8> {
    build_request(addr, cmd, &[]).expect("empty payload always fits")
}

/// Poll pump state (0xD5). Must be sent to every hose more often than the
/// device's 5 s link timeout (разд. 2).
pub fn read_status(addr: u8) -> Vec<u8> {
    bare(addr, READ_STATUS)
}

/// Read live or final dispense data (0xD9).
pub fn read_fill(addr: u8) -> Vec<u8> {
    bare(addr, READ_FILL)
}

/// Read the configured unit price (0xB6).
pub fn read_price(addr: u8) -> Vec<u8> {
    bare(addr, READ_PRICE)
}

/// Write the unit price (0xB2). `None` if it exceeds [`MAX_PRICE`].
pub fn write_price(addr: u8, price: u64) -> Option<Vec<u8>> {
    if price > MAX_PRICE {
        return None;
    }
    build_request(addr, WRITE_PRICE, &encode_bcd(price, PRICE_BYTES)?)
}

/// Preset a dose by money (0xB5). `None` if it exceeds [`MAX_DOSE`].
pub fn dose_by_amount(addr: u8, amount: u64) -> Option<Vec<u8>> {
    if amount > MAX_DOSE {
        return None;
    }
    build_request(addr, DOSE_BY_AMOUNT, &encode_bcd(amount, FILL_BYTES)?)
}

/// Preset a dose by volume (0xB9), in 0.01 L units. `None` if it exceeds
/// [`MAX_DOSE`].
pub fn dose_by_volume(addr: u8, centilitres: u64) -> Option<Vec<u8>> {
    if centilitres > MAX_DOSE {
        return None;
    }
    build_request(addr, DOSE_BY_VOLUME, &encode_bcd(centilitres, FILL_BYTES)?)
}

/// Start dispensing (0xC3). Only succeeds once a dose is set (разд. 6).
pub fn start(addr: u8) -> Vec<u8> {
    bare(addr, START)
}

/// Stop dispensing (0xCA). Answered only while a fill is running.
pub fn stop(addr: u8) -> Vec<u8> {
    bare(addr, STOP)
}

/// Pause the current fill (0xBA).
pub fn pause(addr: u8) -> Vec<u8> {
    bare(addr, PAUSE)
}

/// Resume a paused fill (0xB3).
pub fn resume(addr: u8) -> Vec<u8> {
    bare(addr, RESUME)
}

/// Read the lifetime totalizer (0xC5).
pub fn read_total(addr: u8) -> Vec<u8> {
    bare(addr, READ_TOTAL)
}

/// Read the shift totalizer (0xC7).
pub fn read_shift(addr: u8) -> Vec<u8> {
    bare(addr, READ_SHIFT)
}

/// Clear the shift totalizer (0xEA).
pub fn clear_shift(addr: u8) -> Vec<u8> {
    bare(addr, CLEAR_SHIFT)
}

/// Take remote control (0xE5) — required before the pump honours commands.
pub fn take_control(addr: u8) -> Vec<u8> {
    bare(addr, TAKE_CONTROL)
}

/// Return control to the pump keypad (0xE7).
pub fn release_control(addr: u8) -> Vec<u8> {
    bare(addr, RELEASE_CONTROL)
}

/// Select the active hose (0xA1) by its bus address.
pub fn select_hose(addr: u8, hose_addr: u8) -> Vec<u8> {
    build_request(addr, SELECT_HOSE, &[hose_addr]).expect("one byte always fits")
}

/// Read the pending preset (0xA7).
pub fn read_preset(addr: u8) -> Vec<u8> {
    bare(addr, READ_PRESET)
}

/// Read the latched error code (0xA9); `0` means no error.
pub fn read_error(addr: u8) -> Vec<u8> {
    bare(addr, READ_ERROR)
}

/// Clear the latched error flag (0xAB).
pub fn clear_error(addr: u8) -> Vec<u8> {
    bare(addr, CLEAR_ERROR)
}

/// Clear the "dose set from keypad" flag (0xAA).
pub fn clear_keypad_preset(addr: u8) -> Vec<u8> {
    bare(addr, CLEAR_KEYPAD_PRESET)
}

/// Read the device ID (0xD7).
pub fn read_device_id(addr: u8) -> Vec<u8> {
    bare(addr, READ_DEVICE_ID)
}

/// Read the card ID (0xA8).
pub fn read_card_id(addr: u8) -> Vec<u8> {
    bare(addr, READ_CARD_ID)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{decode_response, Response};

    #[test]
    fn spec_frames_match_byte_for_byte() {
        // разд. 8, все три примера.
        assert_eq!(read_status(0x01), vec![0xF5, 0x01, 0xA2, 0xD5, 0x03]);
        assert_eq!(
            write_price(0x01, 5450).unwrap(),
            vec![0xF5, 0x01, 0xA5, 0x00, 0x54, 0x50, 0xB2, 0x67]
        );
        assert_eq!(
            dose_by_volume(0x01, 5000).unwrap(),
            vec![0xF5, 0x01, 0xA6, 0x00, 0x00, 0x50, 0x00, 0xB9, 0x3B]
        );
    }

    #[test]
    fn every_bare_command_is_a_five_byte_frame() {
        for f in [
            read_status(3),
            read_fill(3),
            read_price(3),
            start(3),
            stop(3),
            pause(3),
            resume(3),
            read_total(3),
            read_shift(3),
            clear_shift(3),
            take_control(3),
            release_control(3),
            read_preset(3),
            read_error(3),
            clear_error(3),
            clear_keypad_preset(3),
            read_device_id(3),
            read_card_id(3),
        ] {
            assert_eq!(f.len(), 5, "bare frame must be exactly 5 bytes: {f:02X?}");
            assert_eq!(f[2], 0xA2, "bare frame length nibble must be 2");
            assert!(decode_response(3, &f).is_some(), "own frame must validate");
        }
    }

    #[test]
    fn out_of_range_values_are_refused_not_truncated() {
        assert!(write_price(1, MAX_PRICE).is_some());
        assert_eq!(write_price(1, MAX_PRICE + 1), None);
        assert!(dose_by_volume(1, MAX_DOSE).is_some());
        assert_eq!(dose_by_volume(1, MAX_DOSE + 1), None);
        assert!(dose_by_amount(1, MAX_DOSE).is_some());
        assert_eq!(dose_by_amount(1, MAX_DOSE + 1), None);
    }

    #[test]
    fn commands_address_the_requested_hose() {
        for addr in [0x01u8, 0x0A, 0x7F, 0xFE] {
            let f = read_status(addr);
            assert_eq!(f[1], addr);
            assert_eq!(decode_response(addr, &f).unwrap().cmd(), READ_STATUS);
        }
    }

    #[test]
    fn select_hose_carries_the_target_address() {
        let f = select_hose(0x01, 0x03);
        match decode_response(0x01, &f).unwrap() {
            Response::Data { cmd, data } => {
                assert_eq!(cmd, SELECT_HOSE);
                assert_eq!(data, vec![0x03]);
            }
            other => panic!("expected data frame, got {other:?}"),
        }
    }

    #[test]
    fn dose_encodes_hundredths_of_a_litre() {
        // 12.34 L → 1234 сотых.
        let f = dose_by_volume(0x01, 1234).unwrap();
        assert_eq!(&f[3..7], &[0x00, 0x00, 0x12, 0x34]);
    }
}
