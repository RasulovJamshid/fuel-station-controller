//! SHELF V2.2 command builders.

use crate::codec::build_request;

pub const STATUS: u8 = 0x01;
pub const READ_PRICE: u8 = 0x02;
pub const WRITE_PRICE: u8 = 0x03;
pub const AMOUNT_INFO: u8 = 0x04;
pub const WRITE_VOLUME: u8 = 0x05;
pub const WRITE_MONEY: u8 = 0x09;
pub const STOP: u8 = 0x0C;
pub const TOTAL_COUNTERS: u8 = 0x15;
pub const CURRENT_COUNTERS: u8 = 0x16;
pub const PRESSURE: u8 = 0x19;

pub const MAX_PRICE: u32 = 9_999;
/// Documented minimum volume authorization: 3.00 m³.
pub const MIN_VOLUME_STEPS: u32 = 300;
pub const MAX_DOSE: u32 = 999_999;

fn bare(addr: u8, index: u8, command: u8) -> Vec<u8> {
    build_request(addr, index, command, &[]).expect("empty SHELF payload fits")
}

pub fn status(addr: u8, index: u8) -> Vec<u8> {
    bare(addr, index, STATUS)
}
pub fn read_price(addr: u8, index: u8) -> Vec<u8> {
    bare(addr, index, READ_PRICE)
}
pub fn amount_info(addr: u8, index: u8) -> Vec<u8> {
    bare(addr, index, AMOUNT_INFO)
}
pub fn stop(addr: u8, index: u8) -> Vec<u8> {
    bare(addr, index, STOP)
}
pub fn total_counters(addr: u8, index: u8) -> Vec<u8> {
    bare(addr, index, TOTAL_COUNTERS)
}
pub fn current_counters(addr: u8, index: u8) -> Vec<u8> {
    bare(addr, index, CURRENT_COUNTERS)
}
pub fn pressure(addr: u8, index: u8) -> Vec<u8> {
    bare(addr, index, PRESSURE)
}

pub fn write_price(addr: u8, index: u8, price: u32) -> Option<Vec<u8>> {
    if price > MAX_PRICE {
        return None;
    }
    build_request(addr, index, WRITE_PRICE, &(price as u16).to_le_bytes())
}

/// Authorize by volume. Volume is in 0.01 m³, price is per m³ in wire money units.
pub fn write_volume(addr: u8, index: u8, volume: u32, price: u32) -> Option<Vec<u8>> {
    if !(MIN_VOLUME_STEPS..=MAX_DOSE).contains(&volume) || price == 0 || price > MAX_PRICE {
        return None;
    }
    let mut data = vec![0, 0]; // fixed and per-sale discount
    data.extend_from_slice(&u24_le(volume));
    data.extend_from_slice(&(price as u16).to_le_bytes());
    build_request(addr, index, WRITE_VOLUME, &data)
}

pub fn write_money(addr: u8, index: u8, amount: u32) -> Option<Vec<u8>> {
    if amount == 0 || amount > MAX_DOSE {
        return None;
    }
    build_request(addr, index, WRITE_MONEY, &u24_le(amount))
}

fn u24_le(value: u32) -> [u8; 3] {
    [value as u8, (value >> 8) as u8, (value >> 16) as u8]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_authorize_example_matches() {
        assert_eq!(
            write_volume(0x0F, 0x6B, 99_900, 162).unwrap(),
            [0x2D, 0x0F, 0x6B, 0x0E, 0x05, 0x00, 0x00, 0x3C, 0x86, 0x01, 0xA2, 0x00, 0x88, 0x4A]
        );
    }

    #[test]
    fn out_of_range_values_are_rejected() {
        assert!(write_price(1, 1, MAX_PRICE + 1).is_none());
        assert!(write_volume(1, 1, MIN_VOLUME_STEPS - 1, 1).is_none());
        assert!(write_volume(1, 1, MAX_DOSE + 1, 1).is_none());
        assert!(write_money(1, 1, 0).is_none());
    }
}
