//! Low-level AZT 2.0 framing: complementary-byte encoding and checksum.
//!
//! Physical layer (informational — configured in `site.config.json`): RS-485
//! half-duplex, 4800 baud, 7 data bits, parity, 2 stop bits.
//!
//! Frame shape (см. протокол ОАО АЗТ, разд. 2):
//!
//! ```text
//! DEL  STX  [addr addr'] [cmd cmd'] [d0 d0' d1 d1' ...]  ETX ETX  CheckSum
//! ```
//!
//! - `DEL` (0x7F) is a lead-in that RX must ignore; it covers the RS-485
//!   transceiver TX→RX turnaround so no real byte is lost.
//! - Every logical byte between the start byte and `ETX` is followed by its
//!   *complementary* byte — a 7-bit bitwise inversion.
//! - `CheckSum = (XOR of every normal byte and one ETX) | 0x40`. The start byte,
//!   `DEL`, and the complementary bytes are excluded from the XOR.

/// Lead-in byte, ignored by the receiver (covers RS-485 turnaround).
pub const DEL: u8 = 0x7F;
/// Start byte for the master (SU) with address offset 0.
pub const STX: u8 = 0x02;
/// Stop byte (sent twice before the checksum).
pub const ETX: u8 = 0x03;

/// Short-response bytes a TRK may return in place of a full frame.
pub const ACK: u8 = 0x06; // data accepted, command executed
pub const NAK: u8 = 0x15; // command not in the SU command set
pub const CAN: u8 = 0x18; // accepted but cannot be executed in this state

/// 7-bit complement of a byte, as used for every payload byte on the wire.
///
/// The bus is 7 data bits, so the inversion is masked to 7 bits:
/// `0x21 → 0x5E`, `0x31 → 0x4E`.
#[inline]
pub fn complement(b: u8) -> u8 {
    !b & 0x7F
}

/// Network-address byte for an address within one 15-address offset: `0x20 | n`.
#[inline]
pub fn address_byte(n: u8) -> u8 {
    0x20 | (n & 0x0F)
}

/// Start byte selecting the address offset for network numbers above 15.
///
/// Offset 0 → `STX` (0x02), offset 15 → `BEL` (0x07), offset 30 → `BS` (0x08), …
/// (см. разд. 3). `offset_index` is `0` for addresses 1..=15, `1` for 16..=30, etc.
#[inline]
pub fn start_byte_for_offset(offset_index: u8) -> u8 {
    if offset_index == 0 {
        STX
    } else {
        0x06 + offset_index
    }
}

/// Push a normal byte followed by its complement.
fn push_pair(out: &mut Vec<u8>, b: u8) {
    out.push(b);
    out.push(complement(b));
}

/// Compute the checksum over the collected normal bytes.
///
/// `CheckSum = (b0 ^ b1 ^ … ^ ETX) | 0x40` (start byte and complements excluded).
pub fn checksum(normal_bytes: &[u8]) -> u8 {
    let xored = normal_bytes.iter().fold(ETX, |acc, &b| acc ^ b);
    xored | 0x40
}

fn split_network_address(n: u8) -> (u8, u8) {
    let zero_based = n.saturating_sub(1);
    let offset_index = zero_based / 15;
    let local = (zero_based % 15) + 1;
    (start_byte_for_offset(offset_index), address_byte(local))
}

/// Build a complete addressed request frame (Variant 1, разд. 2.1).
///
/// `addr` is the AZT network number. Addresses 1..=15 use offset 0 (`STX`);
/// addresses 16..=30 use offset 15 (`BEL`), and so on. `cmd` is the command byte;
/// `data` are the raw payload bytes (already digit-encoded by the caller). The
/// returned buffer is ready to transmit: `DEL <start> <pairs> ETX ETX CheckSum`.
pub fn build_request(addr: u8, cmd: u8, data: &[u8]) -> Vec<u8> {
    let (start, addr_byte) = split_network_address(addr);
    build_request_with_start(start, addr_byte, cmd, data)
}

/// Build a request with an explicit start byte and pre-formed address byte.
///
/// Broadcast commands (e.g. `W`, разд. 7.18) omit the address entirely — pass
/// `addr_byte = None`.
pub fn build_request_with_start(start: u8, addr_byte: u8, cmd: u8, data: &[u8]) -> Vec<u8> {
    build_frame(start, Some(addr_byte), cmd, data)
}

