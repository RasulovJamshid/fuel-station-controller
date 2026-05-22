use crate::crc::build_frame;

/// Encode a price as 2 BCD bytes matching the reference wire format.
/// Each pair of decimal digits becomes one byte: 1000 → "1000" → [0x10, 0x00].
/// Prices above 9999 are clamped to fit 4 BCD digits.
fn encode_dart_price(price: u32) -> [u8; 2] {
    let s = format!("{:04}", price.min(9999));
    let b = s.as_bytes();
    [
        ((b[0] - b'0') << 4) | (b[1] - b'0'),
        ((b[2] - b'0') << 4) | (b[3] - b'0'),
    ]
}

/// WayneDartV1 PreAuthorisePrice frame.
///
/// Sends the unit price for every active nozzle (in 1-based index order), specifies
/// which nozzle is being lifted, and commands GO_IDLE.
///
/// `nozzle_prices`: prices for all active nozzles sorted by nozzle index.
/// `active_nozzle`: 1-based wire nozzle ID (hose code 0x11→1, 0x12→2, 0x13→3).
///
/// Wire: `[addr] 30 05 [N×3] [00 PH PL]×N 02 01 [nozzle] 01 01 05 [CRC] 03 FA`
pub fn pre_authorise_price(addr: u8, nozzle_prices: &[u32], active_nozzle: u8) -> Vec<u8> {
    let n = nozzle_prices.len().clamp(1, 4);
    let mut payload = vec![addr, 0x30, 0x05, (n * 3) as u8];
    for &price in nozzle_prices.iter().take(n) {
        let [ph, pl] = encode_dart_price(price);
        payload.extend([0x00, ph, pl]);
    }
    payload.extend([0x02, 0x01, active_nozzle]); // active nozzle context
    payload.extend([0x01, 0x01, 0x05]); // GO_IDLE
    build_frame(&payload)
}

/// WayneDartV1 AuthoriseCMD frame.
///
/// Sends the preset limit and authorises the specified nozzle.
///
/// `limit_bcd`: 3-byte BCD preset — use `[0x99, 0x99, 0x99]` for full-tank.
///
/// Wire: `[addr] 30 04 04 00 [bcd0] [bcd1] [bcd2] 02 01 [nozzle] 01 01 06 [CRC] 03 FA`
pub fn authorise_cmd(addr: u8, active_nozzle: u8, limit_bcd: [u8; 3]) -> Vec<u8> {
    build_frame(&[
        addr,
        0x30,
        0x04,
        0x04,
        0x00,
        limit_bcd[0],
        limit_bcd[1],
        limit_bcd[2],
        0x02,
        0x01,
        active_nozzle,
        0x01,
        0x01,
        0x06,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_price_1000() {
        assert_eq!(encode_dart_price(1000), [0x10, 0x00]);
    }

    #[test]
    fn encode_price_9500() {
        assert_eq!(encode_dart_price(9500), [0x95, 0x00]);
    }

    #[test]
    fn pre_auth_single_nozzle_structure() {
        let frame = pre_authorise_price(0x50, &[1000], 1);
        // [addr] 30 05 03 00 10 00 02 01 01 01 01 05 [CRC] 03 FA
        assert!(frame.starts_with(&[0x50, 0x30, 0x05, 0x03]));
        assert!(frame.windows(3).any(|w| w == [0x00, 0x10, 0x00])); // price block
        assert!(frame.windows(3).any(|w| w == [0x02, 0x01, 0x01])); // nozzle context
        assert!(frame.windows(3).any(|w| w == [0x01, 0x01, 0x05])); // GO_IDLE
        assert!(frame.ends_with(&[0x03, 0xFA]));
    }

    #[test]
    fn authorise_cmd_structure() {
        let frame = authorise_cmd(0x50, 1, [0x99, 0x99, 0x99]);
        assert!(frame.starts_with(&[0x50, 0x30, 0x04, 0x04, 0x00, 0x99, 0x99, 0x99]));
        assert!(frame.windows(3).any(|w| w == [0x02, 0x01, 0x01]));
        assert!(frame.windows(3).any(|w| w == [0x01, 0x01, 0x06]));
        assert!(frame.ends_with(&[0x03, 0xFA]));
    }
}
