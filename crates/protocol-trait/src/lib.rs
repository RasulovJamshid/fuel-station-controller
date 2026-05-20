//! Abstract protocol driver for dispenser serial protocols.

/// Build poll / command frames for a dispenser address on the bus.
pub trait ProtocolDriver: Send + Sync {
    /// RS485 address byte (0x50..=0x53 for Wayne Europump).
    fn poll_frame(&self, addr: u8) -> Vec<u8>;
}
