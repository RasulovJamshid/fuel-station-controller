//! Frame construction, validation and BCD number coding (разд. 4, 5).
//!
//! Frame layout, identical for request and response:
//!
//! ```text
//! F5 | ADDR | 0xA0|LEN | DATA… | CMD | CRC
//! ```
//!
//! `LEN` is the **low nibble** of byte 2 and counts the bytes *after* the length
//! byte — data + command + CRC. The high nibble is always `0xA`. Minimum frame
//! length is 5 bytes. `CRC` is the XOR of every preceding byte, masked to 7 bits.

/// Start byte (precode), same for requests and responses.
pub const PRECODE: u8 = 0xF5;
/// High nibble of the length byte; the low nibble carries the length.
pub const LEN_HIGH: u8 = 0xA0;
/// `STATE` byte meaning success in a status reply.
pub const STATE_OK: u8 = 0x59;
/// `STATE` byte meaning failure in a status reply.
pub const STATE_ERR: u8 = 0x4E;

/// Smallest legal frame: `F5 ADDR A2 CMD CRC`.
pub const MIN_FRAME_LEN: usize = 5;
/// `LEN` lives in one nibble, so at most 15 bytes may follow the length byte —
/// leaving 13 for the payload once `CMD` and `CRC` are accounted for.
pub const MAX_DATA_LEN: usize = 13;

/// XOR of all bytes, masked to 7 bits (разд. 4).
pub fn crc(bytes: &[u8]) -> u8 {
    bytes.iter().fold(0u8, |acc, b| acc ^ b) & 0x7F
}

/// Build a request frame for `addr`.
///
/// Returns `None` when `data` cannot be expressed in the one-nibble length
/// field, rather than emitting a frame the device would silently drop.
pub fn build_request(addr: u8, cmd: u8, data: &[u8]) -> Option<Vec<u8>> {
    if data.len() > MAX_DATA_LEN {
        return None;
    }
    // data + CMD + CRC — everything after the length byte.
    let len = data.len() + 2;
    let mut f = Vec::with_capacity(len + 3);
    f.push(PRECODE);
    f.push(addr);
    f.push(LEN_HIGH | (len as u8 & 0x0F));
    f.extend_from_slice(data);
    f.push(cmd);
    f.push(crc(&f));
    Some(f)
}

/// A decoded reply.
///
/// The wire cannot distinguish a "status" reply from a one-byte data reply —
/// both are `LEN = 3` with a single payload byte — so the split is semantic and
/// left to the caller. Use [`Response::status_ok`] for commands documented as
/// returning a status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Response {
    /// `F5 ADDR A2 CMD CRC` — acknowledgement carrying no payload ("общий").
    General { cmd: u8 },
    /// A reply carrying payload bytes: read results, or the single `STATE` byte
    /// of a status reply ("статусный").
    Data { cmd: u8, data: Vec<u8> },
}

impl Response {
    /// Command code this reply answers.
    pub fn cmd(&self) -> u8 {
        match self {
            Response::General { cmd } => *cmd,
            Response::Data { cmd, .. } => *cmd,
        }
    }

    /// Payload bytes (empty for a general acknowledgement).
    pub fn data(&self) -> &[u8] {
        match self {
            Response::General { .. } => &[],
            Response::Data { data, .. } => data,
        }
    }

    /// `true` when this is a status reply carrying `0x59` (success).
    ///
    /// A general acknowledgement also counts as success: several commands are
    /// documented as returning one or the other depending on firmware state.
    pub fn status_ok(&self) -> bool {
        match self {
            Response::General { .. } => true,
            Response::Data { data, .. } => data.as_slice() == [STATE_OK],
        }
    }

    /// `true` when this is a status reply carrying `0x4E` (explicit failure).
    pub fn status_err(&self) -> bool {
        matches!(self, Response::Data { data, .. } if data.as_slice() == [STATE_ERR])
    }
}

/// Validate and decode one reply frame addressed to `addr`.
///
/// Returns `None` for anything that is not a well-formed frame for this address:
/// wrong precode, wrong length nibble, bad CRC, or a foreign address. The device
/// applies the same rules to our requests (разд. 9) — a malformed frame is
/// silently dropped, never answered.
pub fn decode_response(addr: u8, frame: &[u8]) -> Option<Response> {
    if frame.len() < MIN_FRAME_LEN || frame[0] != PRECODE || frame[1] != addr {
        return None;
    }
    if frame[2] & 0xF0 != LEN_HIGH {
        return None;
    }
    let len = (frame[2] & 0x0F) as usize;
    // The length byte counts everything after itself, so the whole frame is
    // precode + addr + len byte + len.
    if frame.len() != len + 3 || len < 2 {
        return None;
    }
    let expect = crc(&frame[..frame.len() - 1]);
    if expect != frame[frame.len() - 1] {
        return None;
    }
    let cmd = frame[frame.len() - 2];
    let data = &frame[3..frame.len() - 2];
    if data.is_empty() {
        Some(Response::General { cmd })
    } else {
        Some(Response::Data {
            cmd,
            data: data.to_vec(),
        })
    }
}

