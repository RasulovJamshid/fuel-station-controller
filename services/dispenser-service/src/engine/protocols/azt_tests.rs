//! Exercise operator commands and failure recovery through the actual AZT loop.
use super::super::shared::FakeSerial;
use super::*;
use std::sync::Mutex;

fn data(value: &[u8]) -> Vec<u8> {
    azt::encode_data_response(value)
}
fn ack() -> Vec<u8> {
    azt::encode_short_response(azt::ACK)
}
fn totals() -> Vec<u8> {
    data(b"0001000000113000")
}
fn full(cl: u64) -> Vec<u8> {
    data(format!("{cl:05}{:07}1130", (cl * 1130 + 50) / 100).as_bytes())
}
fn number(n: u32) -> Vec<u8> {
    data(format!("{n:08}").as_bytes())
}

struct Harness {
    cfg: SiteConfig,
    runtimes: Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    pool: SqlitePool,
    shifts: ShiftCoordinator,
    events: broadcast::Sender<WsEvent>,
    received: broadcast::Receiver<WsEvent>,
    trks: HashMap<u8, azt::TrkType>,
}

impl Harness {
    async fn new() -> Self {
        let mut cfg: SiteConfig =
            serde_json::from_str(include_str!("../../../site.config.azt.json")).unwrap();
        cfg.fueling_positions.truncate(1);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO shifts (id, operator_name, started_at) VALUES ('shift', 'Operator', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let shifts = ShiftCoordinator::new(pool.clone(), Arc::new(cfg.clone()));
        shifts.restore().await.unwrap();
        let runtimes = Arc::new(RwLock::new(crate::engine::initial_runtimes(&cfg)));
        let (events, received) = broadcast::channel(256);
        Self {
            cfg,
            runtimes,
            pool,
            shifts,
            events,
            received,
            trks: HashMap::new(),
        }
    }

    async fn command(&mut self, cmd: DispatchCommand, responses: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        let fake = Arc::new(Mutex::new(FakeSerial::new(responses)));
        azt_apply_command(
            &self.cfg,
            &self.runtimes,
            &self.events,
            &SerialBackend::Fake(fake.clone()),
            &self.pool,
            &self.shifts,
            cmd,
        )
        .await;
        let f = fake.lock().unwrap();
        assert_eq!(f.remaining(), 0);
        f.written().to_vec()
    }

    async fn arm(&mut self) {
        self.runtimes
            .write()
            .await
            .get_mut(&1)
            .unwrap()
            .state
            .status = FpStatus::Idle;
        let written = self
            .command(
                DispatchCommand::Preauthorize {
                    byte: 1,
                    price: 11300,
                    preset: Preset::Volume(10.0),
                    nozzle_index: 1,
                },
                vec![
                    data(b"0"),
                    data(b"H"),
                    ack(),
                    ack(),
                    full(0),
                    number(41),
                    ack(),
                ],
            )
            .await;
        assert_eq!(
            written,
            vec![
                azt::status(1),
                azt::trk_type(1),
                azt::set_price(1, 1130),
                azt::set_dose_litres(1, 1000),
                azt::full_data(1),
                azt::transaction_number(1),
                azt::authorize(1)
            ]
        );
    }

    async fn poll(&mut self, responses: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        let fake = Arc::new(Mutex::new(FakeSerial::new(responses)));
        azt_poll_card(
            1,
            &self.cfg,
            &SerialBackend::Fake(fake.clone()),
            &self.runtimes,
            &active_positions_by_byte(&self.cfg),
            &self.events,
            &self.pool,
            &self.shifts,
            &mut self.trks,
            &mut HashMap::new(),
        )
        .await;
        let f = fake.lock().unwrap();
        assert_eq!(
            f.remaining(),
            0,
            "unconsumed responses; writes: {:?}",
            f.written()
        );
        f.written().to_vec()
    }

    async fn retry_due(&self) {
        self.runtimes
            .write()
            .await
            .get_mut(&1)
            .unwrap()
            .azt
            .next_stop_attempt = None;
    }

    async fn count(&self) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM transactions")
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    fn take_events(&mut self) -> Vec<WsEvent> {
        let mut events = Vec::new();
        while let Ok(event) = self.received.try_recv() {
            events.push(event);
        }
        events
    }

    async fn assert_sale(&self, volume: f64, amount: i64) {
        let row: (f64, i64, String, i64) =
            sqlx::query_as("SELECT volume, amount, status, nozzle_index FROM transactions")
                .fetch_one(&self.pool)
                .await
                .unwrap();
        assert_eq!(row, (volume, amount, "COMPLETED".into(), 1));
    }
}

#[tokio::test]
async fn preauthorization_finishes_without_observing_dispensing() {
    let mut h = Harness::new().await;
    h.arm().await;
    let written = h
        .poll(vec![
            data(b"40"),
            data(b"H"),
            full(1000),
            number(42),
            ack(),
            totals(),
        ])
        .await;
    assert_eq!(
        written,
        vec![
            azt::status(1),
            azt::trk_type(1),
            azt::full_data(1),
            azt::transaction_number(1),
            azt::confirm_totals(1),
            azt::totals(1)
        ]
    );
    h.assert_sale(10.0, 113000).await;
    assert_eq!(h.runtimes.read().await[&1].state.status, FpStatus::Done);
    assert_eq!(
        h.take_events()
            .iter()
            .filter(|e| matches!(e, WsEvent::Done(_)))
            .count(),
        1
    );
}

#[tokio::test]
async fn failed_stop_is_retried_until_physical_completion_without_pausing() {
    let mut h = Harness::new().await;
    h.arm().await;
    let id = h.runtimes.read().await[&1]
        .current_tx
        .as_ref()
        .unwrap()
        .id
        .clone();
    h.command(DispatchCommand::Stop { byte: 1 }, vec![Vec::new()])
        .await;
    assert_eq!(
        h.runtimes.read().await[&1].state.status,
        FpStatus::Finalizing
    );
    h.retry_due().await;
    let written = h
        .poll(vec![
            data(b"3"),
            azt::encode_short_response(azt::CAN),
            data(b"3"),
            data(b"000125"),
        ])
        .await;
    assert_eq!(
        written,
        vec![
            azt::status(1),
            azt::reset(1),
            azt::status(1),
            azt::current_data(1)
        ]
    );
    {
        let map = h.runtimes.read().await;
        assert_eq!(map[&1].current_tx.as_ref().unwrap().id, id);
        assert_eq!(map[&1].state.status, FpStatus::Finalizing);
        assert_eq!(map[&1].state.volume, 1.25);
    }
    h.retry_due().await;
    h.poll(vec![
        data(b"3"),
        ack(),
        data(b"40"),
        data(b"H"),
        full(125),
        number(42),
        ack(),
        totals(),
    ])
    .await;
    h.assert_sale(1.25, 14130).await;
    assert!(!h
        .take_events()
        .iter()
        .any(|e| matches!(e, WsEvent::Paused { .. })));
}

#[tokio::test]
async fn cancellation_racing_with_flow_records_the_partial_sale() {
    let mut h = Harness::new().await;
    h.arm().await;
    let written = h
        .command(DispatchCommand::CancelPreauth { byte: 1 }, vec![ack()])
        .await;
    assert_eq!(written, vec![azt::reset(1)]);
    assert!(h.runtimes.read().await[&1].current_tx.is_some());
    h.poll(vec![
        data(b"40"),
        data(b"H"),
        full(125),
        number(42),
        ack(),
        totals(),
    ])
    .await;
    h.assert_sale(1.25, 14130).await;
    assert!(!h
        .take_events()
        .iter()
        .any(|e| matches!(e, WsEvent::PreAuthCancelled { .. })));
}

#[tokio::test]
async fn empty_cancel_retains_ownership_until_confirmation_and_blocks_reset_and_authorize() {
    let mut h = Harness::new().await;
    h.arm().await;
    h.command(DispatchCommand::CancelPreauth { byte: 1 }, vec![ack()])
        .await;
    h.poll(vec![data(b"40"), data(b"H"), full(0), Vec::new()])
        .await;
    assert!(h.runtimes.read().await[&1].azt.pending_confirmation);
    for cmd in [
        DispatchCommand::ResetLane { byte: 1 },
        DispatchCommand::ResetAll,
        DispatchCommand::Preauthorize {
            byte: 1,
            price: 11300,
            preset: Preset::Volume(10.0),
            nozzle_index: 1,
        },
    ] {
        assert!(h.command(cmd, vec![]).await.is_empty());
    }
    assert!(h.runtimes.read().await[&1].current_tx.is_some());
    assert!(!h
        .take_events()
        .iter()
        .any(|e| matches!(e, WsEvent::PreAuthCancelled { .. })));
    let written = h.poll(vec![data(b"40"), ack(), totals()]).await;
    assert_eq!(
        written,
        vec![azt::status(1), azt::confirm_totals(1), azt::totals(1)]
    );
    assert_eq!(h.count().await, 0);
    assert_eq!(h.runtimes.read().await[&1].state.status, FpStatus::Idle);
    assert!(h
        .take_events()
        .iter()
        .any(|e| matches!(e, WsEvent::PreAuthCancelled { .. })));
}

#[tokio::test]
async fn restart_after_saved_sale_and_lost_confirmation_does_not_duplicate_sale_or_shift() {
    let mut h = Harness::new().await;
    h.arm().await;
    h.poll(vec![
        data(b"40"),
        data(b"H"),
        full(1000),
        number(42),
        Vec::new(),
    ])
    .await;
    assert_eq!(h.count().await, 1);
    assert!(h.runtimes.read().await[&1].azt.pending_confirmation);
    assert_eq!(
        h.take_events()
            .iter()
            .filter(|e| matches!(e, WsEvent::Done(_)))
            .count(),
        1
    );
    *h.runtimes.write().await = crate::engine::initial_runtimes(&h.cfg);
    h.trks.clear();
    h.poll(vec![data(b"40"), ack(), totals()]).await;
    assert_eq!(h.count().await, 1);
    let shift: (i64, f64, i64) = sqlx::query_as(
        "SELECT total_transactions, total_volume, total_amount FROM shifts WHERE id = 'shift'",
    )
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(shift, (1, 10.0, 113000));
    let queue: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'transaction'")
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(queue, 1);
    assert!(!h
        .take_events()
        .iter()
        .any(|e| matches!(e, WsEvent::Done(_))));
}

#[tokio::test]
async fn recovered_finished_sale_uses_its_actual_hose_and_has_no_invented_preset() {
    let mut h = Harness::new().await;
    let mut nozzle = h.cfg.fueling_positions[0].nozzles[0].clone();
    nozzle.index = 2;
    nozzle.azt_address = 16;
    h.cfg.fueling_positions[0].nozzles.push(nozzle);
    *h.runtimes.write().await = crate::engine::initial_runtimes(&h.cfg);
    let written = h
        .poll(vec![
            data(b"0"),
            data(b"41"),
            data(b"H"),
            full(125),
            number(42),
            ack(),
            totals(),
            totals(),
        ])
        .await;
    assert!(written.contains(&azt::full_data(16)));
    assert!(written.contains(&azt::confirm_totals(16)));
    let row: (i64, Option<String>) =
        sqlx::query_as("SELECT nozzle_index, preset_type FROM transactions")
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(row, (2, None));
}

#[tokio::test]
async fn database_failure_keeps_final_data_unacknowledged_until_saved() {
    let mut h = Harness::new().await;
    h.arm().await;
    sqlx::query("CREATE TRIGGER fail_sale BEFORE INSERT ON transactions BEGIN SELECT RAISE(FAIL, 'disk failure'); END")
        .execute(&h.pool).await.unwrap();
    let written = h
        .poll(vec![data(b"40"), data(b"H"), full(125), number(42)])
        .await;
    assert!(!written.contains(&azt::confirm_totals(1)));
    assert_eq!(h.count().await, 0);
    assert!(h.runtimes.read().await[&1].current_tx.is_some());
    assert!(!h
        .take_events()
        .iter()
        .any(|e| matches!(e, WsEvent::Done(_))));
    sqlx::query("DROP TRIGGER fail_sale")
        .execute(&h.pool)
        .await
        .unwrap();
    h.poll(vec![data(b"40"), full(125), number(42), ack(), totals()])
        .await;
    h.assert_sale(1.25, 14130).await;
}

#[tokio::test]
async fn missing_final_readings_or_identity_never_clear_a_sale() {
    let mut h = Harness::new().await;
    h.arm().await;
    let written = h
        .poll(vec![data(b"40"), data(b"H"), Vec::new(), data(b"broken")])
        .await;
    assert!(!written.contains(&azt::confirm_totals(1)));
    let written = h.poll(vec![data(b"40"), full(1000), Vec::new()]).await;
    assert!(!written.contains(&azt::confirm_totals(1)));
    assert_eq!(h.count().await, 0);
    h.poll(vec![data(b"40"), full(1000), number(42), ack(), totals()])
        .await;
    h.assert_sale(10.0, 113000).await;
}

#[tokio::test]
async fn emergency_stop_retries_every_hose_including_unobserved_fills() {
    let mut h = Harness::new().await;
    let mut nozzle = h.cfg.fueling_positions[0].nozzles[0].clone();
    nozzle.index = 2;
    nozzle.azt_address = 16;
    h.cfg.fueling_positions[0].nozzles.push(nozzle);
    h.arm().await;
    assert_eq!(
        h.command(DispatchCommand::EStop, vec![Vec::new(), Vec::new()])
            .await,
        vec![azt::reset(1), azt::reset(16)]
    );
    h.retry_due().await;
    let fake = Arc::new(Mutex::new(FakeSerial::new([
        data(b"2"),
        ack(),
        data(b"3"),
        ack(),
    ])));
    azt_send_pending_stops(1, &SerialBackend::Fake(fake.clone()), &h.runtimes).await;
    assert_eq!(
        fake.lock().unwrap().written(),
        &[
            azt::status(1),
            azt::reset(1),
            azt::status(16),
            azt::reset(16)
        ]
    );
    assert_eq!(h.runtimes.read().await[&1].azt.stop_addresses.len(), 2);
}

#[tokio::test]
async fn preauth_timeout_stops_but_preserves_a_sale_that_started_during_timeout() {
    let mut h = Harness::new().await;
    h.cfg.ui.preauth_timeout_seconds = 1;
    h.arm().await;
    h.runtimes
        .write()
        .await
        .get_mut(&1)
        .unwrap()
        .pre_auth_started_at = Some(0);
    assert_eq!(
        h.poll(vec![data(b"2"), Vec::new()]).await,
        vec![azt::status(1), azt::reset(1)]
    );
    assert!(h.runtimes.read().await[&1].current_tx.is_some());
    h.poll(vec![
        data(b"40"),
        data(b"H"),
        full(125),
        number(42),
        ack(),
        totals(),
    ])
    .await;
    h.assert_sale(1.25, 14130).await;
}

#[tokio::test]
async fn lost_confirmation_ack_followed_by_idle_releases_empty_cancellation() {
    let mut h = Harness::new().await;
    h.arm().await;
    h.command(DispatchCommand::CancelPreauth { byte: 1 }, vec![ack()])
        .await;
    h.poll(vec![data(b"40"), data(b"H"), full(0), Vec::new()])
        .await;
    assert_eq!(h.poll(vec![data(b"0")]).await, vec![azt::status(1)]);
    assert!(h.runtimes.read().await[&1].current_tx.is_none());
    assert_eq!(h.runtimes.read().await[&1].state.status, FpStatus::Idle);
    assert_eq!(h.count().await, 0);
}

#[tokio::test]
async fn devices_without_transaction_number_use_stable_totalizer_identity() {
    let mut h = Harness::new().await;
    h.poll(vec![
        data(b"40"),
        data(b"H"),
        full(125),
        azt::encode_short_response(azt::NAK),
        totals(),
        Vec::new(),
    ])
    .await;
    *h.runtimes.write().await = crate::engine::initial_runtimes(&h.cfg);
    h.poll(vec![data(b"40"), ack(), totals()]).await;
    assert_eq!(h.count().await, 1);
}

#[tokio::test]
async fn saved_sale_blocks_new_order_until_confirmation_and_retries_only_confirmation() {
    let mut h = Harness::new().await;
    h.arm().await;
    h.poll(vec![
        data(b"40"),
        data(b"H"),
        full(1000),
        number(42),
        Vec::new(),
    ])
    .await;
    h.take_events();
    assert!(h.runtimes.read().await[&1].current_tx.is_none());
    for command in [
        DispatchCommand::ResetAll,
        DispatchCommand::ResetLane { byte: 1 },
        DispatchCommand::Preauthorize {
            byte: 1,
            price: 11300,
            preset: Preset::Amount(100000),
            nozzle_index: 1,
        },
    ] {
        assert!(h.command(command, vec![]).await.is_empty());
    }
    assert!(h.runtimes.read().await[&1].azt.pending_confirmation);
    assert_eq!(
        h.poll(vec![data(b"40"), ack(), totals()]).await,
        vec![azt::status(1), azt::confirm_totals(1), azt::totals(1)]
    );
    assert_eq!(h.count().await, 1);
    assert!(!h
        .take_events()
        .iter()
        .any(|e| matches!(e, WsEvent::Done(_))));
}

#[tokio::test]
async fn idle_after_missed_completion_reads_final_data_before_releasing_armed_sale() {
    let mut h = Harness::new().await;
    h.arm().await;
    let written = h
        .poll(vec![
            data(b"0"),
            data(b"H"),
            full(125),
            number(42),
            totals(),
        ])
        .await;
    assert!(!written.contains(&azt::confirm_totals(1)));
    h.assert_sale(1.25, 14130).await;
    assert!(h.runtimes.read().await[&1].current_tx.is_none());
}

#[tokio::test]
async fn price_updates_apply_to_next_order_without_changing_live_sale() {
    let mut h = Harness::new().await;
    h.arm().await;
    assert!(h
        .command(
            DispatchCommand::UpdatePrices {
                updates: vec![types::UpdatePriceCmd {
                    fp_id: "FP1".into(),
                    nozzle_index: 1,
                    price: 12500
                }],
                changed_by: "Operator".into(),
            },
            vec![]
        )
        .await
        .is_empty());
    h.poll(vec![data(b"3"), data(b"000100")]).await;
    let map = h.runtimes.read().await;
    assert_eq!(map[&1].nozzle_prices[&1], 12500);
    assert_eq!(map[&1].state.price, 11300);
    assert_eq!(map[&1].state.amount, 11300);
}

fn preauthorize(preset: Preset) -> DispatchCommand {
    DispatchCommand::Preauthorize {
        byte: 1,
        price: 11300,
        preset,
        nozzle_index: 1,
    }
}

#[tokio::test]
async fn lost_authorize_ack_survives_restart_with_order_and_original_shift() {
    let mut h = Harness::new().await;
    h.command(
        preauthorize(Preset::Amount(113000)),
        vec![
            data(b"0"),
            data(b"H"),
            ack(),
            ack(),
            full(0),
            number(41),
            Vec::new(),
        ],
    )
    .await;
    let ctx = h.runtimes.read().await[&1].current_tx.clone().unwrap();
    assert!(h.runtimes.read().await[&1].azt.authorize_uncertain);
    assert!(h.runtimes.read().await[&1].state.protocol_error.is_some());
    assert!(h
        .command(preauthorize(Preset::Volume(20.0)), vec![])
        .await
        .is_empty());
    // Shift may have been auto-closed while the service was down.
    sqlx::query("UPDATE shifts SET status = 'CLOSED', ended_at = 100 WHERE id = 'shift'")
        .execute(&h.pool)
        .await
        .unwrap();
    h.shifts = ShiftCoordinator::new(h.pool.clone(), Arc::new(h.cfg.clone()));
    h.shifts.restore().await.unwrap();
    *h.runtimes.write().await = crate::engine::initial_runtimes(&h.cfg);
    h.poll(vec![data(b"2")]).await;
    {
        let map = h.runtimes.read().await;
        assert_eq!(map[&1].state.status, FpStatus::PreAuthorized);
        assert!(!map[&1].azt.authorize_uncertain);
        assert_eq!(map[&1].current_tx.as_ref().unwrap().id, ctx.id);
    }
    h.poll(vec![
        data(b"40"),
        data(b"H"),
        full(1000),
        number(42),
        ack(),
        totals(),
    ])
    .await;
    let row: (
        i64,
        Option<String>,
        Option<f64>,
        Option<String>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT started_at, preset_type, preset_value, shift_id, operator_name FROM transactions",
    )
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            ctx.started_at,
            Some("amount".into()),
            Some(113000.0),
            Some("shift".into()),
            Some("Operator".into())
        )
    );
    let total: i64 = sqlx::query_scalar("SELECT total_amount FROM shifts WHERE id = 'shift'")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(total, 113000);
}

