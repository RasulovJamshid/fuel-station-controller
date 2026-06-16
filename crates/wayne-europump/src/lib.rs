mod builder;
mod crc;
mod dart;
mod frame;
mod parser;

pub use builder::{
    ack, authorize_config, authorize_config_with_preset_block, authorize_initial, busy, done,
    encode_preset_limit_bcd, encode_price, poll, stop, stop_frame, stop_pre_frame, PresetBlock,
};
pub use crc::{build_frame, crc16};
pub use dart::{authorise_cmd, pre_authorise_price};
pub use frame::Frame;
pub use parser::{
    decode_amount, decode_volume, parse_frame, scan_embedded_hose_status, FrameAccumulator,
};

use protocol_trait::ProtocolDriver;

/// Wayne 3490D / Europump PCC485 driver.
pub struct WayneDriver;

impl ProtocolDriver for WayneDriver {
    fn poll_frame(&self, addr: u8) -> Vec<u8> {
        poll(addr)
    }
}
