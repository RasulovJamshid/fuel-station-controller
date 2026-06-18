use crate::frame::{GilbarcoStatus, TotalsData, TransactionData};
use crate::lrc::gilbarco_lrc_valid;

/// Live display amount scale.
///
/// The six live-display digits encode the amount in units of 10 soum.
pub const LIVE_AMOUNT_SCALE_SOUM: u64 = 10;

/// Classify the status byte returned by a pump in response to a poll of `addr`.
///
/// 9600 baud encoding: `status_byte = 0xN0 | addr`.
///
/// | High nibble | State              |
/// |-------------|--------------------|
/// | 0x60        | Idle               |
/// | 0x70        | NozzleLifted       |
/// | 0x80        | Ready              |
/// | 0x90        | Delivering         |
/// | 0xA0        | TransactionComplete|
/// | 0xB0        | TransactionComplete (end-of-cycle clearing pulse, 1 poll only)|
/// | 0xC0        | Stopped            |
/// | 0xD0        | ListenMode         |
///
/// `0xB0|addr` is a single-poll transient seen after `0xA0|addr` (or as the sole
/// end-of-cycle signal when `0xA0` is absent). Both map to TransactionComplete.
///
/// All other bytes (including RS-485 echoes of PC commands 0x10|addr, 0x30|addr) → Offline.
pub fn parse_status_byte(addr: u8, b: u8) -> GilbarcoStatus {
    let addr_low = addr & 0x0F;
    let b_low = b & 0x0F;

    if b_low != addr_low {
        return GilbarcoStatus::Offline;
    }

    match b & 0xF0 {
        0x60 => GilbarcoStatus::Idle,
        0x70 => GilbarcoStatus::NozzleLifted,
        0x80 => GilbarcoStatus::Ready,
        0x90 => GilbarcoStatus::Delivering,
        0xA0 | 0xB0 => GilbarcoStatus::TransactionComplete,
        0xC0 => GilbarcoStatus::Stopped,
        0xD0 => GilbarcoStatus::ListenMode,
        _ => GilbarcoStatus::Offline,
    }
}

/// Parse the GetDisplay response as a live amount counter.
///
/// Command is `0x60 | addr`. The serial driver strips the command echo and leaves
/// six bytes. Each byte has the form `0xE0 | digit`, where byte 0 is the units
/// digit. The decoded value is in units of 10 soum.
///
/// Examples from 9600 logs:
///
/// ```text
/// E0 E0 E9 E2 E4 E0 -> 42900 -> 429000 soum
/// E0 E0 E3 E1 E1 E0 -> 11300 -> 113000 soum
/// ```
pub fn parse_display_response(buf: &[u8]) -> Option<u64> {
    if buf.len() < 6 {
        return None;
    }
    decode_e_digits(&buf[..6])
}

/// Convert the raw live display amount to soum.
pub fn live_amount_raw_to_soum(amount_raw: u64) -> u64 {
    amount_raw * LIVE_AMOUNT_SCALE_SOUM
}

/// Convert the raw live display amount to litres using price in soum/litre.
pub fn live_amount_raw_to_litres(amount_raw: u64, price_per_litre: u64) -> Option<f64> {
    if price_per_litre == 0 {
        return None;
    }
    Some(live_amount_raw_to_soum(amount_raw) as f64 / price_per_litre as f64)
}

/// Parse the GetNozzle response.
///
/// Command is `[0x20|addr, 0xFF]`. The serial driver strips the command echo
/// `[0x20|addr, 0xFF]`, leaving a 7-byte payload from the gilb-v2 board:
///
/// ```text
/// buf[0] : 0xE9 (nozzle up, not yet authorized)
///        | 0xE5 (nozzle up, pump authorized via keypad)
/// buf[1..6]: fixed filler bytes (FE E0 E1 E0 FB for E9 state;
///            varies for E5 state but contains no decodable nozzle index)
/// ```
///
/// The gilb-v2 protocol bridge strips the nozzle-index bytes that the native
/// 5787-baud dispenser would normally include. All log captures (35 events,
/// 3 addresses) return the same payload for E9 regardless of which physical
/// nozzle was lifted. Nozzle index is therefore always 1.
///
/// Note: GilbarcoMulti uses an incompatible 9-byte command for GetNozzle.
pub fn parse_nozzle_response(buf: &[u8]) -> Option<u8> {
    if buf.len() < 7 {
        return None;
    }
    // First byte is E9 (not authorized) or E5 (authorized).
    if buf[0] != 0xE9 && buf[0] != 0xE5 {
        return None;
    }
    // gilb-v2 board strips nozzle-index bytes; nozzle 1 is the only possible result.
    Some(1)
}

