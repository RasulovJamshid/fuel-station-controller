//! Parsers for SHELF V2.2 response payloads.

use crate::codec::Response;
use crate::frame::{FinalSale, LiveStatus, ShelfState, Totalizer};

pub fn parse_live_status(response: &Response) -> Option<LiveStatus> {
    let state = ShelfState::from(response.command);
    match state {
        ShelfState::Idle => Some(LiveStatus {
            state,
            guns: *response.data.first()?,
            dispenser: *response.data.get(1)?,
            fill_type: None,
            active_address: None,
            volume_steps: None,
        }),
        ShelfState::KeypadActive
        | ShelfState::KeypadRequest
        | ShelfState::Dispensing
        | ShelfState::Synchronizing => Some(LiveStatus {
            state,
            guns: *response.data.first()?,
            dispenser: *response.data.get(1)?,
            fill_type: response.data.get(2).copied(),
            active_address: response.data.get(3).copied(),
            volume_steps: response.data.get(4..7).map(read_u24),
        }),
        _ => None,
    }
}

pub fn parse_final_sale(response: &Response) -> Option<FinalSale> {
    if response.command != 0x93 || response.data.len() < 10 {
        return None;
    }
    Some(FinalSale {
        guns: response.data[0],
        dispenser: response.data[1],
        volume_steps: read_u24(&response.data[2..5]),
        amount: read_u24(&response.data[5..8]),
        price: u16::from_le_bytes([response.data[8], response.data[9]]),
    })
}

pub fn parse_price(response: &Response) -> Option<u16> {
    if response.command != 0x91 || response.data.len() != 2 {
        return None;
    }
    Some(u16::from_le_bytes([response.data[0], response.data[1]]))
}

pub fn parse_totalizer(response: &Response) -> Option<Totalizer> {
    if response.command != 0xA0 || response.data.len() < 4 {
        return None;
    }
    Some(Totalizer {
        volume_steps: u32::from_le_bytes([
            response.data[0],
            response.data[1],
            response.data[2],
            response.data[3],
        ]),
    })
}

fn read_u24(bytes: &[u8]) -> u32 {
    bytes[0] as u32 | ((bytes[1] as u32) << 8) | ((bytes[2] as u32) << 16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_live_status_decodes() {
        let r = Response {
            address: 0x0F,
            index: 0xA7,
            command: 0x84,
            data: vec![0x02, 0x8F, 0x01, 0x0F, 0x10, 0x00, 0x00],
        };
        let status = parse_live_status(&r).unwrap();
        assert!(status.dispensing());
        assert!(status.any_gun_lifted());
        assert_eq!(status.active_address, Some(0x0F));
        assert_eq!(status.volume_steps, Some(16));
    }

    #[test]
    fn pdf_final_sale_decodes() {
        let r = Response {
            address: 0x0F,
            index: 0xAB,
            command: 0x93,
            data: vec![0x02, 0x81, 0x72, 0x09, 0x00, 0x4D, 0x0F, 0x00, 0xA2, 0x00],
        };
        let sale = parse_final_sale(&r).unwrap();
        assert_eq!(sale.volume_steps, 2418);
        assert_eq!(sale.amount, 3917);
        assert_eq!(sale.price, 162);
    }
}
