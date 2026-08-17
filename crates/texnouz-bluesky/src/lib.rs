//! TexnoUz "Дополненный протокол BlueSky" codec (controller TU_WB_KEY,
//! ПО KV01.01.0014).
//!
//! RS-485 half-duplex, **9600 8E1**, strict master–slave: the control system
//! initiates every exchange and the pump never speaks unprompted (разд. 1, 2).
//!
//! Frames are `F5 | ADDR | 0xA0|LEN | DATA… | CMD | CRC` — see [`codec`].
//! Command builders live in [`commands`], reply parsing in [`parser`], decoded
//! types in [`frame`].
//!
//! Like the AZT crate, this is transport-agnostic and hardware-independent: it
//! only builds and parses byte buffers, so it is fully unit-testable and cannot
//! affect any other protocol.
//!
//! # Addressing
//!
//! Each hose has its own bus address, `ADDR = base device address + hose number`
//! (разд. 3). The base address is set in the pump's own menu, so several pumps
//! can share one bus. The device ignores frames for addresses it does not own.
//!
//! # Timing
//!
//! The pump treats the link as lost after **5 s** without a request, so every
//! configured hose must be polled more often than that. A reply is expected
//! within 200–500 ms; silence means the frame was dropped (bad CRC, wrong
//! precode or foreign address are never answered) and the request should be
//! repeated (разд. 9).

pub mod codec;
pub mod commands;
pub mod frame;
pub mod parser;

pub use codec::{
    build_request, crc, decode_bcd, decode_response, encode_bcd, take_frame, Response, LEN_HIGH,
    MAX_DATA_LEN, MIN_FRAME_LEN, PRECODE, STATE_ERR, STATE_OK,
};
pub use commands::{
    clear_error, clear_keypad_preset, clear_shift, dose_by_amount, dose_by_volume, pause,
    read_card_id, read_device_id, read_error, read_fill, read_preset, read_price, read_shift,
    read_status, read_total, release_control, resume, select_hose, start, stop, take_control,
    write_price, FILL_BYTES, MAX_DOSE, MAX_PRICE, PRICE_BYTES, TOTALS_BYTES,
};
pub use frame::{BlueSkyStatus, FillData, PresetReadback, Totals};
pub use parser::{
    parse_error_code, parse_fill, parse_id, parse_preset, parse_price, parse_status, parse_totals,
};

/// Wire money unit expressed in soum.
///
/// The 3-byte price field holds up to 99 999 per litre (разд. 5), which covers
/// realistic soum prices (~11 300/L) directly, so this crate assumes **1 wire
/// unit = 1 soum** — unlike AZT, whose 4-digit field forces a ×10 convention.
///
/// The specification says only "денежные единицы" and does not fix the scale, so
/// this is the natural reading rather than a documented fact. It needs one
/// confirmation against real hardware or a printed receipt before production use.
pub const WIRE_MONEY_UNIT: u64 = 1;

/// Volume wire unit: hundredths of a litre (разд. 5).
pub const VOLUME_CENTILITRES_PER_LITRE: u64 = 100;

/// Hose bus address from the pump's base address and hose number (разд. 3).
pub fn hose_address(base: u8, hose_number: u8) -> u8 {
    base.wrapping_add(hose_number)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hose_addresses_follow_base_plus_number() {
        assert_eq!(hose_address(0x00, 1), 0x01);
        assert_eq!(hose_address(0x10, 3), 0x13);
    }

    /// End-to-end sanity: build a request, then decode a plausible reply for it.
    #[test]
    fn price_round_trips_through_wire_format() {
        let req = write_price(0x01, 11_300).unwrap();
        assert_eq!(&req[3..6], &[0x01, 0x13, 0x00]);

        let mut reply = vec![PRECODE, 0x01, 0xA5, 0x01, 0x13, 0x00, commands::READ_PRICE];
        reply.push(crc(&reply));
        let r = decode_response(0x01, &reply).unwrap();
        assert_eq!(parse_price(r.data()).unwrap(), 11_300);
    }
}
