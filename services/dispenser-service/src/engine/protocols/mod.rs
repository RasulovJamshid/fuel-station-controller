//! Per-protocol dispenser runtimes.
//!
//! Each module owns one protocol's complete runtime: wire framing, poll rotation,
//! command handling, and transaction close. Modules never reference each other —
//! only [`shared`] and the common engine state.
//!
//! # Adding a protocol
//!
//! 1. Add the variant to `site_config::Protocol`. The `match` in
//!    `engine::poll_loop::run_poll_loop` is exhaustive, so this fails to compile
//!    until step 3 — that is deliberate.
//! 2. Create `protocols/<name>.rs` with the entry point every runtime shares:
//!
//!    ```ignore
//!    pub(in crate::engine) async fn run(
//!        cfg: Arc<SiteConfig>,
//!        backend: SerialBackend,
//!        runtimes: Arc<RwLock<HashMap<u8, RuntimeFp>>>,
//!        disp_by_byte: HashMap<u8, FuelingPositionConfig>,
//!        events: broadcast::Sender<WsEvent>,
//!        commands: mpsc::Receiver<DispatchCommand>,
//!        pool: SqlitePool,
//!        shifts: Arc<ShiftCoordinator>,
//!    ) { /* own poll loop */ }
//!    ```
//!
//! 3. Register it in `run_poll_loop`'s match and add `pub(super) mod <name>;` here.
//! 4. Put the wire codec in its own crate under `crates/` — this module is service
//!    runtime logic only, never framing or parsing.
//!
//! # Rules a new runtime must follow
//!
//! **Close every sale through [`shared::commit_sale`].** It persists the sale,
//! enqueues it to `sync_queue` for the server, credits shift totals, and only then
//! publishes `Done`. Calling those steps by hand is how Gilbarco shift reports
//! once went stale. If a lane publishes its own event instead of `Done`, use
//! [`shared::persist_and_record`] and emit afterwards. When either returns
//! `false` the sale was **not** saved: leave the lane unclosed so the close
//! retries, and do not advance it to `Done`.
//!
//! **Report missed polls through [`shared::mark_missed`]** so offline thresholds
//! and `Offline` events stay consistent across protocols.
//!
//! **Own your rotation.** Tick timing, address iteration, keepalives, turnaround
//! delays, and retries belong to the runtime — the protocols differ structurally
//! here, and there is intentionally no common scheduler.
//!
//! **Handle every `DispatchCommand` arm.** Rust's exhaustive match enforces this;
//! group the ones your device cannot do into an explicit ignore arm with a comment
//! saying why, rather than a catch-all `_`.
//!
//! # Testing
//!
//! [`shared::FakeSerial`] is a protocol-neutral scripted transport: queue the
//! responses the device would give, run the code under test, and assert on the
//! frames it wrote. Use it rather than `MockSerial`, which emulates Wayne framing
//! and only serves the `protocol: "mock"` runtime configuration.

pub(super) mod azt;
pub(super) mod gilbarco;
pub(super) mod shared;
pub(super) mod wayne;
pub(super) mod wayne_state;
