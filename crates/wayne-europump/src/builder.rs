use crate::crc::build_frame;

pub fn poll(addr: u8) -> Vec<u8> {
    vec![addr, 0x20, 0xFA]
}

/// Short ACK frame (PC acknowledges a received data frame or a C1 stop-ack).
/// `[addr] C0 FA` — no CRC, §5.1.
pub fn ack(addr: u8) -> Vec<u8> {
    vec![addr, 0xC0, 0xFA]
}

pub fn busy(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x30, 0x01, 0x01, 0x04])
}

pub fn stop(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x30, 0x01, 0x01, 0x08])
}

/// STOP PRE-COMMAND — `0x31` variant, sent **before** the regular `0x30` STOP
/// when delivery is active (§8.2). Dispenser replies with `C1 FA`; PC must
/// then send `ack()` before issuing `stop_frame()`.
pub fn stop_pre_frame(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x31, 0x01, 0x01, 0x08])
}

pub fn done(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x30, 0x01, 0x01, 0x05])
}

pub fn authorize_initial(addr: u8) -> Vec<u8> {
    build_frame(&[addr, 0x30, 0x01, 0x01, 0x04, 0x01, 0x01, 0x05])
}

/// Pack a u32 into 3 BCD-packed bytes (6 decimal digits, high nibble first).
pub fn encode_bcd_3(val: u32) -> [u8; 3] {
    let digits = format!("{:06}", val.min(999_999));
    let b = digits.as_bytes();
    [
        ((b[0] - b'0') << 4) | (b[1] - b'0'),
        ((b[2] - b'0') << 4) | (b[3] - b'0'),
        ((b[4] - b'0') << 4) | (b[5] - b'0'),
    ]
}

