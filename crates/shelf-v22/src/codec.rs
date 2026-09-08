//! Framing and CRC for SHELF V2.2.

pub const START_BYTE: u8 = 0x2D;
pub const MIN_FRAME_LEN: usize = 7;

/// CRC-CCITT, polynomial 0x1021, initial value 0, no reflection/final xor.
pub fn crc_ccitt(bytes: &[u8]) -> u16 {
    let mut crc = 0u16;
    for &byte in bytes {
        crc ^= (byte as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

pub fn build_request(addr: u8, index: u8, command: u8, data: &[u8]) -> Option<Vec<u8>> {
    let length = 7usize.checked_add(data.len())?;
    let length = u8::try_from(length).ok()?;
    let mut frame = Vec::with_capacity(length as usize);
    frame.extend_from_slice(&[START_BYTE, addr, index, length, command]);
    frame.extend_from_slice(data);
    let crc = crc_ccitt(&frame);
    frame.extend_from_slice(&crc.to_le_bytes());
    Some(frame)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub address: u8,
    pub index: u8,
    pub command: u8,
    pub data: Vec<u8>,
}

pub fn decode_response(addr: u8, expected_index: u8, frame: &[u8]) -> Option<Response> {
    if frame.len() < MIN_FRAME_LEN
        || frame[0] != START_BYTE
        || frame[1] != addr
        || frame[2] != expected_index
        || frame[3] as usize != frame.len()
    {
        return None;
    }
    let payload_end = frame.len() - 2;
    let received = u16::from_le_bytes([frame[payload_end], frame[payload_end + 1]]);
    if crc_ccitt(&frame[..payload_end]) != received {
        return None;
    }
    Some(Response {
        address: addr,
        index: expected_index,
        command: frame[4],
        data: frame[5..payload_end].to_vec(),
    })
}

/// Extract the first complete frame, tolerating leading echo/noise.
pub fn take_frame(buf: &[u8]) -> Option<(Vec<u8>, usize)> {
    for start in 0..buf.len() {
        if buf[start] != START_BYTE {
            continue;
        }
        let rest = &buf[start..];
        if rest.len() < 4 {
            return None;
        }
        let length = rest[3] as usize;
        if length < MIN_FRAME_LEN {
            continue;
        }
        if rest.len() < length {
            return None;
        }
        return Some((rest[..length].to_vec(), start + length));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_pdf_status_example() {
        assert_eq!(crc_ccitt(&[0x2D, 0x0F, 0x67, 0x07, 0x01]), 0x6A6D);
    }

    #[test]
    fn status_request_matches_pdf_byte_for_byte() {
        assert_eq!(
            build_request(0x0F, 0x67, 0x01, &[]).unwrap(),
            [0x2D, 0x0F, 0x67, 0x07, 0x01, 0x6D, 0x6A]
        );
    }

    #[test]
    fn response_validates_length_address_index_and_crc() {
        let frame = [0x2D, 0x0F, 0x67, 0x09, 0x81, 0x02, 0x21, 0xCB, 0x92];
        let response = decode_response(0x0F, 0x67, &frame).unwrap();
        assert_eq!(response.command, 0x81);
        assert_eq!(response.data, [0x02, 0x21]);
        assert!(decode_response(0x0E, 0x67, &frame).is_none());
        assert!(decode_response(0x0F, 0x68, &frame).is_none());
    }

    #[test]
    fn frame_scanner_skips_echo_prefix() {
        let frame = build_request(0x0F, 1, 1, &[]).unwrap();
        let mut raw = vec![0x0F, 0x99];
        raw.extend_from_slice(&frame);
        let (found, used) = take_frame(&raw).unwrap();
        assert_eq!(found, frame);
        assert_eq!(used, raw.len());
    }
}
