/// Parsed logical frame from the Wayne Europump bus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// PC→DISP short poll (not a response)
    Poll {
        addr: u8,
    },
    /// DISP→PC idle
    Idle {
        addr: u8,
    },
    /// DISP→PC authorized / delivering ack / PC→DISP ack
    AckC0 {
        addr: u8,
    },
    /// Live delivery data (16-byte payload before CRC)
    Data {
        addr: u8,
        seq: u8,
        volume_l: u8,
        volume_h: u8,
        amount: [u8; 3],
        /// Composite fill frame ends with `01 01 01` (sniffer DONE) after optional `01 01 05`.
        sale_complete: bool,
    },
    /// Nozzle lifted (`03 04 01 PP 00 HH` with HH ≠ 0x02).
    NozzleUp {
        addr: u8,
        seq: u8,
        product: u8,
        nozzle: u8,
    },
    /// Nozzle returned to holster (`03 04 01 PP 00 02`).
    NozzleReturned {
        addr: u8,
        seq: u8,
        product: u8,
    },
    /// Short `01 01 05` from dispenser — idle/ready (ghost-fill holster), not sale DONE.
    DispenserIdle {
        addr: u8,
        seq: u8,
    },
    /// Legacy / sniffer `01 01 05` in some firmware — kept for composite tails handled via Data.
    TransactionComplete {
        addr: u8,
        seq: u8,
    },
    /// Dispenser `01 01 01` — delivery stopped or price-change DONE.
    Stopped {
        addr: u8,
        seq: u8,
    },
    /// Nozzle returned to holster (`01 01 02` or `01 01 00` on the wire).
    NozzleHolstered {
        addr: u8,
        seq: u8,
    },
    Unknown(Vec<u8>),
}

impl Frame {
    /// Bus address carried by this frame, if it is a dispenser→PC message.
    pub fn response_addr(&self) -> Option<u8> {
        match self {
            Frame::Idle { addr }
            | Frame::NozzleUp { addr, .. }
            | Frame::NozzleReturned { addr, .. }
            | Frame::NozzleHolstered { addr, .. }
            | Frame::Data { addr, .. }
            | Frame::DispenserIdle { addr, .. }
            | Frame::TransactionComplete { addr, .. }
            | Frame::Stopped { addr, .. } => Some(*addr),
            Frame::AckC0 { .. } | Frame::Poll { .. } | Frame::Unknown(_) => None,
        }
    }

    /// True when this is a dispenser→PC response to a poll (not TX echo / garbage).
    pub fn is_dispenser_response(&self, polled_addr: u8) -> bool {
        match self {
            Frame::Idle { addr }
            | Frame::NozzleUp { addr, .. }
            | Frame::NozzleReturned { addr, .. }
            | Frame::NozzleHolstered { addr, .. }
            | Frame::Data { addr, .. }
            | Frame::DispenserIdle { addr, .. }
            | Frame::TransactionComplete { addr, .. }
            | Frame::Stopped { addr, .. } => *addr == polled_addr,
            Frame::AckC0 { .. } | Frame::Poll { .. } | Frame::Unknown(_) => false,
        }
    }

    /// Holster/idle signals must be applied before a repeated `NozzleUp` in the same RX chunk.
    pub fn should_apply_before_nozzle_up(&self) -> bool {
        matches!(
            self,
            Frame::Idle { .. }
                | Frame::NozzleHolstered { .. }
                | Frame::NozzleReturned { .. }
                | Frame::Data { .. }
                | Frame::DispenserIdle { .. }
                | Frame::TransactionComplete { .. }
                | Frame::Stopped { .. }
        )
    }

    /// `03 04 01 PP 00 HH` hose byte when the nozzle is returned to the holder.
    ///
    /// Observed on real ASIS hardware (not configurable hose IDs):
    /// - product `0x05` (regular): lift `0x12`, holster `0x02`
    /// - product `0x43` (premium): lift `0x11`, holster `0x01`
    ///
    /// Lift/select codes are `>= 0x10` (e.g. Wayne `wayne_code` 17 → `0x11`, 18 → `0x12`).
    pub fn is_nozzle_holster_code(hh: u8) -> bool {
        hh <= 0x02
    }

    pub fn is_nozzle_lift_code(hh: u8) -> bool {
        !Self::is_nozzle_holster_code(hh)
    }
}
