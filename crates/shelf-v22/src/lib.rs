//! SHELF methane-dispenser protocol V2.2 wire codec.
//!
//! The transport is RS-485 half-duplex, normally 19200 8N1. Frames use the
//! layout `2D | ADDR | INDEX | LENGTH | COMMAND | DATA... | CRC_LO | CRC_HI`.
//! `LENGTH` is the total frame length and CRC is CRC-CCITT (poly 0x1021,
//! initial value 0), sent least-significant byte first.

pub mod codec;
pub mod commands;
pub mod frame;
pub mod parser;

pub use codec::{build_request, crc_ccitt, decode_response, take_frame, Response, START_BYTE};
pub use commands::{
    amount_info, current_counters, pressure, read_price, status, stop, total_counters, write_money,
    write_price, write_volume, MAX_DOSE, MAX_PRICE, MIN_VOLUME_STEPS,
};
pub use frame::{FinalSale, LiveStatus, ShelfState, Totalizer};
pub use parser::{parse_final_sale, parse_live_status, parse_price, parse_totalizer};

/// SHELF volume fields use hundredths of a cubic metre.
pub const VOLUME_STEPS_PER_CUBIC_METRE: f64 = 100.0;
