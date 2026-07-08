//! AZT 2.0 decoded types and ASCII-digit helpers.
//!
//! Payload numbers are transmitted as ASCII decimal digits: digit `d` → byte
//! `0x30 | d` (`'0'`..`'9'`), most-significant digit first (разд. 7).

/// TRK status returned by a status poll (разд. 6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AztStatus {
    /// `'0'` (0x30): TRK off, nozzle holstered.
    OffHolstered,
    /// `'1'` (0x31): TRK off, nozzle lifted.
    OffLifted,
    /// `'2'` (0x32): authorization command accepted (Санкционирование).
    Authorized,
    /// `'3'` (0x33): TRK on, fuel is being dispensed.
    Dispensing,
    /// `'4'` (0x34) + reason: dispense finished; reason distinguishes normal vs overfill.
    Finished(FinishReason),
    /// `'8'` (0x38): dose set from the local keypad (БМУ), awaiting authorization.
    LocalPreset,
    /// Unknown / no valid status byte.
    Unknown,
}

/// Reason byte accompanying the `'4'` finished status (разд. 6, п. 5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishReason {
    /// `'0'` (0x30): dispensed dose ≤ requested dose (normal completion).
    Normal,
    /// `'1'` (0x31): overfill or unauthorized dispense.
    Overfill,
}

impl AztStatus {
    /// Decode a status char (and optional reason char) into an [`AztStatus`].
    pub fn from_bytes(status: u8, reason: Option<u8>) -> AztStatus {
        match status {
            0x30 => AztStatus::OffHolstered,
            0x31 => AztStatus::OffLifted,
            0x32 => AztStatus::Authorized,
            0x33 => AztStatus::Dispensing,
            0x34 => match reason {
                Some(0x31) => AztStatus::Finished(FinishReason::Overfill),
                _ => AztStatus::Finished(FinishReason::Normal),
            },
            0x38 => AztStatus::LocalPreset,
            _ => AztStatus::Unknown,
        }
    }
}

/// Current dispense data (разд. 7.4): volume only, in hundredths of a litre.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurrentData {
    /// Dispensed volume in 0.01 L units (divide by 100.0 for litres).
    pub volume_centilitres: u64,
}

/// Full dispense data (разд. 7.5): volume, cost and unit price.
///
/// Digit widths depend on the TRK identifier (разд. 7.7); the parser is given
/// those widths so it can slice the frame correctly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FullData {
    /// Volume in 0.01 L units.
    pub volume_centilitres: u64,
    /// Cost in kopecks (0.01 currency units).
    pub cost_kopecks: u64,
    /// Unit price in kopecks per litre.
    pub price_kopecks: u64,
}

/// Digit widths for the full-data frame, keyed by TRK identifier (разд. 7.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrkType {
    /// Identifier byte (`'A'`..`'H'`, 0x3A..0x41).
    pub identifier: u8,
    /// Number of volume digits (L).
    pub volume_digits: u8,
    /// Number of price digits (M).
    pub price_digits: u8,
    /// Number of cost digits (T).
    pub cost_digits: u8,
}

impl TrkType {
    /// Look up digit widths for a TRK identifier byte (Table, разд. 7.7).
    pub fn from_identifier(identifier: u8) -> Option<TrkType> {
        // (volume L, price M, cost T)
        let (l, m, t) = match identifier {
            0x3A => (6, 4, 6), // 'A'
            0x3B => (6, 6, 8), // 'B'
            0x3C => (6, 4, 6), // 'C'
            0x3D => (6, 4, 6), // 'D'
            0x3E => (6, 4, 6), // 'E'
            0x3F => (6, 6, 8), // 'F'
            0x40 => (6, 6, 8), // 'G'
            0x41 => (5, 4, 7), // 'H'
            _ => return None,
        };
        Some(TrkType {
            identifier,
            volume_digits: l,
            price_digits: m,
            cost_digits: t,
        })
    }
}

/// Encode a value as `n` ASCII decimal digits, most-significant first.
///
/// Digits beyond the value's magnitude are `'0'`. The value is truncated to the
/// low `n` decimal places if it does not fit (caller-side range checks apply).
pub fn encode_digits(value: u64, n: usize) -> Vec<u8> {
    let mut out = vec![0u8; n];
    let mut v = value;
    for slot in out.iter_mut().rev() {
        *slot = 0x30 | (v % 10) as u8;
        v /= 10;
    }
    out
}

/// Decode a run of ASCII decimal digit bytes (`'0'`..`'9'`), MSB first.
///
/// Returns `None` if any byte is not a decimal digit.
pub fn decode_digits(bytes: &[u8]) -> Option<u64> {
    bytes.iter().try_fold(0u64, |acc, &b| {
        if (0x30..=0x39).contains(&b) {
            Some(acc * 10 + (b - 0x30) as u64)
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_decoding() {
        assert_eq!(AztStatus::from_bytes(0x30, None), AztStatus::OffHolstered);
        assert_eq!(AztStatus::from_bytes(0x31, None), AztStatus::OffLifted);
        assert_eq!(AztStatus::from_bytes(0x32, None), AztStatus::Authorized);
        assert_eq!(AztStatus::from_bytes(0x33, None), AztStatus::Dispensing);
        assert_eq!(
            AztStatus::from_bytes(0x34, Some(0x30)),
            AztStatus::Finished(FinishReason::Normal)
        );
        assert_eq!(
            AztStatus::from_bytes(0x34, Some(0x31)),
            AztStatus::Finished(FinishReason::Overfill)
        );
        assert_eq!(AztStatus::from_bytes(0x38, None), AztStatus::LocalPreset);
        assert_eq!(AztStatus::from_bytes(0x55, None), AztStatus::Unknown);
    }

    #[test]
    fn digit_roundtrip() {
        assert_eq!(encode_digits(3000, 5), b"03000");
        assert_eq!(encode_digits(670, 4), b"0670");
        assert_eq!(encode_digits(0, 4), b"0000");
        assert_eq!(decode_digits(b"03000"), Some(3000));
        assert_eq!(decode_digits(b"0670"), Some(670));
        assert_eq!(decode_digits(&encode_digits(14_93, 5)), Some(1493));
    }

    #[test]
    fn decode_rejects_non_digits() {
        assert_eq!(decode_digits(&[0x30, 0x3A, 0x31]), None);
    }

    #[test]
    fn trk_type_widths() {
        assert_eq!(
            TrkType::from_identifier(0x3A),
            Some(TrkType {
                identifier: 0x3A,
                volume_digits: 6,
                price_digits: 4,
                cost_digits: 6
            })
        );
        assert_eq!(TrkType::from_identifier(0x41).unwrap().cost_digits, 7);
        assert_eq!(TrkType::from_identifier(0x00), None);
    }
}
