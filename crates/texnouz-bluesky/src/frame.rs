//! Decoded BlueSky types: status bits, fill data and totalizers.

/// State byte returned by `READ_STATUS` (0xD5), разд. 7.
///
/// Bits 2 and 4 are unassigned in the specification and are preserved but not
/// interpreted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlueSkyStatus(pub u8);

impl BlueSkyStatus {
    /// Bit 7 (0x80) — nozzle is holstered (not lifted).
    pub fn nozzle_holstered(self) -> bool {
        self.0 & 0x80 != 0
    }

    /// Convenience inverse of [`Self::nozzle_holstered`]. Fuel can only start
    /// once the customer has lifted (разд. 9, п. 3).
    pub fn nozzle_lifted(self) -> bool {
        !self.nozzle_holstered()
    }

    /// Bit 6 (0x40) — dispensing is paused.
    pub fn paused(self) -> bool {
        self.0 & 0x40 != 0
    }

    /// Bit 5 (0x20) — fuel is flowing.
    pub fn dispensing(self) -> bool {
        self.0 & 0x20 != 0
    }

    /// Bit 3 (0x08) — the pump is under remote (PC) control rather than local.
    /// Commands are only honoured in this mode.
    pub fn remote_control(self) -> bool {
        self.0 & 0x08 != 0
    }

    /// Bit 1 (0x02) — a dose was entered on the pump keypad and is awaiting start.
    pub fn keypad_preset_ready(self) -> bool {
        self.0 & 0x02 != 0
    }

    /// Bit 0 (0x01) — error latched; read the code with `READ_ERROR` (0xA9).
    pub fn error(self) -> bool {
        self.0 & 0x01 != 0
    }

    /// True when the lane is neither dispensing nor paused and holds no pending
    /// keypad dose — i.e. genuinely idle.
    pub fn idle(self) -> bool {
        !self.dispensing() && !self.paused() && !self.keypad_preset_ready()
    }
}

/// Live or final dispense data from `READ_FILL` (0xD9): 4 BCD bytes of volume
/// followed by 4 BCD bytes of money.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FillData {
    /// Dispensed volume in 0.01 L units (`5000` = 50.00 L).
    pub volume_centilitres: u64,
    /// Dispensed cost in wire money units — see `WIRE_MONEY_UNIT`.
    pub amount_wire: u64,
}

/// Totalizer pair from `READ_TOTAL` (0xC5) or `READ_SHIFT` (0xC7): 6 BCD bytes
/// of cumulative volume followed by 6 BCD bytes of cumulative money.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Totals {
    /// Cumulative volume in 0.01 L units.
    pub volume_centilitres: u64,
    /// Cumulative money in wire units.
    pub amount_wire: u64,
}

/// Preset readback from `READ_PRESET` (0xA7): a type byte plus a 4-byte value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresetReadback {
    /// Raw type byte as reported by the pump.
    pub kind: u8,
    /// Raw BCD-decoded value; interpretation follows `kind`.
    pub value: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_example_state_08_is_remote_and_idle() {
        // разд. 8: ответ 0x08 — «удалённый режим, простой».
        let s = BlueSkyStatus(0x08);
        assert!(s.remote_control());
        assert!(s.idle());
        assert!(!s.dispensing());
        assert!(!s.paused());
        assert!(!s.error());
        // Bit 7 clear means the nozzle is out of the holster.
        assert!(s.nozzle_lifted());
    }

    #[test]
    fn each_documented_bit_maps_to_its_mask() {
        assert!(BlueSkyStatus(0x80).nozzle_holstered());
        assert!(BlueSkyStatus(0x40).paused());
        assert!(BlueSkyStatus(0x20).dispensing());
        assert!(BlueSkyStatus(0x08).remote_control());
        assert!(BlueSkyStatus(0x02).keypad_preset_ready());
        assert!(BlueSkyStatus(0x01).error());
    }

    #[test]
    fn holstered_and_dispensing_are_independent_bits() {
        // A pump can report "dispensing" while the holster bit is clear; the two
        // must not be inferred from one another.
        let s = BlueSkyStatus(0x28); // dispensing + remote
        assert!(s.dispensing() && s.nozzle_lifted() && !s.idle());
    }

    #[test]
    fn paused_lane_is_not_idle_and_not_dispensing() {
        let s = BlueSkyStatus(0x48); // paused + remote
        assert!(s.paused());
        assert!(!s.dispensing());
        assert!(!s.idle());
    }
}
