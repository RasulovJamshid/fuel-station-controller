//! Shelf reservation and terminal cancellation ownership.
use std::time::Instant;

#[derive(Debug, Clone, Default)]
pub(in crate::engine) struct ShelfRuntimeState {
    /// Physical address owned by the selected nozzle on this side.
    pub wire_address: Option<u8>,
    /// Set under the runtime lock before the first authorization write.
    pub start_attempted: bool,
    /// Price selected for this order, independent of subsequent config updates.
    pub order_price: Option<u32>,
    /// HTTP ingress interlock: a queued Cancel must win over a later lift poll.
    pub cancel_requested: bool,
    pub stop_requested: bool,
    pub next_stop_attempt: Option<Instant>,
    /// Retain authoritative data if committing it to the database fails.
    pub final_sale: Option<shelf_v22::FinalSale>,
}