/// Split the first complete frame out of `buf`, tolerating leading noise.
///
/// Returns the frame and how many bytes of `buf` it consumed (including any
/// skipped garbage). RS-485 turnaround can leave partial frames on the line, so
/// callers accumulate and re-try rather than treating a short read as an error.
pub fn take_frame(buf: &[u8]) -> Option<(Vec<u8>, usize)> {
    for start in 0..buf.len() {
        if buf[start] != PRECODE {
            continue;
        }
        let rest = &buf[start..];
        if rest.len() < MIN_FRAME_LEN {
            return None; // maybe complete once more bytes arrive
        }
        if rest[2] & 0xF0 != LEN_HIGH {
            continue; // not a frame header after all — keep scanning
        }
        let total = (rest[2] & 0x0F) as usize + 3;
        if total < MIN_FRAME_LEN {
            continue;
        }
        if rest.len() < total {
            return None; // incomplete
        }
        return Some((rest[..total].to_vec(), start + total));
    }
    None
}

/// Encode `value` as `len` BCD bytes, most significant byte first (разд. 5).
///
/// Returns `None` when the value needs more digits than `len` bytes provide,
/// so an over-large price or dose is refused instead of silently truncated.
pub fn encode_bcd(value: u64, len: usize) -> Option<Vec<u8>> {
    let mut out = vec![0u8; len];
    let mut v = value;
    for slot in out.iter_mut().rev() {
        *slot = ((v % 10) as u8) | (((v / 10 % 10) as u8) << 4);
        v /= 100;
    }
    if v != 0 {
        return None; // did not fit
    }
    Some(out)
}

