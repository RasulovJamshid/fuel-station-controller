use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use anyhow::Result;
use site_config::{FuelingPositionConfig, SiteConfig};
use sqlx::SqlitePool;
use tokio::sync::{broadcast, RwLock};
use tracing::warn;
use types::{Transaction, WsEvent};

use crate::engine::serial::ReconnectingSerial;
use crate::engine::state::RuntimeFp;
use crate::shifts::ShiftCoordinator;

pub(in crate::engine) use types::preset_metadata;

pub enum SerialBackend {
    Real(Arc<ReconnectingSerial>),
    Mock(Arc<std::sync::Mutex<MockSerial>>),
    /// Scripted request→response pairs for in-process protocol tests. Unlike
    /// [`MockSerial`] (which emulates Wayne framing and is what `protocol: "mock"`
    /// selects at runtime), this is protocol-neutral: it replays whatever the test
    /// scripts and records every frame written for assertions.
    Fake(Arc<std::sync::Mutex<FakeSerial>>),
}

pub struct MockSerial {
    out: VecDeque<u8>,
}

impl MockSerial {
    pub fn new() -> Self {
        Self {
            out: VecDeque::new(),
        }
    }

    fn on_write(&mut self, data: &[u8]) {
        if data.len() >= 4 && data[data.len() - 2] == 0x03 && data[data.len() - 1] == 0xFA {
            let addr = data[0];
            if addr != 0 {
                self.out.extend([addr, 0xC0, 0xFA]);
            }
            return;
        }
        if data.len() >= 3 {
            let n = data.len();
            let addr = data[n - 3];
            if data[n - 2] == 0x20 && data[n - 1] == 0xFA && addr != 0 {
                self.out.push_back(addr);
                self.out.push_back(0x70);
                self.out.push_back(0xFA);
            }
        }
    }

    fn read_available(&mut self, max: usize) -> Vec<u8> {
        let mut v = Vec::new();
        for _ in 0..max {
            if let Some(b) = self.out.pop_front() {
                v.push(b);
            } else {
                break;
            }
        }
        v
    }
}

/// Protocol-neutral scripted transport for unit tests.
///
/// Any driver can be exercised in-process without a PTY or a simulator binary:
/// queue the responses the device would give, run the driver, then assert on
/// [`FakeSerial::written`]. Requests that run past the end of the script return
/// an empty response, which every driver already treats as "no answer".
pub struct FakeSerial {
    responses: VecDeque<Vec<u8>>,
    /// Every frame the driver put on the wire, in order (exchanges and writes).
    written: Vec<Vec<u8>>,
}

impl FakeSerial {
    /// Build a transport that answers successive exchanges with `responses`.
    pub fn new(responses: impl IntoIterator<Item = Vec<u8>>) -> Self {
        Self {
            responses: responses.into_iter().collect(),
            written: Vec::new(),
        }
    }

    /// Frames written by the driver, in order.
    pub fn written(&self) -> &[Vec<u8>] {
        &self.written
    }

    /// Responses that were never consumed — non-empty means the driver sent
    /// fewer requests than the script expected.
    pub fn remaining(&self) -> usize {
        self.responses.len()
    }
}

pub(in crate::engine) fn exchange_serial(backend: &SerialBackend, out: &[u8]) -> Result<Vec<u8>> {
    match backend {
        SerialBackend::Real(real) => real.exchange(out),
        SerialBackend::Mock(m) => {
            let mut g = m.lock().unwrap();
            g.on_write(out);
            Ok(g.read_available(512))
        }
        SerialBackend::Fake(f) => {
            let mut g = f.lock().unwrap();
            g.written.push(out.to_vec());
            Ok(g.responses.pop_front().unwrap_or_default())
        }
    }
}

/// Write-only serial send — used for short ACK frames (`C0 FA`) where the
/// protocol does not expect an immediate response from the dispenser.
pub(in crate::engine) fn write_serial(backend: &SerialBackend, out: &[u8]) -> Result<()> {
    match backend {
        SerialBackend::Real(real) => real.write_only(out),
        SerialBackend::Mock(_) => Ok(()),
        SerialBackend::Fake(f) => {
            f.lock().unwrap().written.push(out.to_vec());
            Ok(())
        }
    }
}

pub(in crate::engine) fn active_positions_by_byte(
    cfg: &SiteConfig,
) -> HashMap<u8, FuelingPositionConfig> {
    cfg.fueling_positions
        .iter()
        .filter(|fp| fp.active)
        .map(|fp| (fp.address_byte, fp.clone()))
        .collect()
}

pub(in crate::engine) async fn broadcast_status(
    byte: u8,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
) {
    let st = {
        let map = runtimes.read().await;
        map.get(&byte).map(|r| r.snapshot_state())
    };
    if let Some(s) = st {
        let _ = events.send(WsEvent::Status(s));
    }
}

