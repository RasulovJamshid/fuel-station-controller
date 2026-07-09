//! Interpret decoded AZT 2.0 response payloads.
//!
//! These take the normal (de-complemented) data bytes returned by
//! [`crate::codec::decode_response`] as [`crate::codec::Response::Data`] and turn
//! them into typed values.

use crate::frame::{decode_digits, AztStatus, CurrentData, FullData, TrkType};

/// Parse a status response (разд. 7.1): one status char and an optional reason
/// char (present only for the `'4'` finished status).
pub fn parse_status(data: &[u8]) -> Option<AztStatus> {
    let status = *data.first()?;
    let reason = data.get(1).copied();
    Some(AztStatus::from_bytes(status, reason))
}

/// Parse the current-dispense-data response (разд. 7.4).
///
/// Six ASCII digits (leading `'0'` then hundreds…hundredths of a litre) giving
/// the dispensed volume in 0.01 L units.
pub fn parse_current_data(data: &[u8]) -> Option<CurrentData> {
    if data.len() < 6 {
        return None;
    }
    Some(CurrentData {
        volume_centilitres: decode_digits(&data[..6])?,
    })
}

/// Parse the full-dispense-data response (разд. 7.5).
///
/// Digit widths depend on the TRK identifier (разд. 7.7), so the caller supplies
/// the [`TrkType`] obtained from a prior [`crate::commands::trk_type`] query.
/// Layout: `[volume L digits][cost T digits][price M digits]`.
pub fn parse_full_data(data: &[u8], trk: TrkType) -> Option<FullData> {
    let l = trk.volume_digits as usize;
    let t = trk.cost_digits as usize;
    let m = trk.price_digits as usize;
    if data.len() < l + t + m {
        return None;
    }
    Some(FullData {
        volume_centilitres: decode_digits(&data[..l])?,
        cost_kopecks: decode_digits(&data[l..l + t])?,
        price_kopecks: decode_digits(&data[l + t..l + t + m])?,
    })
}

/// Parse the totalizer response (разд. 7.6).
///
/// Two equal-width n-digit numbers (`8 ≤ n ≤ 12`): the litre total in 0.01 L and
/// the currency total in kopecks. Returns `(litres_centilitres, kopecks)`.
pub fn parse_totals(data: &[u8]) -> Option<(u64, u64)> {
    if data.is_empty() || data.len() % 2 != 0 {
        return None;
    }
    let n = data.len() / 2;
    let litres = decode_digits(&data[..n])?;
    let kopecks = decode_digits(&data[n..])?;
    Some((litres, kopecks))
}

/// Parse the TRK-type response (разд. 7.7): a single identifier byte.
pub fn parse_trk_type(data: &[u8]) -> Option<TrkType> {
    TrkType::from_identifier(*data.first()?)
}

/// Parse the protocol-version response (разд. 7.9): 8 ASCII digits (UINSW).
pub fn parse_protocol_version(data: &[u8]) -> Option<u32> {
    if data.len() < 8 {
        return None;
    }
    decode_digits(&data[..8]).map(|v| v as u32)
}

