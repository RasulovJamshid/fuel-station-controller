/// Pump status decoded from the second byte of a status response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GilbarcoStatus {
    /// 0x61..0x6F — pump idle, ready for a new transaction.
    Idle,
    /// 0x71..0x7F — nozzle lifted, waiting for authorization.
    NozzleLifted,
    /// 0x81..0x8F — authorized and armed, customer has not opened trigger yet.
    Authorized,
    /// 0x91..0x9F — fuel is flowing.
    Delivering,
    /// 0xA1..0xBF — delivery finished, transaction data ready.
    TransactionComplete,
    /// 0xC1..0xCF — pump was halted mid-delivery.
    Stopped,
    /// 0xD1..0xDF — listen mode, ready to accept SetPrice / GetNozzle commands.
    ListenMode,
    /// No valid response or unknown status byte.
    Offline,
}

/// Final transaction data returned by the GetTransaction command.
#[derive(Debug, Clone, Copy)]
pub struct TransactionData {
    /// Raw 4-digit BCD integer — unit price (pump's internal representation).
    pub unit_price_raw: u64,
    /// Raw 6-digit BCD integer — dispensed volume (÷1000 → litres when 3 dp configured).
    pub volume_raw: u64,
    /// Raw 6-digit BCD integer — total amount charged.
    pub amount_raw: u64,
}
