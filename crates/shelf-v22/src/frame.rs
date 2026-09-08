//! Decoded SHELF response models.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShelfState {
    Idle,
    KeypadActive,
    KeypadRequest,
    Dispensing,
    Synchronizing,
    FinalSale,
    CommandOk,
    CommandRejected,
    Unknown(u8),
}

impl From<u8> for ShelfState {
    fn from(command: u8) -> Self {
        match command {
            0x81 => Self::Idle,
            0x82 => Self::KeypadActive,
            0x83 => Self::KeypadRequest,
            0x84 => Self::Dispensing,
            0x85 => Self::Synchronizing,
            0x93 => Self::FinalSale,
            0x00 => Self::CommandOk,
            0xFF => Self::CommandRejected,
            other => Self::Unknown(other),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiveStatus {
    pub state: ShelfState,
    pub guns: u8,
    pub dispenser: u8,
    pub fill_type: Option<u8>,
    pub active_address: Option<u8>,
    pub volume_steps: Option<u32>,
}

impl LiveStatus {
    pub fn any_gun_lifted(self) -> bool {
        // D0 is the aggregate "one or more guns lifted" flag, while D1..D5
        // identify individual guns. Some documented replies set only the
        // individual bit (for gun 1, 0x02), so accept either representation.
        self.guns & 0x3f != 0
    }
    pub fn dispensing(self) -> bool {
        matches!(self.state, ShelfState::Dispensing) || self.dispenser & 0x80 != 0
    }
    pub fn paused(self) -> bool {
        self.dispenser & 0x10 != 0
    }
    pub fn stopped(self) -> bool {
        self.dispenser & 0x20 != 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FinalSale {
    pub guns: u8,
    pub dispenser: u8,
    pub volume_steps: u32,
    pub amount: u32,
    pub price: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Totalizer {
    pub volume_steps: u32,
}