/// Encode a price (sum per litre) into the 2-byte Wayne wire format.
///
/// Encodes the last 4 decimal digits of the price as BCD, matching the display
/// unit used by Wayne hardware in Uzbekistan.
/// Examples: 14300 → `[0x43, 0x00]` (shows "4300"), 10500 → `[0x05, 0x00]` (shows "0500"),
/// 9200 → `[0x92, 0x00]` (shows "9200").
/// Delivery accuracy is unaffected — amount presets are always pre-converted to
/// volume before being sent to the pump.
pub fn encode_price(price_sum_per_litre: u32) -> [u8; 2] {
    let val = price_sum_per_litre % 10_000;
    let hi = (((val / 1000) << 4) | ((val / 100) % 10)) as u8;
    let lo = ((((val / 10) % 10) << 4) | (val % 10)) as u8;
    [hi, lo]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresetBlock {
    pub kind: u8,
    pub value: [u8; 3],
}

impl PresetBlock {
    pub fn volume_or_full(value: [u8; 3]) -> Self {
        Self { kind: 0x03, value }
    }

    pub fn amount_sum(amount_sum: u64) -> Self {
        Self {
            kind: 0x04,
            value: encode_bcd_3(amount_sum.min(999_999) as u32),
        }
    }
}

/// CONFIG frame (§6) — product/price map and preset (sent on AUTH / pre-auth).
///
/// `product_codes` and `prices` must be in the same order: sorted by [`wayne_code`] (physical
/// channel 1 = `0x11`, channel 2 = `0x12`, …), matching `02 04 01 02 03 04`.
///
/// Sniffer product block: `05 0C` + `01 PP flag` × N (3 bytes each; last flag `0x30`).
///
/// Preset block variants observed in sniffer logs:
/// - `03 04 00` + BCD litres × 100, or `09 99 00` for full tank.
/// - `04 04 00` + BCD money amount in sum.
pub fn authorize_config(
    addr: u8,
    product_codes: &[u8],
    prices: &[u32],
    limit_bcd: [u8; 3],
) -> Vec<u8> {
    authorize_config_with_preset_block(
        addr,
        product_codes,
        prices,
        PresetBlock::volume_or_full(limit_bcd),
    )
}

pub fn authorize_config_with_preset_block(
    addr: u8,
    product_codes: &[u8],
    prices: &[u32],
    preset: PresetBlock,
) -> Vec<u8> {
    let n = product_codes.len().clamp(1, 4);

    let mut payload = vec![addr, 0x30];
    payload.extend([0x01, 0x01, 0x05]); // GO_IDLE

    // Transaction context (sniffer: `02 04 01 02 03 04` = channels 1..N).
    payload.push(0x02);
    payload.push(n as u8);
    for i in 1..=(n as u8) {
        payload.push(i);
    }

    // Product/price map (sniffer): `05 [n×3]` + `01 PP flag` per channel.
    // PP is the pump's price/display byte: 10500 -> 0x05, 11000 -> 0x10, 14300 -> 0x43.
    payload.push(0x05);
    payload.push((n * 3) as u8);
    for i in 0..n {
        let pp = prices
            .get(i)
            .copied()
            .filter(|p| *p > 0)
            .map(|p| encode_price(p)[0])
            .unwrap_or_else(|| product_codes.get(i).copied().unwrap_or(0));
        let flag = if i == n - 1 { 0x30 } else { 0x00 };
        payload.extend([0x01, pp, flag]);
    }

    // Preset limit (`03` = volume/full, `04` = amount).
    payload.extend([preset.kind, 0x04, 0x00]);
    payload.extend_from_slice(&preset.value);

    payload.extend([0x01, 0x01, 0x06]); // AUTHORISE
    build_frame(&payload)
}

/// Volume/full preset bytes inside CONFIG (`03 04 00` + 3 BCD bytes).
///
/// PCC485 money presets use [`PresetBlock::amount_sum`] instead. This helper still supports
/// amount-to-volume conversion for older DART paths that only accept a volume-style limit.
pub fn encode_preset_limit_bcd(
    full_tank: bool,
    volume_liters: Option<f64>,
    amount_sum: Option<u64>,
    price_per_liter: Option<u32>,
) -> [u8; 3] {
    if full_tank {
        return [0x09, 0x99, 0x00];
    }
    if let Some(l) = volume_liters.filter(|&v| v > 0.0) {
        // Sniffer: 10.0 L → `00 10 00` (liters × 100).
        return encode_bcd_3((l * 100.0).round() as u32);
    }
    if let (Some(a), Some(price)) = (
        amount_sum.filter(|&v| v > 0),
        price_per_liter.filter(|&p| p > 0),
    ) {
        let liters = a as f64 / price as f64;
        return encode_bcd_3((liters * 100.0).ceil().min(999_999.0) as u32);
    }
    [0x09, 0x99, 0x00]
}

/// Hardcoded STOP frames per address (emergency broadcast).
pub fn stop_frame(addr: u8) -> Vec<u8> {
    match addr {
        0x50 => vec![0x50, 0x30, 0x01, 0x01, 0x08, 0x9E, 0x9A, 0x03, 0xFA],
        0x51 => vec![0x51, 0x30, 0x01, 0x01, 0x08, 0xA3, 0x5A, 0x03, 0xFA],
        0x52 => vec![0x52, 0x30, 0x01, 0x01, 0x08, 0xE7, 0x5A, 0x03, 0xFA],
        0x53 => vec![0x53, 0x30, 0x01, 0x01, 0x08, 0xDA, 0x9A, 0x03, 0xFA],
        _ => stop(addr),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_p2() {
        assert_eq!(poll(0x52), vec![0x52, 0x20, 0xFA]);
    }

    #[test]
    fn ack_short_frame() {
        assert_eq!(ack(0x52), vec![0x52, 0xC0, 0xFA]);
    }

    #[test]
    fn busy_matches_doc() {
        assert_eq!(
            busy(0x52),
            vec![0x52, 0x30, 0x01, 0x01, 0x04, 0xE7, 0x5F, 0x03, 0xFA]
        );
    }

    #[test]
    fn authorize_matches_doc() {
        assert_eq!(
            authorize_initial(0x53),
            vec![0x53, 0x30, 0x01, 0x01, 0x04, 0x01, 0x01, 0x05, 0xD8, 0x58, 0x03, 0xFA]
        );
    }

    #[test]
    fn encode_price_examples() {
        assert_eq!(encode_price(14300), [0x43, 0x00]);
        assert_eq!(encode_price(10500), [0x05, 0x00]);
        assert_eq!(encode_price(15000), [0x50, 0x00]);
        assert_eq!(encode_price(9200), [0x92, 0x00]);
        assert_eq!(encode_price(12400), [0x24, 0x00]);
    }

    #[test]
    fn config_volume_10l_with_prices() {
        let frame = authorize_config(
            0x52,
            &[0x43, 0x05, 0x24, 0x43],
            &[14300, 10500, 12400, 14300],
            encode_bcd_3(1000),
        );
        assert!(frame.starts_with(&[0x52, 0x30, 0x01, 0x01, 0x05]));
        // Block 1: [01 PP flag] × 4
        assert!(
            frame
                .windows(12)
                .any(|w| w
                    == [0x01, 0x43, 0x00, 0x01, 0x05, 0x00, 0x01, 0x24, 0x00, 0x01, 0x43, 0x30])
        );
        assert!(frame
            .windows(6)
            .any(|w| w == [0x03, 0x04, 0x00, 0x00, 0x10, 0x00]));
        assert!(frame.ends_with(&[0x03, 0xFA]));
    }

    #[test]
    fn config_fp4_prices_per_channel() {
        let frame = authorize_config(
            0x53,
            &[0x43, 0x05, 0x24, 0x05],
            &[14300, 10500, 12400, 10500],
            [0x09, 0x99, 0x00],
        );
        // Block 1 unchanged
        assert!(
            frame
                .windows(12)
                .any(|w| w
                    == [0x01, 0x43, 0x00, 0x01, 0x05, 0x00, 0x01, 0x24, 0x00, 0x01, 0x05, 0x30])
        );
        assert!(frame
            .windows(6)
            .any(|w| w == [0x03, 0x04, 0x00, 0x09, 0x99, 0x00]));
    }

    #[test]
    fn config_price_change_11000_updates_wire_pp_byte() {
        let frame = authorize_config(0x52, &[0x05, 0x05], &[10_500, 11_000], encode_bcd_3(100));
        assert!(frame
            .windows(6)
            .any(|w| w == [0x01, 0x05, 0x00, 0x01, 0x10, 0x30]));
    }

    #[test]
    fn config_amount_preset_uses_money_block() {
        let frame = authorize_config_with_preset_block(
            0x53,
            &[0x05],
            &[10_500],
            PresetBlock::amount_sum(10_000),
        );
        assert!(frame
            .windows(6)
            .any(|w| w == [0x04, 0x04, 0x00, 0x01, 0x00, 0x00]));
    }

    #[test]
    fn config_amount_preset_matches_50000_sum_capture() {
        let frame = authorize_config_with_preset_block(
            0x53,
            &[0x05],
            &[10_500],
            PresetBlock::amount_sum(50_000),
        );
        assert!(frame
            .windows(6)
            .any(|w| w == [0x04, 0x04, 0x00, 0x05, 0x00, 0x00]));
    }

    #[test]
    fn config_full_preset_bytes() {
        let frame = authorize_config(0x53, &[0x05], &[10_500], [0x09, 0x99, 0x00]);
        assert!(frame
            .windows(6)
            .any(|w| w == [0x03, 0x04, 0x00, 0x09, 0x99, 0x00]));
        assert!(frame.windows(3).any(|w| w == [0x01, 0x05, 0x30]));
    }
}
