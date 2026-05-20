mod builder;
mod crc;
mod frame;
mod parser;

pub use builder::{
    ack, authorize_config, authorize_initial, busy, done, ghost_fill_abort, poll, stop,
    stop_frame, stop_pre_frame,
};
pub use crc::{build_frame, crc16};
pub use frame::Frame;
pub use parser::{decode_amount, decode_volume, parse_frame, FrameAccumulator};

use protocol_trait::ProtocolDriver;

/// Wayne 3490D / Europump PCC485 driver.
pub struct WayneDriver;

impl ProtocolDriver for WayneDriver {
    fn poll_frame(&self, addr: u8) -> Vec<u8> {
        poll(addr)
    }
}
