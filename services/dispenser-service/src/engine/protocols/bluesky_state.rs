//! State belonging only to the TexnoUz sale lifecycle.

use std::time::{Duration, Instant};
use texnouz_bluesky::FillData;

/// Require separate stable observations before committing a terminal reading.
pub(super) const FINISH_SETTLE_MS: i64 = 750;

#[derive(Debug, Clone, Default)]
pub(in crate::engine) struct BlueSkyRuntimeState {
    pub flow_seen: bool,
    pub stop_requested: bool,
    pub stop_acknowledged: bool,
    /// Pace uncertain cancellation/status checks without holding up other hoses.
    pub next_stop_attempt: Option<Instant>,
    /// A saved sale still owns this hose until a non-flowing holster is observed.
    pub completed_nozzle: Option<u8>,
    pub finish_candidate: Option<(FillData, i64)>,
}

impl BlueSkyRuntimeState {
    pub fn claim_stop_attempt(&mut self, delay: Duration) -> bool {
        let now = Instant::now();
        if self.next_stop_attempt.is_some_and(|next| now < next) {
            return false;
        }
        self.next_stop_attempt = Some(now + delay);
        true
    }

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