/// Build a broadcast request (no network address), разд. 7.18.
pub fn build_broadcast(cmd: u8, data: &[u8]) -> Vec<u8> {
    build_frame(STX, None, cmd, data)
}

fn build_frame(start: u8, addr_byte: Option<u8>, cmd: u8, data: &[u8]) -> Vec<u8> {
    let mut out = vec![DEL, start];
    let mut normal: Vec<u8> = Vec::with_capacity(2 + data.len());

    if let Some(a) = addr_byte {
        push_pair(&mut out, a);
        normal.push(a);
    }
    push_pair(&mut out, cmd);
    normal.push(cmd);
    for &b in data {
        push_pair(&mut out, b);
        normal.push(b);
    }

    out.push(ETX);
    out.push(ETX);
    out.push(checksum(&normal));
    out
}

/// Build a TRK→SU data-frame response (разд. 2.2): `DEL STX <pairs> ETX ETX CS`.
///
/// Used by simulators/tests to answer as a dispenser; the service decodes it
/// with [`decode_response`].
pub fn encode_data_response(data: &[u8]) -> Vec<u8> {
    let mut out = vec![DEL, STX];
    for &b in data {
        push_pair(&mut out, b);
    }
    out.push(ETX);
    out.push(ETX);
    out.push(checksum(data));
    out
}

/// Build a TRK short response (`ACK`/`NAK`/`CAN`), preceded by `DEL`.
pub fn encode_short_response(code: u8) -> Vec<u8> {
    vec![DEL, code]
}

/// An SU→TRK request extracted from a receive buffer (TRK side; used by the
/// simulator).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrkRequest {
    /// Resolved network address (offset + 1..=15). `None` for broadcast /
    /// address-less commands (e.g. `W` 0x57, `]` 0x5D).
    pub addr: Option<u8>,
    /// Command byte.
    pub cmd: u8,
    /// Payload bytes (normal form, complements stripped).
    pub data: Vec<u8>,
}

/// Extract the next complete SU request from `accum`, consuming it (and any
/// preceding garbage). Returns `None` when no complete frame is buffered yet.
///
/// Handles all master start bytes (`STX`, `BEL`..`DC4` — each selecting an
/// address offset, разд. 3), verifies complements and the checksum, and skips
/// malformed candidates rather than stalling. The accumulator is bounded: if it
/// grows past 300 bytes without a valid frame, the oldest bytes are dropped.
pub fn pop_request(accum: &mut Vec<u8>) -> Option<TrkRequest> {
    loop {
        // Locate a master start byte.
        let start = accum
            .iter()
            .position(|&b| b == STX || (0x07..=0x14).contains(&b))?;
        let offset = if accum[start] == STX {
            0u8
        } else {
            (accum[start] - 0x06) * 15
        };

        match parse_request_body(&accum[start + 1..]) {
            BodyParse::Complete(consumed, normal) => {
                accum.drain(..start + 1 + consumed);
                let (addr, rest) = match normal.split_first() {
                    Some((&first, rest)) if (0x21..=0x2F).contains(&first) => {
                        (Some(offset + (first & 0x0F)), rest)
                    }
                    _ => (None, &normal[..]),
                };
                let (&cmd, data) = rest.split_first()?;
                return Some(TrkRequest {
                    addr,
                    cmd,
                    data: data.to_vec(),
                });
            }
            BodyParse::Incomplete => {
                // Wait for more bytes — but bound the buffer against a
                // never-completing mangled frame.
                if accum.len() > 300 {
                    accum.drain(..start + 1);
                    continue;
                }
                return None;
            }
            BodyParse::Malformed => {
                // Drop through this start byte and keep scanning.
                accum.drain(..start + 1);
            }
        }
    }
}

enum BodyParse {
    /// (bytes consumed after the start byte, normal payload)
    Complete(usize, Vec<u8>),
    Incomplete,
    Malformed,
}

fn parse_request_body(body: &[u8]) -> BodyParse {
    let mut normal = Vec::new();
    let mut idx = 0;
    loop {
        let Some(&b) = body.get(idx) else {
            return BodyParse::Incomplete;
        };
        if b == ETX {
            let Some(&second) = body.get(idx + 1) else {
                return BodyParse::Incomplete;
            };
            if second != ETX {
                return BodyParse::Malformed;
            }
            let Some(&cs) = body.get(idx + 2) else {
                return BodyParse::Incomplete;
            };
            if cs != checksum(&normal) {
                return BodyParse::Malformed;
            }
            return BodyParse::Complete(idx + 3, normal);
        }
        let Some(&comp) = body.get(idx + 1) else {
            return BodyParse::Incomplete;
        };
        if comp != complement(b) {
            return BodyParse::Malformed;
        }
        normal.push(b);
        idx += 2;
    }
}

