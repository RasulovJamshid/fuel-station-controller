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
/// Wire format: `val = price / 100`, then BCD-pack as `[val/100, ((val%100/10)<<4)|(val%10)]`.
/// Examples: 14300 → `[0x01, 0x43]`, 10500 → `[0x01, 0x05]`, 15000 → `[0x01, 0x50]`.
pub fn encode_price(price_sum_per_litre: u32) -> [u8; 2] {
    let val = price_sum_per_litre / 100;
    let hi = (val / 100) as u8;
    let lo = (((val % 100) / 10) << 4) as u8 | (val % 10) as u8;
    [hi, lo]
}

/// CONFIG frame (§6) — price/preset block sent twice after AUTH (or with holstered pre-auth).
///
/// `product_codes`: Wayne PP bytes per active nozzle (wayne_code order), e.g. `[0x05, 0x43, 0x24]`.
/// `prices`: price per litre (sum units) for each nozzle, aligned with `product_codes`.
/// `limit_bcd`: 3-byte preset/limit from [`encode_preset_limit_bcd`].
///
/// Each product entry: `01 PP flag P_hi P_lo 00 P_hi P_lo 00` (9 bytes).
/// Price is embedded twice per product so the pump bills at the app price, not its internal price.
pub fn authorize_config(addr: u8, product_codes: &[u8], prices: &[u32], limit_bcd: [u8; 3]) -> Vec<u8> {
    let n = product_codes.len().clamp(1, 4);

    let mut payload = vec![addr, 0x30];
    payload.extend([0x01, 0x01, 0x05]); // GO_IDLE

    // Transaction context (sniffer: `02 04 01 02 03 04`).
    payload.push(0x02);
    payload.push(n as u8);
    for i in 1..=(n as u8) {
        payload.push(i);
    }

    // Channel / product map: `05 [len]` + 9-byte entries `01 PP flag P_hi P_lo 00 P_hi P_lo 00`.
    // Price is sent twice per product. The last entry uses flag=0x30 — required to arm the nozzle.
    payload.push(0x05);
    payload.push((n * 9) as u8);
    for (i, &pp) in product_codes.iter().take(n).enumerate() {
        let flag = if i == n - 1 { 0x30 } else { 0x00 };
        let [p_hi, p_lo] = encode_price(*prices.get(i).unwrap_or(&0));
        payload.extend([0x01, pp, flag, p_hi, p_lo, 0x00, p_hi, p_lo, 0x00]);
    }

    // Preset limit (`03 04 00` + 3 BCD bytes — volume, amount, or `09 99 00` full).
    payload.extend([0x03, 0x04, 0x00]);
    payload.extend_from_slice(&limit_bcd);

    payload.extend([0x01, 0x01, 0x06]); // AUTHORISE
    build_frame(&payload)
}

/// Hardware preset bytes inside CONFIG (`03 04 00` + 3 BCD bytes).
///
/// Amount presets are converted to a volume limit using `price_per_liter` (sum per litre,
/// same unit as on the wire). The pump expects litres × 100 in BCD, not raw sum.
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
    if let (Some(a), Some(price)) = (amount_sum.filter(|&v| v > 0), price_per_liter.filter(|&p| p > 0))
    {
        let liters = a as f64 / price as f64;
        return encode_bcd_3((liters * 100.0).round().min(999_999.0) as u32);
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
        assert_eq!(encode_price(14300), [0x01, 0x43]);
        assert_eq!(encode_price(10500), [0x01, 0x05]);
        assert_eq!(encode_price(15000), [0x01, 0x50]);
        assert_eq!(encode_price(9200), [0x00, 0x92]);
    }

    #[test]
    fn config_volume_10l_with_prices() {
        // 4 products at prices [14300, 10500, 9200, 14300]; volume preset 10L.
        // Each product entry: `01 PP flag P_hi P_lo 00 P_hi P_lo 00` (9 bytes).
        let frame = authorize_config(
            0x52,
            &[0x43, 0x05, 0x24, 0x43],
            &[14300, 10500, 9200, 14300],
            encode_bcd_3(1000),
        );
        assert!(frame.starts_with(&[0x52, 0x30, 0x01, 0x01, 0x05]));
        // Length byte for 4 × 9-byte entries = 0x24.
        assert!(frame.windows(2).any(|w| w == [0x05, 0x24]));
        // Product 1 (AI-95, not last): `01 43 00 01 43 00 01 43 00`
        assert!(frame
            .windows(9)
            .any(|w| w == [0x01, 0x43, 0x00, 0x01, 0x43, 0x00, 0x01, 0x43, 0x00]));
        // Product 4 (last, flag=0x30): `01 43 30 01 43 00 01 43 00`
        assert!(frame
            .windows(9)
            .any(|w| w == [0x01, 0x43, 0x30, 0x01, 0x43, 0x00, 0x01, 0x43, 0x00]));
        // Diesel (PP=0x24, price=9200 → [0x00, 0x92]): `01 24 00 00 92 00 00 92 00`
        assert!(frame
            .windows(9)
            .any(|w| w == [0x01, 0x24, 0x00, 0x00, 0x92, 0x00, 0x00, 0x92, 0x00]));
        // Volume preset: `03 04 00 00 10 00` (10L = 1000 centilitres)
        assert!(frame
            .windows(6)
            .any(|w| w == [0x03, 0x04, 0x00, 0x00, 0x10, 0x00]));
        assert!(frame.ends_with(&[0x03, 0xFA]));
    }

    #[test]
    fn config_amount_preset_converts_to_volume_bcd() {
        // 10_500 sum at 10_500 sum/L → 1.00 L → `00 01 00`
        let frame = authorize_config(
            0x53,
            &[0x05],
            &[10_500],
            encode_preset_limit_bcd(false, None, Some(10_500), Some(10_500)),
        );
        assert!(frame
            .windows(6)
            .any(|w| w == [0x03, 0x04, 0x00, 0x00, 0x01, 0x00]));
    }

    #[test]
    fn config_full_preset_bytes() {
        let frame = authorize_config(0x53, &[0x05], &[10_500], [0x09, 0x99, 0x00]);
        assert!(frame
            .windows(6)
            .any(|w| w == [0x03, 0x04, 0x00, 0x09, 0x99, 0x00]));
        // Single product (last): flag=0x30, price=10500→[0x01,0x05]
        assert!(frame
            .windows(9)
            .any(|w| w == [0x01, 0x05, 0x30, 0x01, 0x05, 0x00, 0x01, 0x05, 0x00]));
    }
}