/// Parse the 9600 all-pump/all-nozzle frame returned by command `F0`.
///
/// Captures show the response either as a full frame beginning with `F0 BA ...`,
/// or with the leading `F0` absent after echo stripping / line splitting. In this
/// frame:
///
/// ```text
/// offset + 3  : B{pump address}
/// offset + 14 : B{nozzle index}
/// ```
///
/// where `offset = 1` for `F0 BA ...` and `offset = 0` for `BA ...`.
///
/// Verified from `maybe9600_all_nozzle_lift_and_down...log`:
/// pump 1 keeps `B1` at the pump byte while the nozzle byte changes
/// `B1` → `B2` → `B3`; pump 2/3/4 use `B2`/`B3`/`B4` at the pump byte.
pub fn parse_all_nozzle_response(buf: &[u8]) -> Option<(u8, u8)> {
    let offset = match buf {
        [0xF0, 0xBA, ..] => 1,
        [0xBA, ..] => 0,
        _ => return None,
    };
    if buf.len() <= offset + 14 {
        return None;
    }

    let pump = decode_b_no(buf[offset + 3])?;
    let nozzle = decode_b_no(buf[offset + 14])?;
    Some((pump, nozzle))
}

fn decode_b_no(b: u8) -> Option<u8> {
    if b & 0xF0 != 0xB0 {
        return None;
    }
    let value = b & 0x0F;
    (value > 0).then_some(value)
}

/// Decode a little-endian BCD sequence where `bytes[0]` = units digit,
/// `bytes[1]` = tens digit, etc. Each byte contributes its low nibble.
fn decode_e_digits(bytes: &[u8]) -> Option<u64> {
    bytes.iter().enumerate().try_fold(0u64, |acc, (i, &b)| {
        if b & 0xF0 != 0xE0 || b & 0x0F > 9 {
            return None;
        }
        Some(acc + (b & 0x0F) as u64 * 10u64.pow(i as u32))
    })
}

/// Decode a little-endian BCD sequence where `bytes[0]` = units digit,
/// `bytes[1]` = tens digit, etc. Each byte must be `0xE0 | digit`.
fn decode_le_bcd(bytes: &[u8]) -> Option<u64> {
    decode_e_digits(bytes)
}

/// Parse the GetTransaction response (33-byte frame starting `FF`).
///
/// Frame layout (confirmed from 9600 logs, 11 fills across 3 addresses):
///
/// ```text
/// Byte  0     : FF  frame start
/// Bytes 1–3   : F1 F8 EB  fixed header
/// Byte  4     : E{id}  pump/hose identifier (low nibble)
/// Bytes 5–7   : E0 E0 E0  padding
/// Byte  8     : F6  section marker
/// Byte  9     : E{grade}  product grade (low nibble)
/// Byte 10     : F4  section marker
/// Byte 11     : F7  section marker
/// Bytes 12–15 : 4×E{d}  price/litre, little-endian BCD, unit = 10 soum
/// Byte 16     : F9  volume section marker
/// Bytes 17–22 : 6×E{d}  volume in mL, little-endian BCD
/// Byte 23     : FA  amount section marker
/// Bytes 24–29 : 6×E{d}  amount ÷ 10 soum, little-endian BCD
/// Byte 30     : FB  end marker
/// Byte 31     : E{lrc}  checksum
/// Byte 32     : F0  frame end
/// ```
///
/// `volume_raw` is in mL (divide by 1000 for litres).
/// `amount_raw` is in units of 10 soum (multiply by 10 for soum).
/// `unit_price_raw` is the raw 4-digit BCD integer (multiply by 10 for soum/L).
///
/// The serial driver strips the RS-485 command echo before calling this, so
/// `buf[0]` is always `0xFF`.
pub fn parse_transaction_response(buf: &[u8]) -> Option<TransactionData> {
    if buf.len() < 33 || buf[0] != 0xFF {
        return None;
    }
    if buf[16] != 0xF9 || buf[23] != 0xFA || buf[30] != 0xFB || buf[32] != 0xF0 {
        return None;
    }
    if !gilbarco_lrc_valid(&buf[..31], buf[31]) {
        return None;
    }
    Some(TransactionData {
        unit_price_raw: decode_le_bcd(&buf[12..16])?,
        volume_raw: decode_le_bcd(&buf[17..23])?,
        amount_raw: decode_le_bcd(&buf[24..30])?,
    })
}