#[tokio::test]
async fn uncertain_authorization_that_never_reached_pump_cancels_without_sale() {
    let mut h = Harness::new().await;
    h.command(
        preauthorize(Preset::Volume(10.0)),
        vec![
            data(b"0"),
            data(b"H"),
            ack(),
            ack(),
            full(125),
            number(41),
            Vec::new(),
        ],
    )
    .await;
    *h.runtimes.write().await = crate::engine::initial_runtimes(&h.cfg);
    h.poll(vec![data(b"0"), data(b"H"), full(125), number(41)])
        .await;
    assert_eq!(h.count().await, 0);
    assert!(h.runtimes.read().await[&1].current_tx.is_none());
    let journals: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM azt_recovery")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(journals, 0);
}

#[tokio::test]
async fn restart_preserves_stop_and_resends_before_adopting_delivery() {
    let mut h = Harness::new().await;
    h.arm().await;
    h.command(DispatchCommand::Stop { byte: 1 }, vec![Vec::new()])
        .await;
    *h.runtimes.write().await = crate::engine::initial_runtimes(&h.cfg);
    let writes = h
        .poll(vec![data(b"3"), ack(), data(b"3"), data(b"000125")])
        .await;
    assert_eq!(
        writes,
        vec![
            azt::status(1),
            azt::reset(1),
            azt::status(1),
            azt::current_data(1)
        ]
    );
    assert!(h.runtimes.read().await[&1].azt.stop_requested);
    assert_eq!(
        h.runtimes.read().await[&1].state.status,
        FpStatus::Finalizing
    );
    h.poll(vec![
        data(b"40"),
        data(b"H"),
        full(125),
        number(42),
        ack(),
        totals(),
    ])
    .await;
    h.assert_sale(1.25, 14130).await;
}