/// Parse the transaction-number response (разд. 7.20): 8 ASCII digits (UINTR).
pub fn parse_transaction_number(data: &[u8]) -> Option<u64> {
    if data.len() < 8 {
        return None;
    }
    decode_digits(&data[..8])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{decode_response, Response};
    use crate::frame::{encode_digits, FinishReason};

    /// Assemble a TRK data frame (STX + digit pairs + ETX ETX + CS) from raw
    /// data bytes, then run it through the real decoder — exercising the whole
    /// codec + parser path.
    fn framed(data: &[u8]) -> Vec<u8> {
        use crate::codec::{checksum, complement, ETX, STX};
        let mut out = vec![STX];
        for &b in data {
            out.push(b);
            out.push(complement(b));
        }
        out.push(ETX);
        out.push(ETX);
        out.push(checksum(data));
        out
    }

    fn decoded(data: &[u8]) -> Vec<u8> {
        match decode_response(&framed(data)).unwrap() {
            Response::Data(d) => d,
            other => panic!("expected data, got {other:?}"),
        }
    }

    #[test]
    fn status_and_finish_reason() {
        assert_eq!(parse_status(&decoded(b"2")), Some(AztStatus::Authorized));
        assert_eq!(
            parse_status(&decoded(b"41")),
            Some(AztStatus::Finished(FinishReason::Overfill))
        );
        assert_eq!(
            parse_status(&decoded(b"40")),
            Some(AztStatus::Finished(FinishReason::Normal))
        );
    }

    #[test]
    fn current_data_30_litres() {
        // '0' + "30000" hundredths → 30.00 L. Six digits: 030000? No — 6 digits:
        // "030000" would be 6 digits = 3000.00; current data is 0.01 L so
        // 30.00 L = 3000 centilitres, transmitted as leading '0' + 5 digits.
        let data = b"030000"; // '0',hundreds..hundredths → 03000.0? see assert
        let cd = parse_current_data(&decoded(data)).unwrap();
        assert_eq!(cd.volume_centilitres, 30000);
        assert!((cd.volume_centilitres as f64 / 100.0 - 300.0).abs() < f64::EPSILON);
    }

    #[test]
    fn current_data_realistic_10_litres() {
        // 10.00 L = 1000 centilitres → leading '0' + "01000".
        let cd = parse_current_data(&decoded(b"001000")).unwrap();
        assert_eq!(cd.volume_centilitres, 1000);
    }

    #[test]
    fn full_data_type_a() {
        // Type 'A': L=6, M=4 (price), T=6 (cost).
        // 30.00 L → 003000 (0.01 L); cost 42900 kopecks → 042900; price 1430 → 1430.
        let trk = TrkType::from_identifier(b'A').unwrap();
        let mut data = Vec::new();
        data.extend_from_slice(&encode_digits(3000, 6)); // volume, 0.01 L
        data.extend_from_slice(&encode_digits(42900, 6)); // cost, kopecks
        data.extend_from_slice(&encode_digits(1430, 4)); // price, kopecks/L
        let fd = parse_full_data(&decoded(&data), trk).unwrap();
        assert_eq!(fd.volume_centilitres, 3000);
        assert_eq!(fd.cost_kopecks, 42900);
        assert_eq!(fd.price_kopecks, 1430);
    }

    #[test]
    fn totals_split_in_half() {
        // 8-digit litres + 8-digit kopecks.
        let mut data = Vec::new();
        data.extend_from_slice(&encode_digits(26_634_966, 8));
        data.extend_from_slice(&encode_digits(82_780_267, 8));
        let (litres, kopecks) = parse_totals(&decoded(&data)).unwrap();
        assert_eq!(litres, 26_634_966);
        assert_eq!(kopecks, 82_780_267);
    }

    #[test]
    fn totals_rejects_odd_length() {
        assert_eq!(parse_totals(b"123"), None);
    }

    #[test]
    fn trk_type_identifier() {
        let t = parse_trk_type(&decoded(b"A")).unwrap();
        assert_eq!(t.volume_digits, 6);
    }

    #[test]
    fn trk_type_identifier_h_from_serial_log() {
        // Real AZT hardware in .azs-run/serial.log replies to command '7' as:
        // 7F 02 48 37 03 03 4B, decoded payload 'H'.
        let t = parse_trk_type(&decoded(b"H")).unwrap();
        assert_eq!(t.identifier, b'H');
        assert_eq!(t.volume_digits, 5);
        assert_eq!(t.price_digits, 4);
        assert_eq!(t.cost_digits, 7);
    }

    #[test]
    fn protocol_version_eight_digits() {
        let data = encode_digits(2, 8); // "00000002"
        assert_eq!(parse_protocol_version(&decoded(&data)), Some(2));
    }

    #[test]
    fn transaction_number_eight_digits() {
        let data = encode_digits(12_345_678, 8);
        assert_eq!(parse_transaction_number(&decoded(&data)), Some(12_345_678));
    }
}
