/// Pump status decoded from the response byte of a status poll.
///
/// Encoding for 9600 baud: `0xN0 | addr`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GilbarcoStatus {
    /// Pump idle, ready for a new transaction (`0x60 | addr`).
    Idle,
    /// Customer lifted a nozzle, waiting for authorization (`0x70 | addr`).
    NozzleLifted,
    /// Pump is authorized/ready, but fuel may not be flowing yet (`0x80 | addr`).
    Ready,
    /// Fuel is flowing (`0x90 | addr`).
    Delivering,
    /// Delivery finished, transaction data available (`0xA0 | addr`).
    TransactionComplete,
    /// Pump was halted mid-delivery (`0xC0 | addr`).
    Stopped,
    /// Listen mode / extended command acknowledgement (`0xD0 | addr`).
    ListenMode,
    /// No valid response or unknown status byte.
    Offline,
}

/// Final transaction data returned by the GetTransaction command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransactionData {
    /// Price per litre as decoded from the pump frame (×10 → soum/L).
    pub unit_price_raw: u64,
    /// Dispensed volume in millilitres (÷1000.0 → litres).
    pub volume_raw: u64,
    /// Amount in units of 10 soum (×10 → soum).
    pub amount_raw: u64,
}

/// Per-nozzle totals returned by the GetTotals command (`0x50 | addr`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TotalsData {
    /// 1-based nozzle index.
    pub nozzle_index: u8,
    /// Accumulated volume total, raw pump decimal digits.
    pub volume_total_raw: u64,
    /// Accumulated amount total, raw pump decimal digits.
    pub amount_total_raw: u64,
    /// Nozzle price register, raw 4-digit value (×10 → soum/L on this site).
    pub unit_price_raw: u64,
}