#[tokio::test]
async fn journal_write_failure_prevents_authorize_but_never_withholds_stop() {
    let mut h = Harness::new().await;
    sqlx::query("CREATE TRIGGER fail_journal BEFORE INSERT ON azt_recovery BEGIN SELECT RAISE(FAIL, 'disk failure'); END")
        .execute(&h.pool).await.unwrap();
    let writes = h
        .command(
            preauthorize(Preset::Volume(10.0)),
            vec![data(b"0"), data(b"H"), ack(), ack(), full(0), number(41)],
        )
        .await;
    assert!(!writes.contains(&azt::authorize(1)));
    assert!(h.runtimes.read().await[&1].current_tx.is_none());
    let writes = h
        .command(DispatchCommand::Stop { byte: 1 }, vec![ack()])
        .await;
    assert_eq!(writes, vec![azt::reset(1)]);
    assert!(h.runtimes.read().await[&1].azt.stop_addresses.contains(&1));
    assert!(h.runtimes.read().await[&1].state.protocol_error.is_some());
}

#[tokio::test]
async fn corrupt_or_remapped_journal_blocks_new_orders_and_confirmation() {
    for corrupt in [false, true] {
        let mut h = Harness::new().await;
        h.arm().await;
        if corrupt {
            sqlx::query("UPDATE azt_recovery SET payload_json = 'broken'")
                .execute(&h.pool)
                .await
                .unwrap();
        } else {
            h.cfg.fueling_positions[0].nozzles[0].azt_address = 16;
        }
        *h.runtimes.write().await = crate::engine::initial_runtimes(&h.cfg);
        assert!(h
            .command(preauthorize(Preset::Volume(1.0)), vec![])
            .await
            .is_empty());
        assert!(h.poll(vec![]).await.is_empty());
        assert!(h.runtimes.read().await[&1].state.protocol_error.is_some());
        assert_eq!(h.count().await, 0);
    }
}

