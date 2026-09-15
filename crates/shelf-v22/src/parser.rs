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

    #[test]
    fn shared_gun_status_is_not_the_queried_guns_delivery() {
        let frame = [
            0x2D, 0x14, 0xCC, 0x16, 0x85, 5, 0x81, 1, 0x15, 0, 0, 0, 0xE8, 3, 0, 0x74, 0x27, 0,
            0xF2, 3, 0x21, 0xD5,
        ];
        let response = crate::decode_response(20, 0xCC, &frame).unwrap();
        let status = parse_live_status(&response).unwrap();
        assert!(status.describes_other_gun(20));
        assert!(!status.describes_other_gun(21));
        assert_eq!(status.active_address, Some(21));
        assert!(status.gun_lifted(2));
        assert!(!status.gun_lifted(1));
        assert!(!status.gun_lifted(3));
        // Legacy single-gun controllers may report only aggregate D0.
        assert!(LiveStatus { guns: 1, ..status }.gun_lifted(1));
        assert!(!LiveStatus { guns: 0, ..status }.gun_lifted(1));
        assert!(!status.gun_lifted(6));
    }

    #[test]
    fn captured_petrol_final_sale_decodes_without_price_truncation() {
        let frame = [
            0x2D, 0x15, 0x17, 0x11, 0x93, 5, 0xA1, 0xE8, 3, 0, 0x20, 0xC5, 1, 0x50, 0x2D, 0xB1,
            0xCF,
        ];
        let response = crate::decode_response(21, 0x17, &frame).unwrap();
        let sale = parse_final_sale(&response).unwrap();
        assert_eq!(sale.volume_steps, 1000);
        assert_eq!(sale.price, 11600);
        assert_eq!(sale.amount, 116000);
    }
}
