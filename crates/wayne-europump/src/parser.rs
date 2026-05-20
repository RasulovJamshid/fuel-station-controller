use crate::crc::crc16;
use crate::frame::Frame;

pub fn decode_volume(v1: u8, v2: u8) -> f64 {
    let digits = format!("{:02X}{:02X}", v1, v2);
    digits.parse::<f64>().unwrap_or(0.0) / 100.0
}

pub fn decode_amount(a1: u8, a2: u8, a3: u8) -> u64 {
    let digits = format!("{:02X}{:02X}{:02X}", a1, a2, a3);
    digits.parse::<u64>().unwrap_or(0)
}

/// Returns true if the byte is a valid Wayne Europump frame-start (bus address).
///
/// Per the protocol doc §11.1, valid dispenser addresses are `0x50–0x6F`.
/// Some direct-RS-485 firmware sets bit 7 on the address in responses, so
/// `0xD0–0xEF` (= `0x50–0x6F | 0x80`) is also accepted and stripped later.
/// Known RS232 bus-turnaround garbage bytes (BC, FE, FC, B8, DC, FF, DE, F8)
/// all fall outside both accepted ranges and are therefore rejected.
#[inline]
fn is_valid_addr_byte(b: u8) -> bool {
    (0x50..=0x6F).contains(&b) || (0xD0..=0xEF).contains(&b)
}

/// Strip leading non-frame bytes.
///
/// Accepts plain Wayne addresses (0x50–0x6F) and their high-bit variants
/// (0xD0–0xEF) that some Wayne firmware sets in responses.
///
/// **RS-485 turnaround rule:** when a byte in 0xD0–0xEF is immediately followed
/// by a normal address byte (0x50–0x6F), the high-bit byte is an RS-485
/// bus-direction-switching artefact and is skipped as garbage.
fn trim_garbage_prefix(buf: &[u8]) -> &[u8] {
    let mut start = 0;
    while start < buf.len() {
        let b = buf[start];
        if !is_valid_addr_byte(b) {
            start += 1;
            continue;
        }
        // High-bit byte immediately before a normal address → RS-485 garbage, skip.
        if (0xD0..=0xEF).contains(&b)
            && start + 1 < buf.len()
            && (0x50..=0x6F).contains(&buf[start + 1])
        {
            start += 1;
            continue;
        }
        return &buf[start..];
    }
    &[]
}

fn verify_crc(body: &[u8]) -> bool {
    if body.len() < 4 {
        return false;
    }
    let n = body.len();
    let data = &body[..n - 4];
    let ck1 = body[n - 4];
    let ck2 = body[n - 3];
    let crc = crc16(data);
    if ck1 == (crc & 0xFF) as u8 && ck2 == (crc >> 8) as u8 {
        return true;
    }
    // Some Wayne firmware computes CRC over the address-bit-cleared byte even when
    // the address byte is transmitted with bit 7 set.  Try the normalised variant.
    if !data.is_empty() && data[0] & 0x80 != 0 {
        let mut norm = data.to_vec();
        norm[0] &= 0x7F;
        let crc2 = crc16(&norm);
        return ck1 == (crc2 & 0xFF) as u8 && ck2 == (crc2 >> 8) as u8;
    }
    false
}

fn is_short_frame(buf: &[u8]) -> bool {
    if buf.len() < 3 {
        return false;
    }
    if !is_valid_addr_byte(buf[0]) {
        return false;
    }
    // 0x20 = poll (PC→DISP), 0x70 = idle, 0xC0 = authorize-ack, 0xC1 = stop-ack
    matches!(buf[1], 0x20 | 0x70 | 0xC0 | 0xC1) && buf[2] == 0xFA
}