#[tokio::test]
async fn sync_or_shift_failure_rolls_back_sale_queue_and_credit_then_retries_once() {
    for trigger in [
        "CREATE TRIGGER fail_commit BEFORE INSERT ON sync_queue BEGIN SELECT RAISE(FAIL, 'sync failure'); END",
        "CREATE TRIGGER fail_commit BEFORE UPDATE ON shifts BEGIN SELECT RAISE(FAIL, 'shift failure'); END",
    ] {
        let mut h = Harness::new().await;
        h.arm().await;
        sqlx::query(trigger).execute(&h.pool).await.unwrap();
        let writes = h.poll(vec![data(b"40"), data(b"H"), full(125), number(42)]).await;
        assert!(!writes.contains(&azt::confirm_totals(1)));
        assert_eq!(h.count().await, 0);
        let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'transaction'")
            .fetch_one(&h.pool).await.unwrap();
        assert_eq!(queued, 0);
        let amount: i64 = sqlx::query_scalar("SELECT total_amount FROM shifts WHERE id = 'shift'")
            .fetch_one(&h.pool).await.unwrap();
        assert_eq!(amount, 0);
        assert_eq!(h.shifts.current().await.unwrap().total_amount, 0);
        assert!(!h.take_events().iter().any(|e| matches!(e, WsEvent::Done(_))));
        sqlx::query("DROP TRIGGER fail_commit").execute(&h.pool).await.unwrap();
        h.poll(vec![data(b"40"), full(125), number(42), ack(), totals()]).await;
        h.assert_sale(1.25, 14130).await;
        assert_eq!(h.shifts.current().await.unwrap().total_amount, 14130);
        assert_eq!(h.take_events().iter().filter(|e| matches!(e, WsEvent::Done(_))).count(), 1);
    }
}

