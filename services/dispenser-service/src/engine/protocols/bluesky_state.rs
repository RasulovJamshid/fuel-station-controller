//! State belonging only to the TexnoUz sale lifecycle.

use texnouz_bluesky::FillData;

/// Require separate stable observations before committing a terminal reading.
pub(super) const FINISH_SETTLE_MS: i64 = 750;

#[derive(Debug, Clone, Default)]
pub(in crate::engine) struct BlueSkyRuntimeState {
    pub flow_seen: bool,
    pub stop_requested: bool,
    pub stop_acknowledged: bool,
    /// A saved sale still owns this hose until a non-flowing holster is observed.
    pub completed_nozzle: Option<u8>,
    pub finish_candidate: Option<(FillData, i64)>,
}

impl BlueSkyRuntimeState {
    pub fn confirm_finish(&mut self, fill: FillData, now: i64) -> bool {
        match self.finish_candidate {
            Some((previous, since)) if previous == fill => {
                now.saturating_sub(since) >= FINISH_SETTLE_MS
            }
            _ => {
                self.finish_candidate = Some((fill, now));
                false
            }
        }
    }
}
