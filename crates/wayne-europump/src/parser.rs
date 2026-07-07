use crate::crc::crc16;
use crate::frame::Frame;

/// Decode volume from the four BCD bytes at frame positions off+2..off+5.
///
/// The `02 08` meter block carries volume as four BCD bytes:
///   `02 08 [VX1][VX2][V1][V2] 00 [A1][A2][A3]`
/// VX1/VX2 are 0x00 for volumes < 100 L and carry the hundreds/thousands
/// digits for larger fills. Together the 8 hex digits form a centilitre count:
///   e.g. 100.00 L → VX1=0x00 VX2=0x01 V1=0x00 V2=0x00 → "00010000" / 100
pub fn decode_volume(vx1: u8, vx2: u8, v1: u8, v2: u8) -> f64 {
    let digits = format!("{:02X}{:02X}{:02X}{:02X}", vx1, vx2, v1, v2);
    digits.parse::<f64>().unwrap_or(0.0) / 100.0
}

pub fn decode_amount(p0: u8, a1: u8, a2: u8, a3: u8) -> u64 {
    let digits = format!("{:02X}{:02X}{:02X}{:02X}", p0, a1, a2, a3);
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

fn try_crc(data: &[u8], ck1: u8, ck2: u8) -> bool {
    let crc = crc16(data);
    if ck1 == (crc & 0xFF) as u8 && ck2 == (crc >> 8) as u8 {
        return true;
    }
    // Some Wayne firmware sets bit-7 on the address byte but computes CRC over
    // the un-bit-set address.  Try with the high bit masked off.
    if !data.is_empty() && data[0] & 0x80 != 0 {
        let mut norm = data.to_vec();
        norm[0] &= 0x7F;
        let crc2 = crc16(&norm);
        return ck1 == (crc2 & 0xFF) as u8 && ck2 == (crc2 >> 8) as u8;
    }
    false
}

struct FillDataFields {
    volume_x1: u8,
    volume_x2: u8,
    volume_l: u8,
    volume_h: u8,
    amount: [u8; 4],
    sale_complete: bool,
    hose_product: Option<u8>,
    hose_code: Option<u8>,
}

/// Locate `02 08` meter block inside a composite data frame.
fn find_fill_data_offset(inner: &[u8]) -> Option<(usize, bool)> {
    if inner.len() >= 12 && inner[2] == 0x02 && inner[3] == 0x08 {
        return Some((2, false));
    }
    if inner.len() >= 15
        && inner[2] == 0x01
        && inner[3] == 0x01
        && inner[4] == 0x04
        && inner[5] == 0x02
        && inner[6] == 0x08
    {
        // BUSY-wrapped fill data (PC sent `30 01 01 04` keepalive during delivery).
        return Some((5, false));
    }
    for off in 2..inner.len().saturating_sub(9) {
        if inner[off] == 0x02 && inner[off + 1] == 0x08 {
            let config_echo = off >= 6 && inner[2] == 0x03 && inner[3] == 0x04 && inner[4] == 0x00;
            return Some((off, config_echo));
        }
    }
    None
}

/// Hose status from `03 04 01 PP 00 HH` / `03 04 00 PP 00 HH`, or holster derived from CONFIG echo before `02 08`.
fn embedded_hose_from_fill(
    inner: &[u8],
    off: usize,
    config_echo: bool,
) -> (Option<u8>, Option<u8>) {
    if let Some((p, h)) = scan_embedded_hose_status(inner) {
        return (Some(p), Some(h));
    }
    if config_echo && off >= 6 {
        let pp = inner[off - 2];
        let hh = inner[off - 1];
        if Frame::is_nozzle_lift_code(hh) {
            // Pump echoes last lifted hose (`0x12`); holster is `HH - 0x10` (`0x02`).
            return (Some(pp), Some(hh - 0x10));
        }
    }
    (None, None)
}

/// Live meter block: `02 08 00 00 [V1][V2] 00 [A1][A2][A3]` at `off`.
fn parse_fill_data_block(inner: &[u8]) -> Option<FillDataFields> {
    let (off, config_echo) = find_fill_data_offset(inner)?;
    if inner.len() < off + 10 {
        return None;
    }
    let sale_complete = inner[off + 10..]
        .windows(3)
        .any(|w| w[0] == 0x01 && w[1] == 0x01 && matches!(w[2], 0x01 | 0x05 | 0x06));
    let (hose_product, hose_code) = embedded_hose_from_fill(inner, off, config_echo);
    Some(FillDataFields {
        volume_x1: inner[off + 2],
        volume_x2: inner[off + 3],
        volume_l: inner[off + 4],
        volume_h: inner[off + 5],
        amount: [
            inner[off + 6],
            inner[off + 7],
            inner[off + 8],
            inner[off + 9],
        ],
        sale_complete,
        hose_product,
        hose_code,
    })
}

/// Scan for embedded hose status in composite fill / status frames.
///
/// Two variants observed in the wild:
/// - Standard: `03 04 01 [PP] 00 [HH]` — product at [i+3], hose at [i+5].
/// - Type-B:   `03 04 00 [PP] 00 [HH]` — same layout, 0x00 at [i+2] instead of 0x01.
///   An older sub-variant placed an unknown byte at [i+3] and product at [i+4];
///   detect by checking whether [i+4] is the 0x00 filler or a real product code.
pub fn scan_embedded_hose_status(body: &[u8]) -> Option<(u8, u8)> {
    if body.len() < 6 {
        return None;
    }
    let mut found = None;
    for i in 0..=body.len() - 6 {
        if body[i] == 0x03 && body[i + 1] == 0x04 {
            if body[i + 2] == 0x01 {
                // Standard: 03 04 01 PP 00 HH
                found = Some((body[i + 3], body[i + 5]));
                continue;
            }
            if body[i + 2] == 0x00 && Frame::is_nozzle_holster_code(body[i + 5]) {
                // Type-B: 03 04 00 PP 00 HH — only match holster codes here.
                // Lift codes in this position are config-echo prefixes handled elsewhere.
                let product = if body[i + 4] == 0x00 {
                    body[i + 3]
                } else {
                    body[i + 4]
                };
                found = Some((product, body[i + 5]));
            }
        }
    }
    found
}

fn verify_crc(body: &[u8]) -> bool {
    if body.len() < 4 {
        return false;
    }
    let n = body.len();
    let ck1 = body[n - 4];
    let ck2 = body[n - 3];
    // Standard: CRC covers body[..n-4]
    if try_crc(&body[..n - 4], ck1, ck2) {
        return true;
    }
    // Some Wayne firmware appends an extra status byte after the length-delimited
    // record payload but before the CRC bytes (observed on real hardware: 13-byte
    // NozzleUp with 0x10 suffix).  CRC covers body[..n-5] in that case.
    if n >= 5 {
        return try_crc(&body[..n - 5], ck1, ck2);
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
            // CRC failed. Some real-world Wayne firmware variants send incorrect CRC bytes
            // on fill-data frames (observed: pump computes different CRC than IBM-16).
            // Accept structurally valid fill-data frames for live display only, flagged
            // `crc_ok: false` with `sale_complete` forced off — an unverified frame must
            // never close a sale, trigger a preset cap, or raise an unauthorized alarm.
            let inner_fb = &raw[..n - 4];
            if inner_fb.len() >= 2 && (0x31..=0x3F).contains(&inner_fb[1]) {
                let seq_fb = inner_fb[1];
                if let Some(data) = parse_fill_data_block(inner_fb) {
                    return Frame::Data {
                        addr,
                        seq: seq_fb,
                        volume_x1: data.volume_x1,
                        volume_x2: data.volume_x2,
                        volume_l: data.volume_l,
                        volume_h: data.volume_h,
                        amount: data.amount,
                        sale_complete: false,
                        hose_product: data.hose_product,
                        hose_code: data.hose_code,
                        crc_ok: false,
                    };
                }
            }
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
            if let Some(data) = parse_fill_data_block(inner) {
                return Frame::Data {
                    addr,
                    seq,
                    volume_x1: data.volume_x1,
                    volume_x2: data.volume_x2,
                    volume_l: data.volume_l,
                    volume_h: data.volume_h,
                    amount: data.amount,
                    sale_complete: data.sale_complete,
                    hose_product: data.hose_product,
                    hose_code: data.hose_code,
                    crc_ok: true,
                };
            }
            let product = inner[5];
            let nozzle = inner[7];
            if Frame::is_nozzle_holster_code(nozzle) {
                return Frame::NozzleReturned {
                    addr,
                    seq,
                    product,
                    hose: nozzle,
                };
            }
            return Frame::NozzleUp {
                addr,
                seq,
                product,
                nozzle,
            };
        }
        // State-transition frames (`01 01 XX`) must be checked before the generic
        // fill-data scan because some real-world frames carry both the `01 01 02`
        // holster signal and a trailing `02 08 00…` block.  The state byte at [4]
        // takes precedence; BUSY (`0x04`) is intentionally absent here so
        // BUSY-wrapped fill frames (`01 01 04 02 08 …`) fall through to fill-data.
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
        if let Some(data) = parse_fill_data_block(inner) {
            return Frame::Data {
                addr,
                seq,
                volume_x1: data.volume_x1,
                volume_x2: data.volume_x2,
                volume_l: data.volume_l,
                volume_h: data.volume_h,
                amount: data.amount,
                sale_complete: data.sale_complete,
                hose_product: data.hose_product,
                hose_code: data.hose_code,
                crc_ok: true,
            };
        }
        // Variant firmware: `03 04 00 PP 00 HH` — NozzleUp without a meter block.
        // Real hardware sends the same layout as type-A but with 0x00 at position[4]
        // instead of 0x01; product is at position[5] (inner[5]) and hose at position[7].
        // An older sub-variant placed product at inner[6] with a garbage byte at inner[5];
        // detect which by checking whether inner[6] is the filler zero or a real product.
        if inner.len() >= 8 && inner[2] == 0x03 && inner[3] == 0x04 && inner[4] == 0x00 {
            let product = if inner[6] == 0x00 { inner[5] } else { inner[6] };
            let nozzle = inner[7];
            if Frame::is_nozzle_holster_code(nozzle) {
                return Frame::NozzleReturned {
                    addr,
                    seq,
                    product,
                    hose: nozzle,
                };
            }
            if Frame::is_nozzle_lift_code(nozzle) {
                return Frame::NozzleUp {
                    addr,
                    seq,
                    product,
                    nozzle,
                };
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
        assert_eq!(
            frames.len(),
            1,
            "expected exactly one frame, got {:?}",
            frames
        );
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
        let raw = &[
            0xD3u8, 0x3A, 0x03, 0x04, 0x01, 0x05, 0x00, 0x12, 0xBF, 0x29, 0x03, 0xFA,
        ];
        let frame = parse_frame(raw);
        match frame {
            Frame::NozzleUp {
                addr,
                seq,
                product,
                nozzle,
            } => {
                assert_eq!(addr, 0x53);
                assert_eq!(seq, 0x3A);
                assert_eq!(product, 0x05);
                assert_eq!(nozzle, 0x12);
            }
            f => panic!("expected NozzleUp, got {:?}", f),
        }
    }

    /// Real hardware NozzleUp from serial.log: pump 0x53 sends an extra byte (0x10)
    /// after the length-delimited nozzle data.  CRC covers only the 8-byte header+data,
    /// not the extra byte.  verify_crc must accept this via the n-5 fallback.
    #[test]
    fn nozzle_returned_holster_code_regular() {
        // Pump 4 / AI-92: 53 3C 03 04 01 05 00 02 (from serial.log)
        let body = &[0x53u8, 0x3C, 0x03, 0x04, 0x01, 0x05, 0x00, 0x02];
        let crc = crc16(body);
        let mut raw = body.to_vec();
        raw.push((crc & 0xFF) as u8);
        raw.push((crc >> 8) as u8);
        raw.extend([0x03, 0xFA]);
        match parse_frame(&raw) {
            Frame::NozzleReturned {
                addr,
                seq,
                product,
                hose,
            } => {
                assert_eq!(addr, 0x53);
                assert_eq!(seq, 0x3C);
                assert_eq!(product, 0x05);
                assert_eq!(hose, 0x02);
            }
            f => panic!("expected NozzleReturned, got {:?}", f),
        }
    }

    #[test]
    fn nozzle_returned_holster_code_premium() {
        // Pumps 1–3 / AI-95: 51 31 03 04 01 43 00 01 (from serial.log)
        let body = &[0x51u8, 0x31, 0x03, 0x04, 0x01, 0x43, 0x00, 0x01];
        let crc = crc16(body);
        let mut raw = body.to_vec();
        raw.push((crc & 0xFF) as u8);
        raw.push((crc >> 8) as u8);
        raw.extend([0x03, 0xFA]);
        match parse_frame(&raw) {
            Frame::NozzleReturned {
                addr,
                seq,
                product,
                hose,
            } => {
                assert_eq!(addr, 0x51);
                assert_eq!(seq, 0x31);
                assert_eq!(product, 0x43);
                assert_eq!(hose, 0x01);
            }
            f => panic!("expected NozzleReturned, got {:?}", f),
        }
    }

    #[test]
    fn nozzle_returned_fourth_hose_holster_code() {
        // 4th hose: lift 0x14, holster 0x04 (same PP/HH pattern as grades 1–3).
        let body = &[0x52u8, 0x3C, 0x03, 0x04, 0x01, 0x43, 0x00, 0x04];
        let crc = crc16(body);
        let mut raw = body.to_vec();
        raw.push((crc & 0xFF) as u8);
        raw.push((crc >> 8) as u8);
        raw.extend([0x03, 0xFA]);
        let f = parse_frame(&raw);
        assert!(matches!(
            f,
            Frame::NozzleReturned {
                product: 0x43,
                hose: 0x04,
                ..
            }
        ));
    }

    #[test]
    fn nozzle_returned_diesel_holster_code() {
        // Pump 4 diesel: 53 3C 03 04 01 24 00 03 (from serial.log)
        let body = &[0x53u8, 0x3C, 0x03, 0x04, 0x01, 0x24, 0x00, 0x03];
        let crc = crc16(body);
        let mut raw = body.to_vec();
        raw.push((crc & 0xFF) as u8);
        raw.push((crc >> 8) as u8);
        raw.extend([0x03, 0xFA]);
        match parse_frame(&raw) {
            Frame::NozzleReturned { product, hose, .. } => {
                assert_eq!(product, 0x24);
                assert_eq!(hose, 0x03);
            }
            f => panic!("expected NozzleReturned, got {:?}", f),
        }
    }

    #[test]
    fn composite_fill_config_echo_prefix() {
        // Post-holster ghost fill: `03 04 00 [preset] PP HH` then `02 08` (serial.log FP4).
        let body = &[
            0x53u8, 0x38, 0x03, 0x04, 0x00, 0x01, 0x05, 0x12, 0x02, 0x08, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
        ];
        let crc = crc16(body);
        let mut raw = body.to_vec();
        raw.push((crc & 0xFF) as u8);
        raw.push((crc >> 8) as u8);
        raw.extend([0x03, 0xFA]);
        match parse_frame(&raw) {
            Frame::Data {
                hose_product,
                hose_code,
                volume_x1,
                volume_x2,
                volume_l,
                volume_h,
                ..
            } => {
                assert_eq!(hose_product, Some(0x05));
                assert_eq!(hose_code, Some(0x02));
                assert_eq!(volume_x1, 0);
                assert_eq!(volume_x2, 0);
                assert_eq!(volume_l, 0);
                assert_eq!(volume_h, 0);
            }
            f => panic!("expected Data, got {:?}", f),
        }
    }

    #[test]
    fn composite_fill_embedded_holster() {
        // Pump 4 idle poll with holster in composite 02 08 (serial.log pattern).
        let body = &[
            0x53u8, 0x3C, 0x02, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x04,
            0x01, 0x05, 0x00, 0x02,
        ];
        let crc = crc16(body);
        let mut raw = body.to_vec();
        raw.push((crc & 0xFF) as u8);
        raw.push((crc >> 8) as u8);
        raw.extend([0x03, 0xFA]);
        match parse_frame(&raw) {
            Frame::Data {
                hose_product,
                hose_code,
                ..
            } => {
                assert_eq!(hose_product, Some(0x05));
                assert_eq!(hose_code, Some(0x02));
            }
            f => panic!("expected Data with embedded holster, got {:?}", f),
        }
    }

    /// Real hardware (pump 4) sends `03 04 00 PP 00 HH` — identical to type-A but
    /// with 0x00 at position[4] instead of 0x01.  Product is at the same offset as
    /// type-A (inner[5]).  Frame from serial log: 53 38 03 04 00 24 00 13 0C DF 03 FA.
    #[test]
    fn nozzle_up_variant_type_b_real_hw() {
        let raw = &[
            0x53u8, 0x38, 0x03, 0x04, 0x00, 0x24, 0x00, 0x13, 0x0C, 0xDF, 0x03, 0xFA,
        ];
        match parse_frame(raw) {
            Frame::NozzleUp {
                addr,
                seq,
                product,
                nozzle,
            } => {
                assert_eq!(addr, 0x53);
                assert_eq!(seq, 0x38);
                assert_eq!(product, 0x24);
                assert_eq!(nozzle, 0x13);
            }
            f => panic!("expected NozzleUp, got {:?}", f),
        }
    }

    /// AI80 nozzle lift on pump 4: 53 35 03 04 00 05 00 12 41 D5 03 FA.
    #[test]
    fn nozzle_up_variant_type_b_ai80() {
        let raw = &[
            0x53u8, 0x35, 0x03, 0x04, 0x00, 0x05, 0x00, 0x12, 0x41, 0xD5, 0x03, 0xFA,
        ];
        match parse_frame(raw) {
            Frame::NozzleUp {
                product, nozzle, ..
            } => {
                assert_eq!(product, 0x05);
                assert_eq!(nozzle, 0x12);
            }
            f => panic!("expected NozzleUp, got {:?}", f),
        }
    }

    /// Older sub-variant: `03 04 00 [??] PP HH` with product at inner[6].
    /// Still handled correctly when inner[6] != 0x00.
    #[test]
    fn nozzle_up_variant_type_b_old_subvariant() {
        let raw = &[
            0x53u8, 0x3F, 0x03, 0x04, 0x00, 0x01, 0x24, 0x13, 0x70, 0xD4, 0x03, 0xFA,
        ];
        match parse_frame(raw) {
            Frame::NozzleUp {
                addr,
                seq,
                product,
                nozzle,
            } => {
                assert_eq!(addr, 0x53);
                assert_eq!(seq, 0x3F);
                assert_eq!(product, 0x24);
                assert_eq!(nozzle, 0x13);
            }
            f => panic!("expected NozzleUp, got {:?}", f),
        }
    }

    #[test]
    fn nozzle_holster_variant_type_b() {
        // Real hardware holster: 53 37 03 04 00 05 00 02 (from serial log).
        let body = &[0x53u8, 0x37, 0x03, 0x04, 0x00, 0x05, 0x00, 0x02];
        let crc = crc16(body);
        let mut raw = body.to_vec();
        raw.push((crc & 0xFF) as u8);
        raw.push((crc >> 8) as u8);
        raw.extend([0x03, 0xFA]);
        match parse_frame(&raw) {
            Frame::NozzleReturned { product, hose, .. } => {
                assert_eq!(product, 0x05);
                assert_eq!(hose, 0x02);
            }
            f => panic!("expected NozzleReturned, got {:?}", f),
        }
    }

    #[test]
    fn nozzle_holster_variant_type_b_old_subvariant() {
        // Old sub-variant with product at inner[6].
        let body = &[0x53u8, 0x3F, 0x03, 0x04, 0x00, 0x01, 0x24, 0x03];
        let crc = crc16(body);
        let mut raw = body.to_vec();
        raw.push((crc & 0xFF) as u8);
        raw.push((crc >> 8) as u8);
        raw.extend([0x03, 0xFA]);
        match parse_frame(&raw) {
            Frame::NozzleReturned { product, hose, .. } => {
                assert_eq!(product, 0x24);
                assert_eq!(hose, 0x03);
            }
            f => panic!("expected NozzleReturned, got {:?}", f),
        }
    }

    #[test]
    fn nozzle_lift_diesel_code() {
        let body = &[0x53u8, 0x3B, 0x03, 0x04, 0x01, 0x24, 0x00, 0x13];
        let crc = crc16(body);
        let mut raw = body.to_vec();
        raw.push((crc & 0xFF) as u8);
        raw.push((crc >> 8) as u8);
        raw.extend([0x03, 0xFA]);
        match parse_frame(&raw) {
            Frame::NozzleUp {
                nozzle, product, ..
            } => {
                assert_eq!(product, 0x24);
                assert_eq!(nozzle, 0x13);
            }
            f => panic!("expected NozzleUp, got {:?}", f),
        }
    }

    #[test]
    fn nozzle_lift_premium_code() {
        let body = &[0x51u8, 0x3F, 0x03, 0x04, 0x01, 0x43, 0x00, 0x11];
        let crc = crc16(body);
        let mut raw = body.to_vec();
        raw.push((crc & 0xFF) as u8);
        raw.push((crc >> 8) as u8);
        raw.extend([0x03, 0xFA]);
        match parse_frame(&raw) {
            Frame::NozzleUp {
                nozzle, product, ..
            } => {
                assert_eq!(product, 0x43);
                assert_eq!(nozzle, 0x11);
            }
            f => panic!("expected NozzleUp, got {:?}", f),
        }
    }

    #[test]
    fn real_hardware_nozzle_up_extra_byte() {
        let raw = &[
            0x53u8, 0x3E, 0x03, 0x04, 0x01, 0x05, 0x00, 0x12, 0x10, 0xFA, 0xE9, 0x03, 0xFA,
        ];
        match parse_frame(raw) {
            Frame::NozzleUp {
                addr,
                seq,
                product,
                nozzle,
            } => {
                assert_eq!(addr, 0x53);
                assert_eq!(seq, 0x3E);
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

    /// StatusTransition frame: `[addr] [seq] 01 01 02 02 08 00×11 [CRC] 03 FA`.
    /// The parser must match on inner[4]=0x02 and return NozzleHolstered regardless
    /// of the trailing `02 08 00…` bytes — confirming ack_frames_in_response ACKs it.
    #[test]
    fn status_transition_parsed_as_nozzle_holstered() {
        let body = &[
            0x52u8, 0x35, 0x01, 0x01, 0x02, // header: addr seq 01 01 02
            0x02, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // trailing data
        ];
        let crc = crc16(body);
        let mut raw = body.to_vec();
        raw.push((crc & 0xFF) as u8);
        raw.push((crc >> 8) as u8);
        raw.extend([0x03, 0xFA]);
        match parse_frame(&raw) {
            Frame::NozzleHolstered { addr, seq } => {
                assert_eq!(addr, 0x52);
                assert_eq!(seq, 0x35);
            }
            f => panic!("expected NozzleHolstered, got {:?}", f),
        }
    }

    #[test]
    fn busy_wrapped_fill_data_parsed() {
        // After PC BUSY during delivery: `01 01 04` prefix before `02 08` meter block.
        let body = &[
            0x53u8, 0x3D, 0x01, 0x01, 0x04, 0x02, 0x08, 0x00, 0x00, 0x00, 0x15, 0x00, 0x00, 0x15,
            0x75,
        ];
        let crc = crc16(body);
        let mut raw = body.to_vec();
        raw.push((crc & 0xFF) as u8);
        raw.push((crc >> 8) as u8);
        raw.extend([0x03, 0xFA]);
        match parse_frame(&raw) {
            Frame::Data {
                volume_x1,
                volume_x2,
                volume_l,
                volume_h,
                amount,
                ..
            } => {
                assert_eq!(
                    decode_volume(volume_x1, volume_x2, volume_l, volume_h),
                    0.15
                );
                assert_eq!(
                    decode_amount(amount[0], amount[1], amount[2], amount[3]),
                    1575
                );
            }
            f => panic!("expected Data, got {:?}", f),
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
                volume_x1,
                volume_x2,
                volume_l,
                volume_h,
                ..
            } => {
                assert!(sale_complete);
                assert_eq!(
                    decode_volume(volume_x1, volume_x2, volume_l, volume_h),
                    23.0
                );
            }
            f => panic!("expected Data, got {:?}", f),
        }
    }

    #[test]
    fn fill_frame_with_holster_and_multi_tail() {
        // Real serial11061430 end frame: final meter + lifted hose echo + holster + 01 01 06.
        let raw = &[
            0x52, 0x32, 0x02, 0x08, 0x00, 0x00, 0x18, 0x29, 0x00, 0x19, 0x20, 0x45, 0x03, 0x04,
            0x01, 0x05, 0x00, 0x12, 0x03, 0x04, 0x01, 0x05, 0x00, 0x02, 0x01, 0x01, 0x06, 0x3F,
            0x0D, 0x03, 0xFA,
        ];
        match parse_frame(raw) {
            Frame::Data {
                sale_complete,
                hose_product,
                hose_code,
                volume_x1,
                volume_x2,
                volume_l,
                volume_h,
                ..
            } => {
                assert!(sale_complete);
                assert_eq!(hose_product, Some(0x05));
                assert_eq!(hose_code, Some(0x02));
                assert_eq!(
                    decode_volume(volume_x1, volume_x2, volume_l, volume_h),
                    18.29
                );
            }
            f => panic!("expected Data with holster + multi tail, got {:?}", f),
        }
    }

    #[test]
    fn fill_frame_with_front_holster_and_idle_tail() {
        // Sniffed stop/final frame: holster before meter block, then 01 01 05 tail.
        let raw = &[
            0x52, 0x3B, 0x03, 0x04, 0x01, 0x05, 0x00, 0x02, 0x02, 0x08, 0x00, 0x00, 0x01, 0x95,
            0x00, 0x02, 0x04, 0x75, 0x01, 0x01, 0x05, 0x53, 0x6E, 0x03, 0xFA,
        ];
        match parse_frame(raw) {
            Frame::Data {
                sale_complete,
                hose_product,
                hose_code,
                volume_x1,
                volume_x2,
                volume_l,
                volume_h,
                ..
            } => {
                assert!(sale_complete);
                assert_eq!(hose_product, Some(0x05));
                assert_eq!(hose_code, Some(0x02));
                assert_eq!(
                    decode_volume(volume_x1, volume_x2, volume_l, volume_h),
                    1.95
                );
            }
            f => panic!("expected Data with front holster + idle tail, got {:?}", f),
        }
    }

    /// Real hardware pump 0x52 sends a composite data frame with wrong CRC bytes.
    /// CRC-16/IBM of the 22-byte payload = 0x00FA, but the pump sends 0x10 0xFA.
    /// The fill-data structural fallback must accept this as Frame::Data, but flag
    /// it unverified and never let it carry sale_complete (the payload's `01 01 05`
    /// tail would otherwise close the sale from a corrupted frame).
    #[test]
    fn crc_fail_data_frame_accepted_via_structural_fallback() {
        let raw = &[
            0x52u8, 0x33, 0x02, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x04,
            0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x05, 0x00, 0x10, 0xFA, 0x03, 0xFA,
        ];
        match parse_frame(raw) {
            Frame::Data {
                addr,
                seq,
                volume_x1,
                volume_x2,
                volume_l,
                volume_h,
                amount,
                sale_complete,
                crc_ok,
                ..
            } => {
                assert_eq!(addr, 0x52);
                assert_eq!(seq, 0x33);
                assert_eq!(decode_volume(volume_x1, volume_x2, volume_l, volume_h), 0.0);
                assert_eq!(decode_amount(amount[0], amount[1], amount[2], amount[3]), 0);
                assert!(!crc_ok);
                assert!(!sale_complete);
            }
            f => panic!("expected Data (CRC-fail fallback), got {:?}", f),
        }
    }

    /// A clean-CRC fill frame keeps its sale_complete tail and is marked verified.
    #[test]
    fn crc_ok_data_frame_keeps_sale_complete() {
        let raw = &[
            0x52, 0x39, 0x02, 0x08, 0x00, 0x00, 0x23, 0x00, 0x00, 0x24, 0x15, 0x00, 0x01, 0x01,
            0x05, 0x01, 0x01, 0x01, 0xB9, 0x57, 0x03, 0xFA,
        ];
        match parse_frame(raw) {
            Frame::Data {
                sale_complete,
                crc_ok,
                ..
            } => {
                assert!(crc_ok);
                assert!(sale_complete);
            }
            f => panic!("expected Data, got {:?}", f),
        }
    }
}
