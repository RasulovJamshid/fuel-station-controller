//! AZT ownership while a terminal stop or completion is being confirmed.

use std::collections::BTreeSet;
use std::time::Instant;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub(in crate::engine) struct AztRuntimeState {
    pub order_price: Option<u32>,
    pub stop_requested: bool,
    pub cancel_requested: bool,
    pub stop_addresses: BTreeSet<u8>,
    #[serde(skip)]
    pub next_stop_attempt: Option<Instant>,
    /// The sale is durable (or confirmed empty); only command '8' remains.
    pub pending_confirmation: bool,
    pub shift_id: Option<String>,
    pub operator_name: Option<String>,
    /// Written before authorize goes on the wire; cleared only by observed status.
    pub authorize_uncertain: bool,
    /// Registers before arming, to avoid charging the previous sale after a lost ACK.
    pub before_sale_id: Option<String>,
    #[serde(skip)]
    pub journal_loaded: bool,
    #[serde(skip)]
    pub journal_json: Option<String>,
}