/// Parse the GetTotals response (`0x50 | addr`) for one nozzle.
///
/// The serial layer usually strips the command echo, leaving a 94-byte frame:
///
/// ```text
/// FF
///   F6 E0 F9 [8 volume total digits] FA [8 amount total digits] F4 [4 price digits] F5 [4 spare]
///   F6 E1 ...
///   F6 E2 ...
/// FB [lrc] F0
/// ```
///
/// Some captures/tools may include the command byte (`0x50 | addr`) before `FF`;
/// this parser accepts both forms. Nozzle sections are addressed 1-based, while
/// the frame stores them as `E0`, `E1`, `E2`, ...
pub fn parse_totals_response(buf: &[u8], nozzle_index: u8) -> Option<TotalsData> {
    if nozzle_index == 0 {
        return None;
    }

    let frame = match buf {
        [cmd, 0xFF, ..] if cmd & 0xF0 == 0x50 => &buf[1..],
        [0xFF, ..] => buf,
        _ => return None,
    };

    let section = 1 + 30 * (nozzle_index as usize - 1);
    if frame.len() < section + 30 {
        return None;
    }
    if frame[section] != 0xF6
        || frame[section + 1] != 0xE0 | ((nozzle_index - 1) & 0x0F)
        || frame[section + 2] != 0xF9
        || frame[section + 11] != 0xFA
        || frame[section + 20] != 0xF4
        || frame[section + 25] != 0xF5
    {
        return None;
    }
    if frame.len() >= 3
        && frame[frame.len() - 1] == 0xF0
        && frame[frame.len() - 3] == 0xFB
        && !gilbarco_lrc_valid(&frame[..frame.len() - 2], frame[frame.len() - 2])
    {
        return None;
    }

    Some(TotalsData {
        nozzle_index,
        volume_total_raw: decode_le_bcd(&frame[section + 3..section + 11])?,
        amount_total_raw: decode_le_bcd(&frame[section + 12..section + 20])?,
        unit_price_raw: decode_le_bcd(&frame[section + 21..section + 25])?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addr01_idle() {
        // Idle for addr 01: 0x60 | 0x01 = 0x61
        assert_eq!(parse_status_byte(0x01, 0x61), GilbarcoStatus::Idle);
    }

    #[test]
    fn addr02_nozzle_lifted() {
        // NozzleLifted for addr 02: 0x70 | 0x02 = 0x72
        assert_eq!(parse_status_byte(0x02, 0x72), GilbarcoStatus::NozzleLifted);
    }

    #[test]
    fn addr03_delivering() {
        // Delivering for addr 03: 0x90 | 0x03 = 0x93
        assert_eq!(parse_status_byte(0x03, 0x93), GilbarcoStatus::Delivering);
    }

    #[test]
    fn addr03_ready() {
        assert_eq!(parse_status_byte(0x03, 0x83), GilbarcoStatus::Ready);
    }

    #[test]
    fn addr02_delivering_armed() {
        // Armed/Authorized for addr 02: 0x90 | 0x02 = 0x92
        assert_eq!(parse_status_byte(0x02, 0x92), GilbarcoStatus::Delivering);
    }

    #[test]
    fn addr02_tx_complete() {
        // TxComplete for addr 02: 0xA0 | 0x02 = 0xA2
        assert_eq!(
            parse_status_byte(0x02, 0xA2),
            GilbarcoStatus::TransactionComplete
        );
    }

    #[test]
    fn addr02_tx_complete_b0_pulse() {
        // 0xB0|addr end-of-cycle clearing pulse, confirmed in 3 fill logs (always last
        // status before Idle; sometimes only end-of-cycle signal when 0xA2 absent).
        assert_eq!(
            parse_status_byte(0x02, 0xB2),
            GilbarcoStatus::TransactionComplete
        );
    }

    #[test]
    fn addr02_stopped() {
        // Stopped for addr 02: 0xC0 | 0x02 = 0xC2
        assert_eq!(parse_status_byte(0x02, 0xC2), GilbarcoStatus::Stopped);
    }

    #[test]
    fn transient_bytes_are_offline_or_listen() {
        // 0x32 is the PC's own halt command echoed back on RS-485 half-duplex bus.
        // 0x12 is another unrecognised nibble. 0xD2 is a listen acknowledgement.
        assert_eq!(parse_status_byte(0x02, 0x12), GilbarcoStatus::Offline);
        assert_eq!(parse_status_byte(0x02, 0x32), GilbarcoStatus::Offline);
        assert_eq!(parse_status_byte(0x02, 0xD2), GilbarcoStatus::ListenMode);
    }

    #[test]
    fn addr_mismatch_is_offline() {
        // Status byte for wrong address → Offline
        assert_eq!(parse_status_byte(0x01, 0x62), GilbarcoStatus::Offline);
        assert_eq!(parse_status_byte(0x03, 0x92), GilbarcoStatus::Offline);
    }

    #[test]
    fn display_30l_fill() {
        // 30 L at 14300/L: live display amount = 429000 soum.
        let buf = [0xE0, 0xE0, 0xE9, 0xE2, 0xE4, 0xE0u8];
        let amount_raw = parse_display_response(&buf).unwrap();
        assert_eq!(amount_raw, 42900);
        assert_eq!(live_amount_raw_to_soum(amount_raw), 429000);
        let litres = live_amount_raw_to_litres(amount_raw, 14300).unwrap();
        assert!((litres - 30.0).abs() < 0.01, "litres={litres}");
    }

    #[test]
    fn display_10l_fill() {
        // 10 L at 11300/L: live display amount = 113000 soum.
        let buf = [0xE0, 0xE0, 0xE3, 0xE1, 0xE1, 0xE0u8];
        let amount_raw = parse_display_response(&buf).unwrap();
        assert_eq!(amount_raw, 11300);
        assert_eq!(live_amount_raw_to_soum(amount_raw), 113000);
        let litres = live_amount_raw_to_litres(amount_raw, 11300).unwrap();
        assert!((litres - 10.0).abs() < 0.01, "litres={litres}");
    }

    #[test]
    fn display_all_zeros() {
        let buf = [0xE0u8; 6];
        assert_eq!(parse_display_response(&buf), Some(0));
    }

    #[test]
    fn display_too_short() {
        assert_eq!(parse_display_response(&[0xE0; 5]), None);
    }

    #[test]
    fn display_rejects_non_digit_bytes() {
        assert_eq!(
            parse_display_response(&[0xE0, 0xE0, 0xFA, 0xE1, 0xE1, 0xE0]),
            None
        );
    }

    #[test]
    fn tx_response_10l_at_11000() {
        // Log: maybe9600_fill_10litre_from_start_to_end — addr 2, price 11000/L
        // vol = 10000 mL = 10 L, amount = 11000 × 10 = 110000 soum
        let buf = [
            0xFF, 0xF1, 0xF8, 0xEB, 0xE1, 0xE0, 0xE0, 0xE0, 0xF6, 0xE1, 0xF4, 0xF7, 0xE0, 0xE0,
            0xE1, 0xE1, 0xF9, 0xE0, 0xE0, 0xE0, 0xE0, 0xE1, 0xE0, 0xFA, 0xE0, 0xE0, 0xE0, 0xE1,
            0xE1, 0xE0, 0xFB, 0xE7, 0xF0,
        ];
        let td = parse_transaction_response(&buf).unwrap();
        assert_eq!(td.volume_raw, 10000); // 10000 mL = 10 L
        assert_eq!(td.amount_raw, 11000); // × 10 = 110000 soum
        assert_eq!(td.unit_price_raw, 1100); // × 10 = 11000 soum/L
    }

    #[test]
    fn tx_response_30l_ai95_at_14300() {
        // Log: 30L_AI95_14300PERLITRE — addr 3, 30 L at 14300/L = 429000 soum
        let buf = [
            0xFF, 0xF1, 0xF8, 0xEB, 0xE2, 0xE0, 0xE0, 0xE0, 0xF6, 0xE2, 0xF4, 0xF7, 0xE0, 0xE3,
            0xE4, 0xE1, 0xF9, 0xE0, 0xE0, 0xE0, 0xE0, 0xE3, 0xE0, 0xFA, 0xE0, 0xE0, 0xE9, 0xE2,
            0xE4, 0xE0, 0xFB, 0xE0, 0xF0,
        ];
        let td = parse_transaction_response(&buf).unwrap();
        assert_eq!(td.volume_raw, 30000); // 30000 mL = 30 L
        assert_eq!(td.amount_raw, 42900); // × 10 = 429000 soum
        assert_eq!(td.unit_price_raw, 1430); // × 10 = 14300 soum/L
    }

    #[test]
    fn tx_response_25000sum_at_11000() {
        // Log: fill_25000sum — 2270 mL at 11000/L = 25000 soum (≈2.27 L)
        let buf = [
            0xFF, 0xF1, 0xF8, 0xEB, 0xE1, 0xE0, 0xE0, 0xE0, 0xF6, 0xE1, 0xF4, 0xF7, 0xE0, 0xE0,
            0xE1, 0xE1, 0xF9, 0xE0, 0xE7, 0xE2, 0xE2, 0xE0, 0xE0, 0xFA, 0xE0, 0xE0, 0xE5, 0xE2,
            0xE0, 0xE0, 0xFB, 0xE8, 0xF0,
        ];
        let td = parse_transaction_response(&buf).unwrap();
        assert_eq!(td.volume_raw, 2270); // 2270 mL ≈ 2.27 L
        assert_eq!(td.amount_raw, 2500); // × 10 = 25000 soum
    }

    #[test]
    fn tx_response_too_short() {
        assert_eq!(parse_transaction_response(&[0xFF; 32]), None);
    }

    #[test]
    fn tx_response_wrong_start() {
        let mut buf = [0xE0u8; 33];
        buf[16] = 0xF9;
        buf[23] = 0xFA;
        assert_eq!(parse_transaction_response(&buf), None);
    }

    #[test]
    fn tx_response_bad_markers() {
        let buf = [0xFF; 33];
        // Leave F9/FA as 0xFF instead of 0xF9/0xFA
        assert_eq!(parse_transaction_response(&buf), None);
    }

    #[test]
    fn tx_response_bad_digit() {
        let mut buf = [
            0xFF, 0xF1, 0xF8, 0xEB, 0xE1, 0xE0, 0xE0, 0xE0, 0xF6, 0xE1, 0xF4, 0xF7, 0xE0, 0xE0,
            0xE1, 0xE1, 0xF9, 0xE0, 0xE0, 0xE0, 0xE0, 0xE1, 0xE0, 0xFA, 0xE0, 0xE0, 0xE0, 0xE1,
            0xE1, 0xE0, 0xFB, 0xE7, 0xF0,
        ];
        buf[17] = 0xFA;
        assert_eq!(parse_transaction_response(&buf), None);
    }

    #[test]
    fn totals_response_nozzle1_from_10l_fill() {
        let buf = [
            0xFF, 0xF6, 0xE0, 0xF9, 0xE6, 0xE6, 0xE9, 0xE4, 0xE3, 0xE6, 0xE6, 0xE2, 0xFA, 0xE7,
            0xE6, 0xE2, 0xE0, 0xE8, 0xE7, 0xE2, 0xE8, 0xF4, 0xE0, 0xE3, 0xE1, 0xE1, 0xF5, 0xE0,
            0xE0, 0xE0, 0xE0, 0xF6, 0xE1, 0xF9, 0xE8, 0xE6, 0xE0, 0xE5, 0xE0, 0xE6, 0xE5, 0xE3,
            0xFA, 0xE3, 0xE2, 0xE5, 0xE1, 0xE2, 0xE2, 0xE2, 0xE8, 0xF4, 0xE0, 0xE0, 0xE1, 0xE1,
            0xF5, 0xE0, 0xE0, 0xE0, 0xE0, 0xF6, 0xE2, 0xF9, 0xE2, 0xE3, 0xE9, 0xE5, 0xE0, 0xE4,
            0xE9, 0xE9, 0xFA, 0xE9, 0xE1, 0xE8, 0xE1, 0xE0, 0xE1, 0xE1, 0xE8, 0xF4, 0xE0, 0xE3,
            0xE4, 0xE1, 0xF5, 0xE0, 0xE0, 0xE0, 0xE0, 0xFB, 0xEC, 0xF0,
        ];
        let totals = parse_totals_response(&buf, 1).unwrap();
        assert_eq!(totals.nozzle_index, 1);
        assert_eq!(totals.volume_total_raw, 26634966);
        assert_eq!(totals.amount_total_raw, 82780267);
        assert_eq!(totals.unit_price_raw, 1130);
    }

    #[test]
    fn totals_response_nozzle3_with_command_echo() {
        let buf = [
            0x52, 0xFF, 0xF6, 0xE0, 0xF9, 0xE6, 0xE6, 0xE9, 0xE4, 0xE3, 0xE6, 0xE6, 0xE2, 0xFA,
            0xE7, 0xE6, 0xE2, 0xE0, 0xE8, 0xE7, 0xE2, 0xE8, 0xF4, 0xE0, 0xE3, 0xE1, 0xE1, 0xF5,
            0xE0, 0xE0, 0xE0, 0xE0, 0xF6, 0xE1, 0xF9, 0xE8, 0xE6, 0xE0, 0xE5, 0xE0, 0xE6, 0xE5,
            0xE3, 0xFA, 0xE3, 0xE2, 0xE5, 0xE1, 0xE2, 0xE2, 0xE2, 0xE8, 0xF4, 0xE0, 0xE0, 0xE1,
            0xE1, 0xF5, 0xE0, 0xE0, 0xE0, 0xE0, 0xF6, 0xE2, 0xF9, 0xE2, 0xE3, 0xE9, 0xE5, 0xE0,
            0xE4, 0xE9, 0xE9, 0xFA, 0xE9, 0xE1, 0xE8, 0xE1, 0xE0, 0xE1, 0xE1, 0xE8, 0xF4, 0xE0,
            0xE3, 0xE4, 0xE1, 0xF5, 0xE0, 0xE0, 0xE0, 0xE0, 0xFB, 0xEC, 0xF0,
        ];
        let totals = parse_totals_response(&buf, 3).unwrap();
        assert_eq!(totals.volume_total_raw, 99405932);
        assert_eq!(totals.amount_total_raw, 81101819);
        assert_eq!(totals.unit_price_raw, 1430);
    }

    #[test]
    fn totals_response_rejects_wrong_section() {
        let buf = [0xFF; 94];
        assert_eq!(parse_totals_response(&buf, 1), None);
    }

    #[test]
    fn nozzle_response_e9_not_authorized() {
        // Confirmed from 33 log captures: response is E9 FE E0 E1 E0 FB EE (7 bytes)
        // after serial driver strips the [0x22, 0xFF] command echo.
        let buf = [0xE9u8, 0xFE, 0xE0, 0xE1, 0xE0, 0xFB, 0xEE];
        assert_eq!(parse_nozzle_response(&buf), Some(1));
    }

    #[test]
    fn nozzle_response_e5_authorized() {
        // E5 first byte = pump authorized via keypad (seen in preauth log).
        // Nozzle index still 1 (gilb-v2 strips nozzle-index bytes).
        let buf = [0xE5u8, 0xF4, 0xF6, 0xE1, 0xF7, 0xE0, 0xE0];
        assert_eq!(parse_nozzle_response(&buf), Some(1));
    }

    #[test]
    fn nozzle_response_too_short() {
        assert_eq!(parse_nozzle_response(&[0xE9; 6]), None);
    }

    #[test]
    fn nozzle_response_wrong_first_byte() {
        // Anything other than E9/E5 in first byte is invalid.
        let buf = [0xFEu8, 0xE0, 0xE1, 0xE0, 0xFB, 0xEE, 0xE9];
        assert_eq!(parse_nozzle_response(&buf), None);
    }

    #[test]
    fn all_nozzle_frame_pump1_nozzle2_full_frame() {
        let buf = [
            0xF0, 0xBA, 0xB0, 0xB3, 0xB1, 0xB0, 0xB1, 0xB0, 0xB0, 0xB0, 0xB0, 0xB1, 0xB1, 0xB1,
            0xB1, 0xB2, 0xC2, 0xB9, 0x8D, 0x8A,
        ];
        assert_eq!(parse_all_nozzle_response(&buf), Some((1, 2)));
    }

    #[test]
    fn all_nozzle_frame_pump3_nozzle3_echo_stripped() {
        let buf = [
            0xBA, 0xB0, 0xB3, 0xB3, 0xB0, 0xB1, 0xB0, 0xB0, 0xB0, 0xB0, 0xB1, 0xB1, 0xB1, 0xB1,
            0xB3, 0xB9, 0xB8, 0x8D, 0x8A,
        ];
        assert_eq!(parse_all_nozzle_response(&buf), Some((3, 3)));
    }

    #[test]
    fn all_nozzle_frame_rejects_bad_header() {
        assert_eq!(parse_all_nozzle_response(&[0xFF; 20]), None);
    }
}