/// A decoded TRK response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Response {
    /// Short response: `ACK`, `NAK`, or `CAN`.
    Short(u8),
    /// Full data frame: the normal (de-complemented) data bytes between `STX`
    /// and `ETX`.
    Data(Vec<u8>),
}

/// Decode a TRK response buffer (разд. 2.2), tolerating leading `DEL`/noise.
///
/// Scans for the first `STX` (full frame) or short-response byte. For a full
/// frame it verifies each complementary byte and the trailing checksum, and
/// returns the normal data bytes. Returns `None` if no valid frame is present.
pub fn decode_response(buf: &[u8]) -> Option<Response> {
    for (i, &b) in buf.iter().enumerate() {
        match b {
            ACK | NAK | CAN => return Some(Response::Short(b)),
            STX => {
                if let Some(data) = decode_data_frame(&buf[i + 1..]) {
                    return Some(Response::Data(data));
                }
            }
            _ => {}
        }
    }
    None
}

/// Decode the body after `STX`: complement-checked data bytes up to `ETX ETX`,
/// then a checksum byte that must match.
fn decode_data_frame(body: &[u8]) -> Option<Vec<u8>> {
    let mut data = Vec::new();
    let mut idx = 0;
    while idx < body.len() {
        let b = body[idx];
        if b == ETX {
            // Expect ETX ETX CheckSum.
            if body.get(idx + 1) != Some(&ETX) {
                return None;
            }
            let cs = *body.get(idx + 2)?;
            if cs != checksum(&data) {
                return None;
            }
            return Some(data);
        }
        // Normal byte + complement pair.
        let comp = *body.get(idx + 1)?;
        if comp != complement(b) {
            return None;
        }
        data.push(b);
        idx += 2;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complement_is_7bit_inverse() {
        assert_eq!(complement(0x21), 0x5E); // address 1
        assert_eq!(complement(0x31), 0x4E); // command '1'
        assert_eq!(complement(0x30), 0x4F); // digit '0'
        assert_eq!(complement(0x39), 0x46); // digit '9'
        assert_eq!(complement(ETX), 0x7C);
        // Applying twice is identity within 7 bits.
        for b in 0u8..=0x7F {
            assert_eq!(complement(complement(b)), b);
        }
    }

    #[test]
    fn address_and_start_bytes() {
        assert_eq!(address_byte(1), 0x21);
        assert_eq!(address_byte(15), 0x2F);
        assert_eq!(start_byte_for_offset(0), 0x02);
        assert_eq!(start_byte_for_offset(1), 0x07);
        assert_eq!(start_byte_for_offset(2), 0x08);
    }

    #[test]
    fn request_address_16_uses_first_offset() {
        let f = build_request(16, 0x31, &[]);
        assert_eq!(&f[..6], &[DEL, 0x07, 0x21, 0x5E, 0x31, 0x4E]);
        assert_eq!(f[8], checksum(&[0x21, 0x31]));
    }

    #[test]
    fn status_request_frame_matches_spec_layout() {
        // Разд. 7.1: DEL STX 21 5E 31 4E 03 03 CS — 9 bytes total.
        let f = build_request(1, 0x31, &[]);
        assert_eq!(f.len(), 9);
        assert_eq!(&f[..8], &[DEL, STX, 0x21, 0x5E, 0x31, 0x4E, ETX, ETX]);
        // Checksum = (0x21 ^ 0x31 ^ ETX) | 0x40.
        let expected = (0x21 ^ 0x31 ^ ETX) | 0x40;
        assert_eq!(f[8], expected);
    }

    #[test]
    fn checksum_excludes_start_and_complements() {
        // Only normal bytes (addr, cmd, data) and one ETX participate.
        let normal = [0x21u8, 0x31];
        assert_eq!(checksum(&normal), (0x21 ^ 0x31 ^ ETX) | 0x40);
        // Always has bit 6 set.
        assert_eq!(checksum(&[]) & 0x40, 0x40);
    }

    #[test]
    fn build_then_decode_data_frame_roundtrips() {
        // Assemble a TRK-style data frame with our own encoder and decode it.
        // Status '2' (authorized) response body: DATA '2' → 0x32.
        let mut frame = vec![DEL, STX];
        for &b in &[0x32u8] {
            frame.push(b);
            frame.push(complement(b));
        }
        frame.push(ETX);
        frame.push(ETX);
        frame.push(checksum(&[0x32]));

        assert_eq!(decode_response(&frame), Some(Response::Data(vec![0x32])));
    }

    #[test]
    fn decode_short_responses() {
        assert_eq!(decode_response(&[DEL, ACK]), Some(Response::Short(ACK)));
        assert_eq!(decode_response(&[DEL, CAN]), Some(Response::Short(CAN)));
        assert_eq!(decode_response(&[NAK]), Some(Response::Short(NAK)));
    }

    #[test]
    fn decode_rejects_bad_complement() {
        let frame = vec![
            STX,
            0x32,
            0x00, /* wrong comp */
            ETX,
            ETX,
            checksum(&[0x32]),
        ];
        assert_eq!(decode_response(&frame), None);
    }

    #[test]
    fn decode_rejects_bad_checksum() {
        let frame = vec![STX, 0x32, complement(0x32), ETX, ETX, 0x00];
        assert_eq!(decode_response(&frame), None);
    }

    #[test]
    fn encode_data_response_roundtrips() {
        let f = encode_data_response(b"40");
        assert_eq!(decode_response(&f), Some(Response::Data(b"40".to_vec())));
        assert_eq!(encode_short_response(ACK), vec![DEL, ACK]);
    }

    #[test]
    fn pop_request_extracts_status_poll() {
        // The exact frame our own builder emits must round-trip.
        let mut accum = crate::commands::status(2);
        let req = pop_request(&mut accum).unwrap();
        assert_eq!(req.addr, Some(2));
        assert_eq!(req.cmd, 0x31);
        assert!(req.data.is_empty());
        assert!(accum.is_empty());
    }

    #[test]
    fn pop_request_with_payload_and_garbage_prefix() {
        let mut accum = vec![0x00, 0x55, DEL];
        accum.extend(crate::commands::set_price(1, 670));
        let req = pop_request(&mut accum).unwrap();
        assert_eq!(req.addr, Some(1));
        assert_eq!(req.cmd, 0x51);
        assert_eq!(req.data, b"0670");
    }

    #[test]
    fn pop_request_incomplete_waits() {
        let full = crate::commands::status(1);
        let mut accum = full[..5].to_vec();
        assert_eq!(pop_request(&mut accum), None);
        assert_eq!(accum.len(), 5, "incomplete frame must not be consumed");
        accum.extend_from_slice(&full[5..]);
        assert!(pop_request(&mut accum).is_some());
    }

    #[test]
    fn pop_request_skips_malformed_then_finds_next() {
        // Corrupt one complement byte in a first frame, follow with a good one.
        let mut bad = crate::commands::status(1);
        bad[3] ^= 0x01; // break addr complement
        let mut accum = bad;
        accum.extend(crate::commands::status(2));
        let req = pop_request(&mut accum).unwrap();
        assert_eq!(req.addr, Some(2));
    }

    #[test]
    fn pop_request_broadcast_has_no_addr() {
        let mut accum = crate::commands::set_general_param(0, 1);
        let req = pop_request(&mut accum).unwrap();
        assert_eq!(req.addr, None);
        assert_eq!(req.cmd, 0x57);
        assert_eq!(req.data, vec![0x30, 0x31]);
    }

    #[test]
    fn pop_request_two_frames_back_to_back() {
        let mut accum = crate::commands::status(1);
        accum.extend(crate::commands::authorize(1));
        assert_eq!(pop_request(&mut accum).unwrap().cmd, 0x31);
        assert_eq!(pop_request(&mut accum).unwrap().cmd, 0x32);
        assert_eq!(pop_request(&mut accum), None);
    }

    #[test]
    fn decode_tolerates_leading_del_noise() {
        let mut frame = vec![DEL, DEL, 0x00];
        frame.extend_from_slice(&[STX, 0x30, complement(0x30), ETX, ETX, checksum(&[0x30])]);
        assert_eq!(decode_response(&frame), Some(Response::Data(vec![0x30])));
    }
}