/// Mark one poll slot as missed and publish `Offline` if the lane crossed the
/// threshold. Returns whether the lane just went offline.
///
/// Every driver that polls an address needs this; keeping it here stops each new
/// protocol from re-deriving the threshold/emit pairing.
pub(in crate::engine) async fn mark_missed(
    byte: u8,
    fp_cfg: &FuelingPositionConfig,
    threshold: u32,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    events: &broadcast::Sender<WsEvent>,
) -> bool {
    let went_offline = {
        let mut map = runtimes.write().await;
        map.get_mut(&byte)
            .map(|rt| rt.on_poll_missed(threshold))
            .unwrap_or(false)
    };
    if went_offline {
        let _ = events.send(WsEvent::Offline {
            fp_id: fp_cfg.id.clone(),
            label: fp_cfg.label.clone(),
        });
    }
    went_offline
}

/// Persist a finished sale and credit it to the active shift.
///
/// Returns `false` when the sale could not be persisted — the caller must then
/// leave the lane unclosed so the close is retried, and must not tell anyone the
/// sale succeeded.
///
/// Both effects belong together: `persist_closed_transaction` also enqueues the
/// sale to `sync_queue` (so the server admin sees it), and
/// `on_transaction_recorded` moves shift totals. Recording one without the other
/// is how Gilbarco shift reports went stale — do not call these individually.
pub(in crate::engine) async fn persist_and_record(
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
    tx: &Transaction,
) -> bool {
    if let Err(e) = crate::db::queries::persist_closed_transaction(pool, tx).await {
        warn!(tx_id = %tx.id, fp_id = %tx.fp_id, ?e, "sale commit: DB persist failed");
        return false;
    }
    // Shift totals are secondary to durability: the sale is already saved and
    // queued for sync, so a failure here is logged but does not un-commit it.
    if let Err(e) = shifts.on_transaction_recorded(tx).await {
        warn!(tx_id = %tx.id, ?e, "sale commit: shift totals update failed");
    }
    true
}