/// Parse one complete raw buffer (short frame 3 bytes, or CRC frame ending with `03 FA`).
///
/// Some Wayne RS-485 firmware sets bit 7 on the address byte in responses
/// (e.g. dispenser 0x51 replies with 0xD1). We normalise by masking `& 0x7F`
/// so the returned `addr` always matches the configured `address_byte`.
pub fn parse_frame(raw: &[u8]) -> Frame {
    let raw = trim_garbage_prefix(raw);
    if raw.is_empty() {
        return Frame::Unknown(vec![]);
    }

    // Normalise address: strip the high bit that some Wayne variants set in responses.
    let addr = raw[0] & 0x7F;

    if raw.len() >= 3 && is_short_frame(raw) {
        match raw[1] {
            0x20 => return Frame::Poll { addr },
            0x70 => return Frame::Idle { addr },
            0xC0 | 0xC1 => return Frame::AckC0 { addr },
            _ => {}
        }
    }

    let n = raw.len();
    if n >= 4 && raw[n - 2] == 0x03 && raw[n - 1] == 0xFA {
        // CRC is verified over the raw bytes (including high-bit address if present).
        if !verify_crc(raw) {
            return Frame::Unknown(raw.to_vec());
        }
        let inner = &raw[..n - 4];
        if inner.len() < 2 {
            return Frame::Unknown(raw.to_vec());
        }
        // addr is already normalised above; seq is always the second byte of inner.
        let seq = inner[1];
        if !(0x31..=0x3F).contains(&seq) {
            return Frame::Unknown(raw.to_vec());
        }
        if inner.len() >= 8 && inner[2] == 0x03 && inner[3] == 0x04 && inner[4] == 0x01 {
            return Frame::NozzleUp {
                addr,
                seq,
                product: inner[5],
                nozzle: inner[7],
            };
        }
        if inner.len() >= 12 && inner[2] == 0x02 && inner[3] == 0x08 {
            let sale_complete = inner.len() >= 17
                && inner[inner.len() - 3] == 0x01
                && inner[inner.len() - 2] == 0x01
                && inner[inner.len() - 1] == 0x01;
            return Frame::Data {
                addr,
                seq,
                volume_l: inner[6],
                volume_h: inner[7],
                amount: [inner[9], inner[10], inner[11]],
                sale_complete,
            };
        }
        if inner.len() >= 5 && inner[2] == 0x01 && inner[3] == 0x01 {
            match inner[4] {
                // Standalone dispenser state: IDLE (ghost-fill holster) — not sale DONE.
                0x05 if inner.len() == 5 => return Frame::DispenserIdle { addr, seq },
                0x05 => return Frame::TransactionComplete { addr, seq },
                0x01 => return Frame::Stopped { addr, seq },
                // Nozzle holstered / post-stop idle (§5.5) — not a lift.
                0x02 | 0x00 => return Frame::NozzleHolstered { addr, seq },
                _ => {}
            }
        }
    }

    Frame::Unknown(raw.to_vec())
}

#[derive(Debug, Default)]
pub struct FrameAccumulator {
    buf: Vec<u8>,
}

/// Maximum bytes buffered without finding a `03 FA` terminator before we
/// clear the buffer (§11.3 rule 6: "Buffer overflow (>64 bytes)").
const MAX_BUF: usize = 64;

impl FrameAccumulator {
    /// Discard any partial frame left from a previous poll (another address).
    pub fn clear(&mut self) {
        self.buf.clear();
    }

    pub fn push_bytes(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            self.trim_leading_garbage();
            if self.buf.is_empty() {
                break;
            }
            if self.buf.len() >= 3 && is_short_frame(&self.buf) {
                out.push(self.buf.drain(..3).collect());
                continue;
            }
            if let Some(pos) = find_03fa(&self.buf) {
                let frame = self.buf.drain(..=pos).collect::<Vec<_>>();
                out.push(frame);
                continue;
            }
            // §11.3 rule 6: clear if buffer overflows without a terminator.
            if self.buf.len() > MAX_BUF {
                self.buf.clear();
            }
            break;
        }
        out
    }

    fn trim_leading_garbage(&mut self) {
        loop {
            let Some(i) = self.buf.iter().position(|&b| is_valid_addr_byte(b)) else {
                break;
            };
            if i > 0 {
                self.buf.drain(..i);
            }
            // An RS485 half-duplex bus produces a spurious byte as the TX→RX line
            // floats during direction switching.  That byte can fall in the 0xD0–0xEF
            // range (e.g. 0xD2 for the Pump-2 slot).  If the byte at position 0 is
            // in that range AND the very next byte is a real Wayne address (0x50–0x6F),
            // the high-bit byte is that bus-turnaround garbage — strip it and re-scan.
            if (0xD0..=0xEF).contains(&self.buf[0])
                && self.buf.len() >= 2
                && (0x50..=0x6F).contains(&self.buf[1])
            {
                self.buf.drain(..1);
                // loop — check again after stripping
            } else {
                break;
            }
        }
    }
}

