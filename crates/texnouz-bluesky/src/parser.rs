//! Response payload parsers (разд. 6).
//!
//! Every parser validates the payload width before decoding, so a short or
//! corrupted reply yields `None` instead of a plausible-looking number.

use crate::codec::decode_bcd;
use crate::commands::{FILL_BYTES, PRICE_BYTES, TOTALS_BYTES};
use crate::frame::{BlueSkyStatus, FillData, PresetReadback, Totals};

/// Parse the one-byte reply to `READ_STATUS` (0xD5).
pub fn parse_status(data: &[u8]) -> Option<BlueSkyStatus> {
    match data {
        [b] => Some(BlueSkyStatus(*b)),
        _ => None,
    }
}

/// Parse `READ_FILL` (0xD9): 4 B volume (0.01 L) + 4 B money.
pub fn parse_fill(data: &[u8]) -> Option<FillData> {
    if data.len() != FILL_BYTES * 2 {
        return None;
    }
    Some(FillData {
        volume_centilitres: decode_bcd(&data[..FILL_BYTES])?,
        amount_wire: decode_bcd(&data[FILL_BYTES..])?,
    })
}

/// Parse `READ_PRICE` (0xB6): 3 B price per litre.
pub fn parse_price(data: &[u8]) -> Option<u64> {
    if data.len() != PRICE_BYTES {
        return None;
    }
    decode_bcd(data)
}

/// Parse `READ_TOTAL` (0xC5) or `READ_SHIFT` (0xC7): 6 B volume + 6 B money.
pub fn parse_totals(data: &[u8]) -> Option<Totals> {
    if data.len() != TOTALS_BYTES * 2 {
        return None;
    }
    Some(Totals {
        volume_centilitres: decode_bcd(&data[..TOTALS_BYTES])?,
        amount_wire: decode_bcd(&data[TOTALS_BYTES..])?,
    })
}

/// Parse `READ_PRESET` (0xA7): 1 B type + 4 B value.
pub fn parse_preset(data: &[u8]) -> Option<PresetReadback> {
    if data.len() != 1 + FILL_BYTES {
        return None;
    }
    Some(PresetReadback {
        kind: data[0],
        value: decode_bcd(&data[1..])?,
    })
}

/// Parse `READ_ERROR` (0xA9): one byte, `0` meaning no error.
pub fn parse_error_code(data: &[u8]) -> Option<u8> {
    match data {
        [b] => Some(*b),
        _ => None,
    }
}

/// Parse a 4-byte identifier reply — `READ_DEVICE_ID` (0xD7) or
/// `READ_CARD_ID` (0xA8). Returned raw: IDs are not documented as BCD.
pub fn parse_id(data: &[u8]) -> Option<[u8; 4]> {
    match data {
        [a, b, c, d] => Some([*a, *b, *c, *d]),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_status_byte_parses() {
        let s = parse_status(&[0x08]).unwrap();
        assert!(s.remote_control() && s.idle());
        assert_eq!(parse_status(&[]), None);
        assert_eq!(parse_status(&[0x08, 0x00]), None);
    }

    #[test]
    fn fill_data_splits_volume_and_money() {
        // 50.00 L for 226 000 money units.
        let data = [0x00, 0x00, 0x50, 0x00, 0x00, 0x22, 0x60, 0x00];
        let f = parse_fill(&data).unwrap();
        assert_eq!(f.volume_centilitres, 5000);
        assert_eq!(f.amount_wire, 226_000);
    }

    #[test]
    fn totals_use_six_byte_fields() {
        let mut data = vec![0x00, 0x00, 0x12, 0x34, 0x56, 0x78];
        data.extend_from_slice(&[0x00, 0x00, 0x00, 0x99, 0x88, 0x77]);
        let t = parse_totals(&data).unwrap();
        assert_eq!(t.volume_centilitres, 12_345_678);
        assert_eq!(t.amount_wire, 998_877);
    }

    #[test]
    fn price_is_three_bytes() {
        assert_eq!(parse_price(&[0x00, 0x54, 0x50]).unwrap(), 5450);
        assert_eq!(parse_price(&[0x54, 0x50]), None, "short field rejected");
        assert_eq!(parse_price(&[0x00, 0x00, 0x54, 0x50]), None);
    }

    #[test]
    fn preset_readback_splits_kind_and_value() {
        let p = parse_preset(&[0x01, 0x00, 0x00, 0x50, 0x00]).unwrap();
        assert_eq!(p.kind, 0x01);
        assert_eq!(p.value, 5000);
    }

    #[test]
    fn wrong_width_payloads_are_rejected() {
        assert_eq!(parse_fill(&[0x00; 7]), None);
        assert_eq!(parse_fill(&[0x00; 9]), None);
        assert_eq!(parse_totals(&[0x00; 11]), None);
        assert_eq!(parse_preset(&[0x00; 4]), None);
        assert_eq!(parse_id(&[0x00; 3]), None);
    }

    #[test]
    fn corrupted_bcd_is_rejected_rather_than_guessed() {
        // 0xAB is not a pair of decimal digits.
        let data = [0x00, 0x00, 0x50, 0xAB, 0x00, 0x22, 0x60, 0x00];
        assert_eq!(parse_fill(&data), None);
    }

    #[test]
    fn error_code_zero_means_no_error() {
        assert_eq!(parse_error_code(&[0x00]).unwrap(), 0);
        assert_eq!(parse_error_code(&[0x07]).unwrap(), 7);
        assert_eq!(parse_error_code(&[]), None);
    }
}