/// Full close for a completed sale: persist, credit shift totals, then publish
/// `Done`. Returns `false` if the sale was not persisted (no `Done` is sent).
///
/// `Done` is published only after the sale is durable, so a client can never
/// observe a completed sale that is not in the database.
pub(in crate::engine) async fn commit_sale(
    pool: &SqlitePool,
    shifts: &ShiftCoordinator,
    events: &broadcast::Sender<WsEvent>,
    tx: &Transaction,
) -> bool {
    if !persist_and_record(pool, shifts, tx).await {
        return false;
    }
    let _ = events.send(WsEvent::Done(tx.clone()));
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::shift_queries;
    use sqlx::sqlite::SqlitePoolOptions;
    use types::{Shift, ShiftStatus, TxStatus};

    async fn memory_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite pool");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    fn site() -> SiteConfig {
        serde_json::from_str(
            r##"{
                "site": { "id": "t", "name": "T", "timezone": "UTC" },
                "service": { "port": 3001, "log_level": "info", "log_file": "t.log", "db_path": "t.db" },
                "connection": {
                    "protocol": "gilbarco", "port": "COM1", "baud_rate": 9600,
                    "parity": "none", "data_bits": 8, "stop_bits": 1, "response_timeout_ms": 300
                },
                "polling": { "interval_ms": 100, "offline_threshold_polls": 3, "reconnect_settle_rounds": 0 },
                "shifts": { "mode": "manual" },
                "products": [ { "id": 1, "name": "AI-92", "color": "#000", "unit": "litre" } ],
                "fueling_positions": [ {
                    "id": "FP1", "label": "1", "address_byte": 1, "active": true,
                    "nozzles": [ { "index": 1, "product_id": 1, "price": 11000, "active": true } ]
                } ],
                "sync": { "enabled": false, "backend_url": "", "api_key": "" }
            }"##,
        )
        .expect("site config")
    }

    fn sale(id: &str, shift_id: Option<&str>) -> Transaction {
        Transaction {
            id: id.to_string(),
            fp_id: "FP1".into(),
            label: "1".into(),
            address_byte: 1,
            started_at: 1_000,
            completed_at: Some(2_000),
            volume: 2.0,
            amount: 22_000,
            price: 11_000,
            nozzle_index: 1,
            product_id: 1,
            product_name: "AI-92".into(),
            preset_type: None,
            preset_value: None,
            preset_label: None,
            status: TxStatus::Completed,
            shift_id: shift_id.map(|s| s.to_string()),
            operator_name: Some("op".into()),
            parent_tx_id: None,
            combined_volume: 2.0,
            combined_amount: 22_000,
        }
    }

    async fn coordinator_with_active_shift(pool: &SqlitePool, id: &str) -> Arc<ShiftCoordinator> {
        shift_queries::insert_shift(
            pool,
            &Shift {
                id: id.to_string(),
                operator_id: None,
                operator_name: "op".to_string(),
                shift_name: None,
                scheduled_start: None,
                scheduled_end: None,
                started_at: 1_000,
                ended_at: None,
                total_transactions: 0,
                total_volume: 0.0,
                total_amount: 0,
                status: ShiftStatus::Active,
                notes: None,
                position_totals: Vec::new(),
            },
        )
        .await
        .expect("insert shift");
        let c = Arc::new(ShiftCoordinator::new(pool.clone(), Arc::new(site())));
        c.restore().await.expect("restore active shift");
        c
    }

    /// The invariant this helper exists to guarantee: a committed sale lands in
    /// `transactions`, is queued for server sync, and moves shift totals — all
    /// three, from one call. Missing the third is what made Gilbarco shift
    /// reports go stale.
    #[tokio::test]
    async fn commit_sale_persists_enqueues_and_credits_shift() {
        let pool = memory_pool().await;
        let shifts = coordinator_with_active_shift(&pool, "shift-1").await;
        let (events, mut rx) = broadcast::channel(8);

        let tx = sale("tx-1", Some("shift-1"));
        assert!(commit_sale(&pool, &shifts, &events, &tx).await);

        let n_tx: i64 = sqlx::query_scalar("select count(*) from transactions where id = ?")
            .bind(&tx.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n_tx, 1, "sale must be persisted");

        let n_sync: i64 = sqlx::query_scalar(
            "select count(*) from sync_queue where entity_type = 'transaction' and entity_id = ?",
        )
        .bind(&tx.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(n_sync, 1, "sale must be queued for server sync");

        let (count, vol, amt): (i64, f64, i64) = sqlx::query_as(
            "select total_transactions, total_volume, total_amount from shifts where id = 'shift-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            (count, vol, amt),
            (1, 2.0, 22_000),
            "shift totals must move"
        );

        assert!(
            matches!(rx.try_recv(), Ok(WsEvent::Done(d)) if d.id == tx.id),
            "Done must be published after the sale is durable"
        );
    }

    /// A sale that cannot be persisted must not be announced as complete, and the
    /// caller must be able to tell so it can leave the lane open for retry.
    #[tokio::test]
    async fn commit_sale_reports_failure_and_publishes_no_done() {
        let pool = memory_pool().await;
        let shifts = Arc::new(ShiftCoordinator::new(pool.clone(), Arc::new(site())));
        let (events, mut rx) = broadcast::channel(8);
        // Closing the pool makes every write fail, standing in for a disk fault.
        pool.close().await;

        assert!(!commit_sale(&pool, &shifts, &events, &sale("tx-2", None)).await);
        assert!(
            rx.try_recv().is_err(),
            "no Done may be published for a sale that was never persisted"
        );
    }

    /// `persist_and_record` is the half-close used by lanes that publish their own
    /// event (Wayne's nozzle-removed path); it must still credit the shift.
    #[tokio::test]
    async fn persist_and_record_credits_shift_without_publishing_done() {
        let pool = memory_pool().await;
        let shifts = coordinator_with_active_shift(&pool, "shift-2").await;

        assert!(persist_and_record(&pool, &shifts, &sale("tx-3", Some("shift-2"))).await);

        let count: i64 =
            sqlx::query_scalar("select total_transactions from shifts where id = 'shift-2'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
    }

    /// The fake transport must be protocol-neutral: it replays whatever is
    /// scripted and records every frame, with no framing assumptions. Uses
    /// Gilbarco frames precisely because `MockSerial` cannot serve them.
    #[test]
    fn fake_serial_is_protocol_neutral() {
        let fake = Arc::new(std::sync::Mutex::new(FakeSerial::new([
            vec![0x61],       // status: addr 1 idle
            vec![0xFF, 0xF6], // totals header
        ])));
        let backend = SerialBackend::Fake(fake.clone());

        assert_eq!(exchange_serial(&backend, &[0x01]).unwrap(), vec![0x61]);
        assert_eq!(
            exchange_serial(&backend, &[0x51]).unwrap(),
            vec![0xFF, 0xF6]
        );
        // Past the end of the script: empty, which drivers read as "no answer".
        assert!(exchange_serial(&backend, &[0x02]).unwrap().is_empty());
        write_serial(&backend, &[0xC0]).unwrap();

        let g = fake.lock().unwrap();
        assert_eq!(
            g.written(),
            &[vec![0x01], vec![0x51], vec![0x02], vec![0xC0]],
            "every frame written must be recorded in order, exchanges and writes alike"
        );
        assert_eq!(g.remaining(), 0);
    }
}