#[tokio::test]
async fn crash_after_atomic_commit_before_journal_confirmation_is_idempotent() {
    let mut h = Harness::new().await;
    h.arm().await;
    // Fail only the transition to the durable-confirmation phase.
    sqlx::query("CREATE TRIGGER fail_confirm_journal BEFORE UPDATE ON azt_recovery WHEN json_extract(NEW.payload_json, '$.azt.pending_confirmation') = 1 BEGIN SELECT RAISE(FAIL, 'journal failure'); END")
        .execute(&h.pool).await.unwrap();
    let writes = h
        .poll(vec![data(b"40"), data(b"H"), full(125), number(42)])
        .await;
    assert!(!writes.contains(&azt::confirm_totals(1)));
    assert_eq!(h.count().await, 1);
    sqlx::query("DROP TRIGGER fail_confirm_journal")
        .execute(&h.pool)
        .await
        .unwrap();
    *h.runtimes.write().await = crate::engine::initial_runtimes(&h.cfg);
    h.take_events();
    h.poll(vec![data(b"40"), full(125), number(42), ack(), totals()])
        .await;
    assert_eq!(h.count().await, 1);
    assert_eq!(h.shifts.current().await.unwrap().total_amount, 14130);
    assert!(!h
        .take_events()
        .iter()
        .any(|e| matches!(e, WsEvent::Done(_))));
}