fn find_03fa(buf: &[u8]) -> Option<usize> {
    if buf.len() < 2 {
        return None;
    }
    for i in 1..buf.len() {
        if buf[i - 1] == 0x03 && buf[i] == 0xFA {
            return Some(i);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_short() {
        match parse_frame(&[0x52, 0x70, 0xFA]) {
            Frame::Idle { addr } => assert_eq!(addr, 0x52),
            f => panic!("{:?}", f),
        }
    }

    #[test]
    fn garbage_prefix_stripped() {
        match parse_frame(&[0x00, 0x52, 0x70, 0xFA]) {
            Frame::Idle { addr } => assert_eq!(addr, 0x52),
            f => panic!("{:?}", f),
        }
    }

    /// Wayne RS-485 firmware variants set bit-7 on the address in responses.
    /// 0xD2 = 0x52 | 0x80 — pump 3 idle with high-bit address.
    #[test]
    fn high_bit_addr_idle() {
        match parse_frame(&[0xD2, 0x70, 0xFA]) {
            Frame::Idle { addr } => assert_eq!(addr, 0x52),
            f => panic!("{:?}", f),
        }
    }

    #[test]
    fn high_bit_addr_ack() {
        match parse_frame(&[0xD1, 0xC0, 0xFA]) {
            Frame::AckC0 { addr } => assert_eq!(addr, 0x51),
            f => panic!("{:?}", f),
        }
    }

    #[test]
    fn stop_ack_c1() {
        match parse_frame(&[0x51, 0xC1, 0xFA]) {
            Frame::AckC0 { addr } => assert_eq!(addr, 0x51),
            f => panic!("{:?}", f),
        }
    }

    #[test]
    fn accumulator_high_bit_addr() {
        let mut acc = FrameAccumulator::default();
        // Dispenser 0x51 sends idle with high-bit address byte 0xD1
        let frames = acc.push_bytes(&[0xD1, 0x70, 0xFA]);
        assert_eq!(frames.len(), 1);
        match parse_frame(&frames[0]) {
            Frame::Idle { addr } => assert_eq!(addr, 0x51),
            f => panic!("{:?}", f),
        }
    }

    /// RS-485 bus-turnaround garbage byte (0xD2) precedes a normal 0x52 frame.
    /// The high-bit byte must be stripped and the real IDLE parsed correctly.
    #[test]
    fn rs485_turnaround_garbage_before_idle() {
        // Pattern: [D2 garbage][52 70 FA idle frame]
        let mut acc = FrameAccumulator::default();
        let frames = acc.push_bytes(&[0xD2, 0x52, 0x70, 0xFA]);
        assert_eq!(frames.len(), 1, "expected exactly one frame, got {:?}", frames);
        match parse_frame(&frames[0]) {
            Frame::Idle { addr } => assert_eq!(addr, 0x52),
            f => panic!("expected Idle, got {:?}", f),
        }
    }

    /// Two polls in one read: D2-garbage+P2-IDLE and D3-garbage+P3-IDLE.
    #[test]
    fn rs485_turnaround_garbage_two_idles() {
        let mut acc = FrameAccumulator::default();
        let frames = acc.push_bytes(&[0xD2, 0x52, 0x70, 0xFA, 0xD3, 0x53, 0x70, 0xFA]);
        assert_eq!(frames.len(), 2);
        match parse_frame(&frames[0]) {
            Frame::Idle { addr } => assert_eq!(addr, 0x52),
            f => panic!("frame0: {:?}", f),
        }
        match parse_frame(&frames[1]) {
            Frame::Idle { addr } => assert_eq!(addr, 0x53),
            f => panic!("frame1: {:?}", f),
        }
    }

    /// A legitimate high-bit address long frame should still be accepted.
    /// Frame bytes from the wayne3940.log (P3 / addr 0x53) but with bit-7 set
    /// on the address byte → 0xD3.  verify_crc's normalise-fallback strips the
    /// high bit and recomputes CRC over 0x53, which matches the stored 0x29BF.
    #[test]
    fn high_bit_addr_nozzle_up_accepted() {
        // Real log frame: 53 3A 03 04 01 05 00 12 BF 29 03 FA  (CRC over [53 3A …])
        // Simulate dispenser sending same frame with bit-7 set on address: D3 3A …
        let raw = &[0xD3u8, 0x3A, 0x03, 0x04, 0x01, 0x05, 0x00, 0x12, 0xBF, 0x29, 0x03, 0xFA];
        let frame = parse_frame(raw);
        match frame {
            Frame::NozzleUp { addr, seq, product, nozzle } => {
                assert_eq!(addr, 0x53);
                assert_eq!(seq, 0x3A);
                assert_eq!(product, 0x05);
                assert_eq!(nozzle, 0x12);
            }
            f => panic!("expected NozzleUp, got {:?}", f),
        }
    }

    #[test]
    fn dispenser_idle_short_frame() {
        // Ghost fill holster: 53 3A 01 01 05 18 87 03 FA (from sniffer log)
        let raw = &[0x53u8, 0x3A, 0x01, 0x01, 0x05, 0x18, 0x87, 0x03, 0xFA];
        match parse_frame(raw) {
            Frame::DispenserIdle { addr, seq } => {
                assert_eq!(addr, 0x53);
                assert_eq!(seq, 0x3A);
            }
            f => panic!("expected DispenserIdle, got {:?}", f),
        }
    }

    #[test]
    fn fill_frame_with_sale_complete_tail() {
        // Full fill end: 52 39 02 08 ... 01 01 05 01 01 01 (from sniffer log)
        let raw = &[
            0x52, 0x39, 0x02, 0x08, 0x00, 0x00, 0x23, 0x00, 0x00, 0x24, 0x15, 0x00, 0x01, 0x01,
            0x05, 0x01, 0x01, 0x01, 0xB9, 0x57, 0x03, 0xFA,
        ];
        match parse_frame(raw) {
            Frame::Data {
                sale_complete,
                volume_l,
                volume_h,
                ..
            } => {
                assert!(sale_complete);
                assert_eq!(decode_volume(volume_l, volume_h), 23.0);
            }
            f => panic!("expected Data, got {:?}", f),
        }
    }
}
