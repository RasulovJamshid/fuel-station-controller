//! AZT 2.0 dispenser protocol codec (ОАО АЗТ, «ПРОТОКОЛ обмена данными …», v2.0).
//!
//! RS-485 half-duplex, 4800 baud, 7 data bits, parity, 2 stop bits. Frames use
//! complementary-byte encoding and an XOR checksum; see [`codec`]. Command
//! builders live in [`commands`], response parsing in [`parser`], and decoded
//! types in [`frame`].
//!
//! This crate is transport-agnostic and hardware-independent: it only builds and
//! parses byte buffers, so it is fully unit-testable and cannot affect any other
//! protocol.

pub mod codec;
pub mod commands;
pub mod frame;
pub mod parser;

pub use codec::{
    address_byte, build_broadcast, build_request, checksum, complement, decode_response,
    encode_data_response, encode_short_response, pop_request, Response, TrkRequest, ACK, CAN, DEL,
    ETX, NAK, STX,
};
pub use commands::{
    authorize, confirm_totals, current_data, full_data, protocol_version, read_set_dose, reset,
    set_decel_threshold, set_dose_litres, set_dose_litres_full_tank, set_dose_rubles,
    set_general_param, set_price, status, topup_dose, totals, transaction_number, trk_type,
    unconditional_start,
};
pub use frame::{AztStatus, CurrentData, FinishReason, FullData, TrkType};
pub use parser::{
    parse_current_data, parse_full_data, parse_protocol_version, parse_status, parse_totals,
    parse_transaction_number, parse_trk_type,
};