#[tokio::test]
async fn lifted_first_hose_and_invalid_reply_cannot_hide_finished_second_hose() {
    for first in [data(b"1"), ack()] {
        let mut h = Harness::new().await;
        let mut nozzle = h.cfg.fueling_positions[0].nozzles[0].clone();
        nozzle.index = 2;
        nozzle.azt_address = 16;
        h.cfg.fueling_positions[0].nozzles.push(nozzle);
        *h.runtimes.write().await = crate::engine::initial_runtimes(&h.cfg);
        let writes = h
            .poll(vec![
                first,
                data(b"40"),
                data(b"H"),
                full(125),
                number(42),
                ack(),
                totals(),
                totals(),
            ])
            .await;
        assert!(writes.contains(&azt::full_data(16)));
        assert!(writes.contains(&azt::confirm_totals(16)));
        assert_eq!(h.count().await, 1);
    }
}

#[tokio::test]
async fn stale_live_readings_accumulate_misses_and_are_visible_until_recovered() {
    let mut h = Harness::new().await;
    h.arm().await;
    h.poll(vec![data(b"3"), data(b"000125")]).await;
    for missed in 1..=4 {
        h.poll(vec![data(b"3"), Vec::new()]).await;
        let map = h.runtimes.read().await;
        assert_eq!(map[&1].state.volume, 1.25);
        assert_eq!(map[&1].state.missed_polls, missed);
        assert!(map[&1]
            .state
            .protocol_error
            .as_ref()
            .unwrap()
            .contains("stale"));
        assert!(map[&1].current_tx.is_some());
    }
    h.poll(vec![data(b"3"), data(b"000200")]).await;
    let map = h.runtimes.read().await;
    assert_eq!(map[&1].state.volume, 2.0);
    assert_eq!(map[&1].state.missed_polls, 0);
    assert!(map[&1].state.protocol_error.is_none());
}