/// Decode BCD bytes, most significant first. `None` if any nibble is not a
/// decimal digit — a corrupted field must not silently read as a plausible number.
pub fn decode_bcd(bytes: &[u8]) -> Option<u64> {
    let mut acc: u64 = 0;
    for b in bytes {
        let hi = (b >> 4) as u64;
        let lo = (b & 0x0F) as u64;
        if hi > 9 || lo > 9 {
            return None;
        }
        acc = acc.checked_mul(100)?.checked_add(hi * 10 + lo)?;
    }
    Some(acc)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Frames from разд. 8, byte-for-byte ───────────────────────────────────

    #[test]
    fn spec_status_poll_request() {
        assert_eq!(
            build_request(0x01, 0xD5, &[]).unwrap(),
            vec![0xF5, 0x01, 0xA2, 0xD5, 0x03]
        );
    }

    #[test]
    fn spec_set_price_request() {
        // Цена 5450 → 3 BCD bytes 00 54 50.
        let data = encode_bcd(5450, 3).unwrap();
        assert_eq!(data, vec![0x00, 0x54, 0x50]);
        assert_eq!(
            build_request(0x01, 0xB2, &data).unwrap(),
            vec![0xF5, 0x01, 0xA5, 0x00, 0x54, 0x50, 0xB2, 0x67]
        );
    }

    #[test]
    fn spec_dose_by_volume_request() {
        // 50,00 л → 5000 сотых, 4 BCD bytes.
        let data = encode_bcd(5000, 4).unwrap();
        assert_eq!(data, vec![0x00, 0x00, 0x50, 0x00]);
        assert_eq!(
            build_request(0x01, 0xB9, &data).unwrap(),
            vec![0xF5, 0x01, 0xA6, 0x00, 0x00, 0x50, 0x00, 0xB9, 0x3B]
        );
    }

    #[test]
    fn spec_status_reply_decodes_to_state_byte() {
        // F5 01 A3 08 D5 CRC — удалённый режим, простой.
        let mut f = vec![0xF5, 0x01, 0xA3, 0x08, 0xD5];
        f.push(crc(&f));
        let r = decode_response(0x01, &f).unwrap();
        assert_eq!(r.cmd(), 0xD5);
        assert_eq!(r.data(), [0x08]);
    }

    #[test]
    fn general_and_status_replies_are_distinguished_by_payload() {
        let mut gen = vec![0xF5, 0x01, 0xA2, 0xB9];
        gen.push(crc(&gen));
        assert_eq!(
            decode_response(0x01, &gen).unwrap(),
            Response::General { cmd: 0xB9 }
        );

        let mut ok = vec![0xF5, 0x01, 0xA3, STATE_OK, 0xC3];
        ok.push(crc(&ok));
        let r = decode_response(0x01, &ok).unwrap();
        assert!(r.status_ok() && !r.status_err());

        let mut err = vec![0xF5, 0x01, 0xA3, STATE_ERR, 0xC3];
        err.push(crc(&err));
        let r = decode_response(0x01, &err).unwrap();
        assert!(r.status_err() && !r.status_ok());
    }

    // ── Rejection rules (разд. 9) ────────────────────────────────────────────

    #[test]
    fn bad_crc_is_rejected() {
        let mut f = vec![0xF5, 0x01, 0xA3, 0x08, 0xD5];
        f.push(crc(&f) ^ 0x01);
        assert!(decode_response(0x01, &f).is_none());
    }

    #[test]
    fn foreign_address_is_rejected() {
        let mut f = vec![0xF5, 0x02, 0xA3, 0x08, 0xD5];
        f.push(crc(&f));
        assert!(decode_response(0x01, &f).is_none(), "addr 2 is not ours");
        assert!(decode_response(0x02, &f).is_some(), "addr 2 owns it");
    }

    #[test]
    fn wrong_precode_or_length_nibble_is_rejected() {
        let mut bad_precode = vec![0xF6, 0x01, 0xA3, 0x08, 0xD5];
        bad_precode.push(crc(&bad_precode));
        assert!(decode_response(0x01, &bad_precode).is_none());

        // High nibble must be 0xA.
        let mut bad_len = vec![0xF5, 0x01, 0xB3, 0x08, 0xD5];
        bad_len.push(crc(&bad_len));
        assert!(decode_response(0x01, &bad_len).is_none());
    }

    #[test]
    fn length_nibble_must_match_actual_frame_length() {
        // Claims 4 trailing bytes but carries 3.
        let mut f = vec![0xF5, 0x01, 0xA4, 0x08, 0xD5];
        f.push(crc(&f));
        assert!(decode_response(0x01, &f).is_none());
    }

    #[test]
    fn truncated_frame_is_rejected() {
        assert!(decode_response(0x01, &[0xF5, 0x01, 0xA2, 0xD5]).is_none());
    }

    // ── Framing out of a noisy stream ────────────────────────────────────────

    #[test]
    fn take_frame_skips_leading_noise() {
        let mut f = vec![0xF5, 0x01, 0xA3, 0x08, 0xD5];
        f.push(crc(&f));
        let mut buf = vec![0x00, 0xFF];
        buf.extend_from_slice(&f);
        let (got, used) = take_frame(&buf).unwrap();
        assert_eq!(got, f);
        assert_eq!(used, buf.len());
    }

    #[test]
    fn take_frame_waits_for_incomplete_tail() {
        assert!(take_frame(&[0xF5, 0x01, 0xA6, 0x00]).is_none());
        assert!(take_frame(&[]).is_none());
    }

    // ── BCD (разд. 5) ────────────────────────────────────────────────────────

    #[test]
    fn spec_bcd_examples() {
        assert_eq!(encode_bcd(123456, 3).unwrap(), vec![0x12, 0x34, 0x56]);
        assert_eq!(encode_bcd(5450, 3).unwrap(), vec![0x00, 0x54, 0x50]);
        assert_eq!(decode_bcd(&[0x12, 0x34, 0x56]).unwrap(), 123456);
    }

    #[test]
    fn bcd_round_trips_across_field_widths() {
        for (v, len) in [(0u64, 3), (99999, 3), (5000, 4), (99_999_999, 4), (1, 6)] {
            let enc = encode_bcd(v, len).unwrap();
            assert_eq!(enc.len(), len);
            assert_eq!(
                decode_bcd(&enc).unwrap(),
                v,
                "round trip {v} in {len} bytes"
            );
        }
    }

    #[test]
    fn bcd_refuses_values_that_do_not_fit() {
        assert_eq!(
            encode_bcd(1_000_000, 3),
            None,
            "7 digits do not fit 3 bytes"
        );
        assert!(encode_bcd(999_999, 3).is_some());
    }

    #[test]
    fn bcd_rejects_non_decimal_nibbles() {
        assert_eq!(decode_bcd(&[0x1A]), None);
        assert_eq!(decode_bcd(&[0xF0]), None);
    }

    #[test]
    fn build_request_refuses_oversized_payload() {
        assert!(build_request(0x01, 0xB2, &[0u8; MAX_DATA_LEN]).is_some());
        assert!(build_request(0x01, 0xB2, &[0u8; MAX_DATA_LEN + 1]).is_none());
    }

    #[test]
    fn crc_is_seven_bit() {
        // Every CRC must have the top bit clear, whatever the payload.
        for b in 0u8..=255 {
            let f = build_request(b, 0xD5, &[b, b ^ 0xFF]).unwrap();
            assert_eq!(f[f.len() - 1] & 0x80, 0);
        }
    }

    #[test]
    fn built_requests_decode_back() {
        // A request and a reply share one frame format, so our own frames must
        // survive the validator that guards inbound traffic.
        let f = build_request(0x07, 0xB9, &encode_bcd(1234, 4).unwrap()).unwrap();
        let r = decode_response(0x07, &f).unwrap();
        assert_eq!(r.cmd(), 0xB9);
        assert_eq!(decode_bcd(r.data()).unwrap(), 1234);
    }
}