#[test]
fn wire_validation_rejects_truncation_and_obeys_each_pumps_capacity() {
    for price in [0, 1, 11305, 100000] {
        assert!(validate_price(price).is_err());
    }
    for preset in [
        Preset::Amount(1),
        Preset::Amount(113005),
        Preset::Volume(f64::NAN),
        Preset::Volume(f64::INFINITY),
        Preset::Volume(0.001),
        Preset::Volume(1.234),
        Preset::Volume(990.01),
    ] {
        assert!(validate_order(&preset, 11300).is_err());
    }
    assert!(validate_order(&Preset::Volume(1.23), 11300).is_ok());
    assert!(validate_order(&Preset::Amount(113000), 11300).is_ok());
    assert!(validate_order(&Preset::Amount(9999990), 10).is_err());
    let small = azt::TrkType::from_identifier(b'A').unwrap();
    let large = azt::TrkType::from_identifier(b'H').unwrap();
    assert!(azt_dose_frame(1, &Preset::Volume(990.0), 11300, small, true).is_err());
    assert!(azt_dose_frame(1, &Preset::Volume(990.0), 11300, large, true).is_ok());
    assert_eq!(
        azt_dose_frame(1, &Preset::Str("full".into()), 11300, small, true).unwrap(),
        azt::set_dose_litres_full_tank(1, 88495)
    );
}

#[tokio::test]
async fn restored_preauthorization_keeps_its_original_timeout() {
    let mut h = Harness::new().await;
    h.cfg.ui.preauth_timeout_seconds = 1;
    h.arm().await;
    h.runtimes
        .write()
        .await
        .get_mut(&1)
        .unwrap()
        .pre_auth_started_at = Some(0);
    journal::save(1, &h.cfg, &h.runtimes, &h.pool)
        .await
        .unwrap();
    *h.runtimes.write().await = crate::engine::initial_runtimes(&h.cfg);
    let writes = h.poll(vec![data(b"2"), ack()]).await;
    assert_eq!(writes, vec![azt::status(1), azt::reset(1)]);
    assert!(h.runtimes.read().await[&1].azt.stop_requested);
}

#[tokio::test]
async fn invalid_precision_and_pump_capacity_fail_before_writing_price_or_dose() {
    let mut h = Harness::new().await;
    for preset in [Preset::Amount(113005), Preset::Volume(1.234)] {
        assert!(h.command(preauthorize(preset), vec![]).await.is_empty());
        assert!(h.runtimes.read().await[&1].state.protocol_error.is_some());
    }
    let writes = h
        .command(
            preauthorize(Preset::Volume(990.0)),
            vec![data(b"0"), data(b"A")],
        )
        .await;
    assert_eq!(writes, vec![azt::status(1), azt::trk_type(1)]);
    assert!(h.runtimes.read().await[&1].current_tx.is_none());
}

#[tokio::test]
async fn restoring_journal_never_overwrites_stop_issued_during_storage_failure() {
    let mut h = Harness::new().await;
    h.arm().await;
    let saved: String = sqlx::query_scalar("SELECT payload_json FROM azt_recovery")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE azt_recovery SET payload_json = 'unreadable'")
        .execute(&h.pool)
        .await
        .unwrap();
    *h.runtimes.write().await = crate::engine::initial_runtimes(&h.cfg);
    assert_eq!(
        h.command(DispatchCommand::Stop { byte: 1 }, vec![Vec::new()])
            .await,
        vec![azt::reset(1)]
    );
    sqlx::query("UPDATE azt_recovery SET payload_json = ?")
        .bind(saved)
        .execute(&h.pool)
        .await
        .unwrap();
    let writes = h
        .poll(vec![data(b"3"), ack(), data(b"3"), data(b"000125")])
        .await;
    assert!(writes.contains(&azt::reset(1)));
    assert!(h.runtimes.read().await[&1].azt.stop_requested);
    assert!(h.runtimes.read().await[&1].current_tx.is_some());
}

#[tokio::test]
async fn unowned_authorization_is_stopped_with_paced_retries() {
    let mut h = Harness::new().await;
    let writes = h.poll(vec![data(b"2"), Vec::new()]).await;
    assert_eq!(writes, vec![azt::status(1), azt::reset(1)]);
    assert_eq!(h.poll(vec![data(b"2")]).await, vec![azt::status(1)]);
    h.poll(vec![data(b"40"), data(b"H"), full(0), ack(), totals()])
        .await;
    assert_eq!(h.count().await, 0);
    assert!(h.runtimes.read().await[&1].state.protocol_error.is_none());
}

#[tokio::test]
async fn recovered_status_clears_stale_status_warning() {
    let mut h = Harness::new().await;
    h.poll(vec![Vec::new()]).await;
    assert_eq!(
        h.runtimes.read().await[&1].state.protocol_error.as_deref(),
        Some(AZT_STATUS_UNAVAILABLE)
    );
    h.poll(vec![data(b"0")]).await;
    assert_eq!(h.runtimes.read().await[&1].state.status, FpStatus::Idle);
    assert!(h.runtimes.read().await[&1].state.protocol_error.is_none());
}

#[tokio::test]
async fn full_tank_uses_firmware_supported_mode_and_cost_limited_dose() {
    for (version, extended) in [
        (data(b"00000002"), true),
        (data(b"00000001"), false),
        (azt::encode_short_response(azt::NAK), false),
    ] {
        let mut h = Harness::new().await;
        let writes = h
            .command(
                preauthorize(Preset::Str("full".into())),
                vec![
                    data(b"0"),
                    data(b"A"),
                    version,
                    ack(),
                    ack(),
                    data(b"0000000000001130"),
                    number(41),
                    ack(),
                ],
            )
            .await;
        let dose = if extended {
            azt::set_dose_litres_full_tank(1, 88495)
        } else {
            azt::set_dose_litres(1, 88495)
        };
        assert!(writes.contains(&azt::protocol_version(1)));
        assert!(writes.contains(&dose));
        assert!(writes.contains(&azt::authorize(1)));
        assert!(h.runtimes.read().await[&1].last_preset.is_full());
    }
}
