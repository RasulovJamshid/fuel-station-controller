//! Replay frames from seriallog_20260914_101449 through the actual runtime.
use super::super::shared::FakeSerial;
use super::*;
use std::sync::Mutex;

fn hex(value: &str) -> Vec<u8> {
    value
        .split_whitespace()
        .map(|b| u8::from_str_radix(b, 16).unwrap())
        .collect()
}

struct Harness {
    cfg: SiteConfig,
    runtimes: Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    pool: SqlitePool,
    shifts: ShiftCoordinator,
    events: broadcast::Sender<WsEvent>,
}

impl Harness {
    async fn grouped() -> Self {
        let mut h = Self::new().await;
        h.cfg =
            serde_json::from_str(include_str!("../../../site.config.shelf-petrol.json")).unwrap();
        h.runtimes = Arc::new(RwLock::new(crate::engine::initial_runtimes(&h.cfg)));
        for rt in h.runtimes.write().await.values_mut() {
            rt.state.status = FpStatus::Idle;
        }
        h.shifts = ShiftCoordinator::new(h.pool.clone(), Arc::new(h.cfg.clone()));
        h
    }

    async fn poll_group(&self, byte: u8, index: u8, responses: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        let fake = Arc::new(Mutex::new(FakeSerial::new(responses)));
        let mut indices = wire_addresses(&self.cfg)
            .into_iter()
            .map(|a| (a, index))
            .collect();
        poll_side(
            byte,
            self.cfg.position_by_address(byte).unwrap(),
            &self.cfg,
            &SerialBackend::Fake(fake.clone()),
            &self.runtimes,
            &self.events,
            &self.pool,
            &self.shifts,
            &mut indices,
        )
        .await;
        let guard = fake.lock().unwrap();
        assert_eq!(guard.remaining(), 0);
        guard.written().to_vec()
    }

    async fn command(&self, command: DispatchCommand, responses: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        let fake = Arc::new(Mutex::new(FakeSerial::new(responses)));
        apply_command(
            &self.cfg,
            &SerialBackend::Fake(fake.clone()),
            &self.runtimes,
            &self.events,
            &mut HashMap::new(),
            command,
        )
        .await;
        let guard = fake.lock().unwrap();
        assert_eq!(guard.remaining(), 0);
        guard.written().to_vec()
    }

    async fn new() -> Self {
        let mut cfg: SiteConfig =
            serde_json::from_str(include_str!("../../../site.config.shelf.json")).unwrap();
        cfg.products[0].unit = "litre".into();
        let template = cfg.fueling_positions[0].clone();
        cfg.fueling_positions = (20..=22)
            .map(|address| {
                let mut fp = template.clone();
                fp.id = format!("SHELF-{address}");
                fp.address_byte = address;
                fp.nozzles[0].index = address - 19;
                fp.nozzles[0].price = 11600;
                fp
            })
            .collect();
        cfg.validate().unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let runtimes = Arc::new(RwLock::new(crate::engine::initial_runtimes(&cfg)));
        for rt in runtimes.write().await.values_mut() {
            rt.state.status = FpStatus::Idle;
        }
        let shifts = ShiftCoordinator::new(pool.clone(), Arc::new(cfg.clone()));
        Self {
            cfg,
            runtimes,
            pool,
            shifts,
            events: broadcast::channel(128).0,
        }
    }

    async fn reserve(&self, preset: Preset) {
        let fake = Arc::new(Mutex::new(FakeSerial::new([])));
        apply_command(
            &self.cfg,
            &SerialBackend::Fake(fake.clone()),
            &self.runtimes,
            &self.events,
            &mut HashMap::new(),
            DispatchCommand::Preauthorize {
                byte: 21,
                price: 11600,
                preset,
                nozzle_index: 2,
            },
        )
        .await;
        assert!(fake.lock().unwrap().written().is_empty());
    }

    async fn poll_raw(&self, address: u8, index: u8, responses: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        let fake = Arc::new(Mutex::new(FakeSerial::new(responses)));
        poll_position(
            address,
            self.cfg.position_by_address(address).unwrap(),
            &self.cfg,
            &SerialBackend::Fake(fake.clone()),
            &self.runtimes,
            &self.events,
            &self.pool,
            &self.shifts,
            &mut HashMap::from([(address, index)]),
        )
        .await;
        let guard = fake.lock().unwrap();
        assert_eq!(guard.remaining(), 0);
        guard.written().to_vec()
    }

    // Each fixture is a selected point in the capture, not consecutive polls;
    // start its exchange at that captured packet index. Additional exchanges
    // within the poll (e.g. totalizer after MAR) must advance normally.
    async fn poll(&self, frames: &[&str]) -> Vec<Vec<u8>> {
        let responses: Vec<_> = frames.iter().map(|s| hex(s)).collect();
        let address = responses[0][1];
        let index = responses[0][2];
        for frame in &responses {
            assert!(
                shelf_v22::decode_response(frame[1], frame[2], frame).is_some(),
                "invalid captured fixture"
            );
        }
        let fake = Arc::new(Mutex::new(FakeSerial::new(responses)));
        poll_position(
            address,
            self.cfg.position_by_address(address).unwrap(),
            &self.cfg,
            &SerialBackend::Fake(fake.clone()),
            &self.runtimes,
            &self.events,
            &self.pool,
            &self.shifts,
            &mut HashMap::from([(address, index)]),
        )
        .await;
        let guard = fake.lock().unwrap();
        assert_eq!(guard.remaining(), 0);
        let written = guard.written().to_vec();
        assert_eq!(
            written.len(),
            frames.len(),
            "unexpected extra commands/retries"
        );
        written
    }
}

#[tokio::test]
async fn captured_petrol_fill_updates_only_selected_gun_and_commits_final_totals() {
    let h = Harness::new().await;
    // The same nozzle bitmap appears at all three addresses.
    h.poll(&["2d 14 c0 09 81 05 21 ca 9f"]).await;
    h.poll(&["2d 15 c0 09 81 05 21 6a da"]).await;
    h.poll(&["2d 16 c0 09 81 05 21 8a 14"]).await;
    {
        let map = h.runtimes.read().await;
        assert_eq!(map[&20].state.status, FpStatus::Idle);
        assert_eq!(map[&21].state.status, FpStatus::NozzleUp);
        assert_eq!(map[&22].state.status, FpStatus::Idle);
    }

    // The old app retries the identical authorization with index CC.
    let fake = Arc::new(Mutex::new(FakeSerial::new([
        Vec::new(),
        hex("2d 15 cc 0e 84 05 81 01 15 00 00 00 c5 b2"),
    ])));
    h.reserve(Preset::Volume(10.0)).await;
    authorize(
        &h.cfg,
        &SerialBackend::Fake(fake.clone()),
        &h.runtimes,
        &h.events,
        &mut HashMap::from([(21, 0xCC)]),
        21,
        11600,
        Preset::Volume(10.0),
        Some(2),
    )
    .await;
    {
        let guard = fake.lock().unwrap();
        assert_eq!(guard.remaining(), 0);
        assert_eq!(
            guard.written(),
            &[
                hex("2d 15 cc 0e 05 00 00 e8 03 00 50 2d 8e b4"),
                hex("2d 15 cc 0e 05 00 00 e8 03 00 50 2d 8e b4")
            ]
        );
        let map = h.runtimes.read().await;
        assert_eq!(map[&21].state.status, FpStatus::Authorizing);
        assert_eq!(
            map[&21].state.pre_auth_preset.as_deref(),
            Some("10.00 litre")
        );
    }

    h.poll(&["2d 14 e6 16 85 05 8f 01 15 07 00 00 e8 03 00 74 27 00 f2 03 63 e8"])
        .await;
    h.poll(&["2d 15 e7 0e 84 05 8f 01 15 09 00 00 7e 6e"]).await;
    h.poll(&["2d 16 e6 16 85 05 8f 01 15 0a 00 00 e8 03 00 58 2f 00 bc 04 84 37"])
        .await;
    {
        let map = h.runtimes.read().await;
        assert_eq!(map[&21].state.status, FpStatus::Delivering);
        assert_eq!(map[&21].state.volume, 0.09);
        assert_eq!(map[&21].state.amount, 1044);
        for address in [20, 22] {
            assert_eq!(map[&address].state.status, FpStatus::Idle);
            assert_eq!(map[&address].state.volume, 0.0);
            assert_eq!(map[&address].state.amount, 0);
            assert!(map[&address].current_tx.is_none());
        }
    }

    h.poll(&["2d 15 16 0e 84 05 81 01 15 e8 03 00 7f 78"]).await;
    let written = h
        .poll(&[
            "2d 15 17 11 93 05 a1 e8 03 00 20 c5 01 50 2d b1 cf",
            "2d 15 18 0b a0 ad c1 01 00 d3 30",
        ])
        .await;
    assert_eq!(written[1], hex("2d 15 18 07 15 ed bf"));
    // Keep the completed reading while lifted; clear the lane on holstering.
    h.poll(&["2d 15 1a 09 81 05 21 26 ab"]).await;
    {
        let map = h.runtimes.read().await;
        assert_eq!(map[&21].state.status, FpStatus::Done);
        assert_eq!(map[&21].state.volume, 10.0);
        assert_eq!(map[&21].state.amount, 116000);
    }
    h.poll(&["2d 15 2f 09 81 00 20 4b 6b"]).await;
    let map = h.runtimes.read().await;
    assert_eq!(map[&21].state.status, FpStatus::Idle);
    assert_eq!(map[&21].state.volume, 0.0);
    assert_eq!(map[&21].state.amount, 0);
    assert_eq!(map[&21].state.nozzle_index, None);
    assert_eq!(map[&21].state.price, 11600);
    assert_eq!(map[&21].state.pump_total_volume, Some(1151.17));
    let rows: Vec<(String, f64, i64, i64)> =
        sqlx::query_as("SELECT fp_id, volume, amount, price FROM transactions")
            .fetch_all(&h.pool)
            .await
            .unwrap();
    assert_eq!(rows, vec![("SHELF-21".into(), 10.0, 116000, 11600)]);
}

#[tokio::test]
async fn neighboring_delivery_does_not_clear_pending_preauthorization() {
    let h = Harness::new().await;
    {
        let mut map = h.runtimes.write().await;
        let rt = map.get_mut(&20).unwrap();
        rt.state.status = FpStatus::PreAuthorized;
        rt.pre_auth = Some(PreAuthContext {
            nozzle_index: 1,
            product_id: 1,
        });
    }
    h.poll(&["2d 14 e6 16 85 05 8f 01 15 07 00 00 e8 03 00 74 27 00 f2 03 63 e8"])
        .await;
    let map = h.runtimes.read().await;
    assert_eq!(map[&20].state.status, FpStatus::PreAuthorized);
    assert!(map[&20].pre_auth.is_some());
    assert_eq!(map[&20].state.volume, 0.0);
}

#[tokio::test]
async fn gas_keeps_price_and_pressure_exchanges() {
    let mut h = Harness::new().await;
    h.cfg.products[0].unit = "m³".into();
    let fake = Arc::new(Mutex::new(FakeSerial::new([
        shelf_v22::build_request(21, 0, 0, &[]).unwrap(),
        shelf_v22::build_request(21, 1, 0x84, &[4, 0x81, 1, 21, 0, 0, 0]).unwrap(),
        shelf_v22::build_request(21, 2, 0x84, &[4, 0x8F, 1, 21, 10, 0, 0]).unwrap(),
        shelf_v22::build_request(21, 3, 0xA3, &[0, 0]).unwrap(),
    ])));
    let backend = SerialBackend::Fake(fake.clone());
    let mut indices = HashMap::new();
    h.reserve(Preset::Volume(10.0)).await;
    authorize(
        &h.cfg,
        &backend,
        &h.runtimes,
        &h.events,
        &mut indices,
        21,
        5000,
        Preset::Volume(10.0),
        Some(2),
    )
    .await;
    poll_position(
        21,
        h.cfg.position_by_address(21).unwrap(),
        &h.cfg,
        &backend,
        &h.runtimes,
        &h.events,
        &h.pool,
        &h.shifts,
        &mut indices,
    )
    .await;
    let guard = fake.lock().unwrap();
    assert_eq!(guard.remaining(), 0);
    assert_eq!(
        guard.written().iter().map(|f| f[4]).collect::<Vec<_>>(),
        vec![3, 5, 1, 0x19]
    );
}

#[tokio::test]
async fn liquid_money_preset_uses_priced_volume_and_preserves_money_metadata() {
    let h = Harness::new().await;
    let fake = Arc::new(Mutex::new(FakeSerial::new([shelf_v22::build_request(
        21,
        0,
        0x84,
        &[5, 0x81, 1, 21, 0, 0, 0],
    )
    .unwrap()])));
    h.reserve(Preset::Amount(30000)).await;
    authorize(
        &h.cfg,
        &SerialBackend::Fake(fake.clone()),
        &h.runtimes,
        &h.events,
        &mut HashMap::new(),
        21,
        11600,
        Preset::Amount(30000),
        Some(2),
    )
    .await;
    let guard = fake.lock().unwrap();
    assert_eq!(guard.written().len(), 1);
    assert_eq!(guard.written()[0], shelf_v22::write_volume(21, 0, 258, 11600).unwrap());
    drop(guard);
    h.poll_raw(21, 1, vec![
        reply(21, 1, 0x93, &[5, 0xA1, 2, 1, 0, 0xE8, 0x74, 0, 0x50, 0x2D]),
        reply(21, 2, 0xA0, &[2, 1, 0, 0]),
    ]).await;
    let sale: (String, f64, f64, i64) = sqlx::query_as(
        "SELECT preset_type, preset_value, volume, amount FROM transactions"
    ).fetch_one(&h.pool).await.unwrap();
    assert_eq!(sale, ("amount".into(), 30000.0, 2.58, 29928));
}

fn reply(address: u8, index: u8, command: u8, data: &[u8]) -> Vec<u8> {
    shelf_v22::build_request(address, index, command, data).unwrap()
}

#[tokio::test]
async fn rejected_start_does_not_recover_previous_sale_but_lost_ack_keeps_ownership() {
    for retry in [false, true] {
        let h = Harness::new().await;
        h.reserve(Preset::Amount(30000)).await;
        let mut replies = vec![];
        if retry { replies.push(vec![]); }
        replies.push(reply(21, 0, 0xFF, &[]));
        if retry { replies.push(reply(21, 1, 0x81, &[5, 0x21])); }
        let fake = Arc::new(Mutex::new(FakeSerial::new(replies)));
        authorize(&h.cfg, &SerialBackend::Fake(fake.clone()), &h.runtimes,
            &h.events, &mut HashMap::new(), 21, 11600, Preset::Amount(30000), Some(2)).await;
        assert_eq!(fake.lock().unwrap().remaining(), 0);
        if retry {
            assert!(h.runtimes.read().await[&21].current_tx.is_some());
            assert_eq!(h.runtimes.read().await[&21].state.status, FpStatus::Finalizing);
        } else {
            assert_eq!(fake.lock().unwrap().written().len(), 1);
            assert!(h.runtimes.read().await[&21].current_tx.is_none());
            // Idle with a lifted nozzle must not trigger 0x04 and reimport the last fill.
            let writes = h.poll_raw(21, 1, vec![reply(21, 1, 0x81, &[5, 0x21])]).await;
            assert_eq!(writes, vec![shelf_v22::status(21, 1)]);
            assert_eq!(h.runtimes.read().await[&21].state.status, FpStatus::NozzleUp);
            let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM transactions")
                .fetch_one(&h.pool).await.unwrap();
            assert_eq!(count.0, 0);
        }
    }
}

#[tokio::test]
async fn software_reservation_survives_idle_and_cancels_without_wire_commands() {
    let h = Harness::new().await;
    h.reserve(Preset::Volume(10.0)).await;
    for index in 0..3 {
        let writes = h
            .poll_raw(21, index, vec![reply(21, index, 0x81, &[0, 0x20])])
            .await;
        assert_eq!(writes, vec![shelf_v22::status(21, index)]);
        assert_eq!(
            h.runtimes.read().await[&21].state.status,
            FpStatus::PreAuthorized
        );
    }
    let fake = Arc::new(Mutex::new(FakeSerial::new([])));
    apply_command(
        &h.cfg,
        &SerialBackend::Fake(fake.clone()),
        &h.runtimes,
        &h.events,
        &mut HashMap::new(),
        DispatchCommand::CancelPreauth { byte: 21 },
    )
    .await;
    assert!(fake.lock().unwrap().written().is_empty());
    assert_eq!(h.runtimes.read().await[&21].state.status, FpStatus::Idle);
    let writes = h
        .poll_raw(21, 4, vec![reply(21, 4, 0x81, &[5, 0x21])])
        .await;
    assert_eq!(
        writes.len(),
        1,
        "a cancelled reservation must never start on a later lift"
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transactions")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    h.reserve(Preset::Volume(20.0)).await;
    assert_eq!(
        h.runtimes.read().await[&21]
            .state
            .pre_auth_preset
            .as_deref(),
        Some("20.00 litre")
    );
}

#[tokio::test]
async fn only_selected_nozzle_lift_sends_the_reserved_authorization() {
    let h = Harness::new().await;
    h.reserve(Preset::Volume(10.0)).await;
    let writes = h
        .poll_raw(21, 0, vec![reply(21, 0, 0x81, &[3, 0x21])])
        .await;
    assert_eq!(writes.len(), 1); // gun 1 is not the reserved gun 2
    let writes = h
        .poll_raw(
            21,
            1,
            vec![
                reply(21, 1, 0x81, &[5, 0x21]),
                reply(21, 2, 0x84, &[5, 0x81, 1, 21, 0, 0, 0]),
            ],
        )
        .await;
    assert_eq!(
        writes,
        vec![
            shelf_v22::status(21, 1),
            shelf_v22::write_volume(21, 2, 1000, 11600).unwrap()
        ]
    );
    let map = h.runtimes.read().await;
    assert_eq!(map[&21].state.status, FpStatus::Authorizing);
    assert!(map[&21].current_tx.is_some());
}

#[tokio::test]
async fn ingress_cancel_interlock_prevents_a_lift_start_before_command_dispatch() {
    let h = Harness::new().await;
    h.reserve(Preset::Volume(10.0)).await;
    assert!(h
        .runtimes
        .write()
        .await
        .get_mut(&21)
        .unwrap()
        .request_shelf_cancel());
    let writes = h
        .poll_raw(21, 0, vec![reply(21, 0, 0x81, &[5, 0x21])])
        .await;
    assert_eq!(writes.len(), 1);
    assert!(h.runtimes.read().await[&21].current_tx.is_none());
    let fake = Arc::new(Mutex::new(FakeSerial::new([])));
    request_cancel(
        21,
        &SerialBackend::Fake(fake.clone()),
        &h.runtimes,
        &h.events,
        &mut HashMap::new(),
    )
    .await;
    assert!(fake.lock().unwrap().written().is_empty());
    assert!(h.runtimes.read().await[&21].pre_auth.is_none());
}

#[tokio::test]
async fn expired_reservation_cancels_before_lift_or_even_with_no_serial_reply() {
    let mut h = Harness::new().await;
    h.cfg.ui.preauth_timeout_seconds = 1;
    h.reserve(Preset::Volume(10.0)).await;
    h.runtimes
        .write()
        .await
        .get_mut(&21)
        .unwrap()
        .pre_auth_started_at = Some(0);
    assert!(h.poll_raw(21, 0, vec![]).await.is_empty());
    assert_eq!(h.runtimes.read().await[&21].state.status, FpStatus::Idle);
    let writes = h
        .poll_raw(21, 0, vec![reply(21, 0, 0x81, &[5, 0x21])])
        .await;
    assert_eq!(writes.len(), 1);
}

#[tokio::test]
async fn lost_start_and_stop_replies_keep_the_sale_until_authoritative_final() {
    let h = Harness::new().await;
    h.reserve(Preset::Volume(10.0)).await;
    let mut responses = vec![reply(21, 0, 0x81, &[5, 0x21])];
    responses.extend(vec![Vec::new(); EXCHANGE_RETRIES * 2]);
    let writes = h.poll_raw(21, 0, responses).await;
    assert_eq!(
        writes.iter().filter(|f| f[4] == 5).count(),
        EXCHANGE_RETRIES
    );
    assert_eq!(
        writes.iter().filter(|f| f[4] == 0x0C).count(),
        EXCHANGE_RETRIES
    );
    let tx_id = {
        let map = h.runtimes.read().await;
        assert_eq!(map[&21].state.status, FpStatus::Finalizing);
        assert!(map[&21].shelf.start_attempted);
        map[&21].current_tx.as_ref().unwrap().id.clone()
    };
    h.runtimes
        .write()
        .await
        .get_mut(&21)
        .unwrap()
        .shelf
        .next_stop_attempt = Some(Instant::now() + Duration::from_secs(60));
    // Repeated cancellation, another authorize, or operator reset cannot lose it.
    let fake = Arc::new(Mutex::new(FakeSerial::new([])));
    for command in [
        DispatchCommand::CancelPreauth { byte: 21 },
        DispatchCommand::ResetLane { byte: 21 },
        DispatchCommand::ResetAll,
    ] {
        apply_command(
            &h.cfg,
            &SerialBackend::Fake(fake.clone()),
            &h.runtimes,
            &h.events,
            &mut HashMap::new(),
            command,
        )
        .await;
    }
    h.reserve(Preset::Volume(20.0)).await;
    assert_eq!(
        h.runtimes.read().await[&21].current_tx.as_ref().unwrap().id,
        tx_id
    );
    assert!(fake.lock().unwrap().written().is_empty());
    // A late live reply does not restore Delivering or send a second authorization.
    let writes = h
        .poll_raw(
            21,
            2,
            vec![reply(21, 2, 0x84, &[5, 0x8F, 1, 21, 100, 0, 0])],
        )
        .await;
    assert_eq!(writes.len(), 1);
    assert_eq!(
        h.runtimes.read().await[&21].state.status,
        FpStatus::Finalizing
    );
    // A stop ACK still cannot finalize the sale; the final response may carry more fuel.
    h.runtimes
        .write()
        .await
        .get_mut(&21)
        .unwrap()
        .shelf
        .next_stop_attempt = None;
    let fake = Arc::new(Mutex::new(FakeSerial::new([reply(21, 3, 0, &[])])));
    request_cancel(
        21,
        &SerialBackend::Fake(fake.clone()),
        &h.runtimes,
        &h.events,
        &mut HashMap::from([(21, 3)]),
    )
    .await;
    assert_eq!(
        h.runtimes.read().await[&21].state.status,
        FpStatus::Finalizing
    );
    h.poll_raw(
        21,
        4,
        vec![
            reply(
                21,
                4,
                0x93,
                &[0, 0xA0, 110, 0, 0, 0xD8, 0x31, 0, 0x50, 0x2D],
            ),
            reply(21, 5, 0xA0, &[110, 0, 0, 0]),
        ],
    )
    .await;
    let row: (String, f64, i64) = sqlx::query_as("SELECT id, volume, amount FROM transactions")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(row, (tx_id, 1.1, 12760));
    assert_eq!(h.runtimes.read().await[&21].state.status, FpStatus::Done);
}

#[tokio::test]
async fn terminal_stop_final_reply_is_retained_across_database_failure() {
    let h = Harness::new().await;
    h.reserve(Preset::Volume(10.0)).await;
    h.poll_raw(
        21,
        0,
        vec![
            reply(21, 0, 0x81, &[5, 0x21]),
            reply(21, 1, 0x84, &[5, 0x81, 1, 21, 0, 0, 0]),
        ],
    )
    .await;
    let fake = Arc::new(Mutex::new(FakeSerial::new([reply(
        21,
        2,
        0x93,
        &[0, 0xA0, 100, 0, 0, 0x50, 0x2D, 0, 0x50, 0x2D],
    )])));
    request_cancel(
        21,
        &SerialBackend::Fake(fake.clone()),
        &h.runtimes,
        &h.events,
        &mut HashMap::from([(21, 2)]),
    )
    .await;
    assert!(h.runtimes.read().await[&21].shelf.final_sale.is_some());
    sqlx::query("CREATE TRIGGER fail_sale BEFORE INSERT ON transactions BEGIN SELECT RAISE(FAIL, 'test failure'); END")
        .execute(&h.pool).await.unwrap();
    assert!(h.poll_raw(21, 3, vec![]).await.is_empty());
    assert_eq!(
        h.runtimes.read().await[&21].state.status,
        FpStatus::Finalizing
    );
    assert!(h.runtimes.read().await[&21].shelf.final_sale.is_some());
    sqlx::query("DROP TRIGGER fail_sale")
        .execute(&h.pool)
        .await
        .unwrap();
    let writes = h
        .poll_raw(21, 3, vec![reply(21, 3, 0xA0, &[100, 0, 0, 0])])
        .await;
    assert_eq!(writes[0][4], 0x15);
    assert_eq!(h.runtimes.read().await[&21].state.status, FpStatus::Done);
    // Duplicate final response does not record the same sale twice.
    h.poll_raw(
        21,
        4,
        vec![reply(
            21,
            4,
            0x93,
            &[0, 0xA0, 100, 0, 0, 0x50, 0x2D, 0, 0x50, 0x2D],
        )],
    )
    .await;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transactions")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn reservation_price_is_preserved_until_authorization_and_live_metering() {
    let h = Harness::new().await;
    h.reserve(Preset::Volume(10.0)).await;
    h.runtimes
        .write()
        .await
        .get_mut(&21)
        .unwrap()
        .set_nozzle_price(2, 17000);
    let writes = h
        .poll_raw(
            21,
            0,
            vec![
                reply(21, 0, 0x81, &[5, 0x21]),
                reply(21, 1, 0x84, &[5, 0x81, 1, 21, 0, 0, 0]),
            ],
        )
        .await;
    assert_eq!(
        writes[1],
        shelf_v22::write_volume(21, 1, 1000, 11600).unwrap()
    );
    h.poll_raw(
        21,
        2,
        vec![reply(21, 2, 0x84, &[5, 0x8F, 1, 21, 100, 0, 0])],
    )
    .await;
    let map = h.runtimes.read().await;
    assert_eq!(map[&21].state.price, 11600);
    assert_eq!(map[&21].state.amount, 11600);
}

#[test]
fn petrol_config_contains_all_captured_addresses_with_confirmed_fuels() {
    let cfg: SiteConfig =
        serde_json::from_str(include_str!("../../../site.config.shelf-petrol.json")).unwrap();
    cfg.validate().unwrap();
    assert_eq!(cfg.ui.default_auth_mode, "preauth");
    assert_eq!(cfg.shifts.mode, site_config::ShiftMode::Manual);
    assert_eq!(cfg.fueling_positions.len(), 6);
    assert_eq!(crate::engine::initial_runtimes(&cfg).len(), 6);
    assert_eq!(wire_addresses(&cfg).len(), 18);
    for base in [10, 15, 20, 25, 30, 35] {
        for (index, name, price) in [(1, "AI-95", 17000), (2, "AI-92", 11600), (3, "DT", 16000)] {
            let fp = cfg.position_by_address(base).unwrap();
            assert!(fp.active);
            assert_eq!(fp.nozzles.len(), 3);
            let nozzle = &fp.nozzles[(index - 1) as usize];
            assert_eq!(nozzle.shelf_address, base + index - 1);
            assert_eq!(nozzle.index, index);
            assert_eq!(nozzle.price, price);
            assert!(nozzle.active);
            let product = cfg.product(nozzle.product_id).unwrap();
            assert_eq!(product.name, name);
            assert_eq!(product.unit, "litre");
        }
    }
}

#[tokio::test]
async fn grouped_side_routes_lift_start_cancel_and_final_sale_to_third_gun() {
    let h = Harness::grouped().await;
    let writes = h
        .poll_group(
            20,
            0,
            vec![
                reply(20, 0, 0x81, &[9, 0x21]),
                reply(21, 0, 0x81, &[9, 0x21]),
                reply(22, 0, 0x81, &[9, 0x21]),
            ],
        )
        .await;
    assert_eq!(
        writes.iter().map(|f| f[1]).collect::<Vec<_>>(),
        vec![20, 21, 22]
    );
    {
        let map = h.runtimes.read().await;
        assert_eq!(map.len(), 6);
        assert_eq!(map[&20].state.nozzle_index, Some(3));
        assert_eq!(map[&20].state.product_name.as_deref(), Some("DT"));
        assert_eq!(map[&20].state.status, FpStatus::NozzleUp);
        assert_eq!(map[&25].state.status, FpStatus::Idle);
    }
    assert!(h
        .command(
            DispatchCommand::Authorize {
                byte: 20,
                price: 16000,
                preset: Preset::Volume(10.0),
            },
            vec![]
        )
        .await
        .is_empty());
    let writes = h
        .poll_group(
            20,
            1,
            vec![
                reply(22, 1, 0x81, &[9, 0x21]),
                reply(22, 2, 0x84, &[9, 0x81, 1, 22, 0, 0, 0]),
            ],
        )
        .await;
    assert_eq!(
        writes[1],
        shelf_v22::write_volume(22, 2, 1000, 16000).unwrap()
    );
    let writes = h
        .poll_group(
            20,
            3,
            vec![reply(22, 3, 0x84, &[9, 0x8F, 1, 22, 100, 0, 0])],
        )
        .await;
    assert_eq!(writes.len(), 1); // No idle sibling can overwrite the sale.
    assert_eq!(h.runtimes.read().await[&20].state.amount, 16000);
    let writes = h
        .command(
            DispatchCommand::Stop { byte: 20 },
            vec![reply(22, 0, 0x00, &[])],
        )
        .await;
    assert_eq!(writes, vec![shelf_v22::stop(22, 0)]);
    assert_eq!(
        h.runtimes.read().await[&20].state.status,
        FpStatus::Finalizing
    );
    h.poll_group(
        20,
        4,
        vec![
            reply(
                22,
                4,
                0x93,
                &[9, 0xA1, 100, 0, 0, 0x80, 0x3E, 0, 0x80, 0x3E],
            ),
            reply(22, 5, 0xA0, &[0x10, 0x27, 0, 0]),
        ],
    )
    .await;
    let sale: (String, i64, i64, i64) =
        sqlx::query_as("SELECT fp_id, nozzle_index, product_id, amount FROM transactions")
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(
        sale,
        (
            h.cfg.position_by_address(20).unwrap().id.clone(),
            3,
            3,
            16000
        )
    );
    assert_eq!(h.runtimes.read().await[&20].state.status, FpStatus::Done);
    h.poll_group(20, 6, vec![reply(22, 6, 0x81, &[9, 0x21])])
        .await;
    assert_eq!(h.runtimes.read().await[&20].state.status, FpStatus::Done);
    let writes = h
        .poll_group(20, 7, vec![reply(22, 7, 0x81, &[0, 0x20])])
        .await;
    assert_eq!(writes, vec![shelf_v22::status(22, 7)]);
    assert_eq!(h.runtimes.read().await[&20].state.status, FpStatus::Idle);
    assert_eq!(h.runtimes.read().await[&20].state.nozzle_index, None);
    let saved_amounts: Vec<(i64,)> = sqlx::query_as("SELECT amount FROM transactions")
        .fetch_all(&h.pool)
        .await
        .unwrap();
    assert_eq!(saved_amounts, vec![(16000,)]);
    h.poll_group(20, 0, vec![reply(20, 0, 0x81, &[3, 0x21])])
        .await;
    assert_eq!(h.runtimes.read().await[&20].state.nozzle_index, Some(1));
}

#[tokio::test]
async fn grouped_side_reservation_is_exclusive_and_cancel_before_lift_is_local() {
    let h = Harness::grouped().await;
    h.command(
        DispatchCommand::Preauthorize {
            byte: 20,
            price: 11600,
            preset: Preset::Volume(10.0),
            nozzle_index: 2,
        },
        vec![],
    )
    .await;
    h.command(
        DispatchCommand::Preauthorize {
            byte: 20,
            price: 16000,
            preset: Preset::Volume(20.0),
            nozzle_index: 3,
        },
        vec![],
    )
    .await;
    let writes = h
        .poll_group(20, 0, vec![reply(21, 0, 0x81, &[3, 0x21])])
        .await;
    assert_eq!(writes, vec![shelf_v22::status(21, 0)]);
    {
        let mut map = h.runtimes.write().await;
        let rt = map.get_mut(&20).unwrap();
        assert_eq!(rt.state.nozzle_index, Some(2));
        assert_eq!(rt.state.status, FpStatus::PreAuthorized);
        assert!(rt.request_shelf_cancel());
    }
    // Even a lift arriving before the queued Cancel is consumed cannot start it.
    let writes = h
        .poll_group(20, 1, vec![reply(21, 1, 0x81, &[5, 0x21])])
        .await;
    assert_eq!(writes, vec![shelf_v22::status(21, 1)]);
    assert!(h
        .command(DispatchCommand::CancelPreauth { byte: 20 }, vec![])
        .await
        .is_empty());
    assert_eq!(h.runtimes.read().await[&20].state.status, FpStatus::Idle);
    h.command(
        DispatchCommand::Preauthorize {
            byte: 20,
            price: 17000,
            preset: Preset::Volume(5.0),
            nozzle_index: 1,
        },
        vec![],
    )
    .await;
    assert_eq!(h.runtimes.read().await[&20].state.nozzle_index, Some(1));
}

#[tokio::test]
async fn grouped_side_prices_and_totals_use_each_guns_address() {
    let h = Harness::grouped().await;
    let writes = h
        .command(
            DispatchCommand::UpdatePrices {
                updates: vec![types::UpdatePriceCmd {
                    fp_id: h.cfg.position_by_address(20).unwrap().id.clone(),
                    nozzle_index: 2,
                    price: 11700,
                }],
                changed_by: "test".into(),
            },
            vec![reply(21, 0, 0x00, &[])],
        )
        .await;
    assert_eq!(writes, vec![shelf_v22::write_price(21, 0, 11700).unwrap()]);
    let replies = wire_addresses(&h.cfg)
        .into_iter()
        .map(|address| reply(address, 0, 0xA0, &[address, 0, 0, 0]))
        .collect();
    let writes = h.command(DispatchCommand::RefreshTotals, replies).await;
    assert_eq!(writes.len(), 18);
    let map = h.runtimes.read().await;
    for fp in h.cfg.active_positions() {
        let rt = &map[&fp.address_byte];
        assert_eq!(rt.state.pump_totals.len(), 3);
        for total in &rt.state.pump_totals {
            assert_eq!(
                total.volume,
                (fp.address_byte + total.nozzle_index - 1) as f64 / 100.0
            );
        }
    }
    assert_eq!(map[&20].nozzle_prices[&2], 11700);
    assert_eq!(map[&20].nozzle_prices[&1], 17000);
}

#[tokio::test]
async fn grouped_side_pins_recovered_final_sale_during_database_retry() {
    let h = Harness::grouped().await;
    sqlx::query("CREATE TRIGGER fail_sale BEFORE INSERT ON transactions BEGIN SELECT RAISE(FAIL, 'test failure'); END")
        .execute(&h.pool).await.unwrap();
    let writes = h
        .poll_group(
            20,
            0,
            vec![
                reply(20, 0, 0x81, &[0, 0x20]),
                reply(
                    21,
                    0,
                    0x93,
                    &[0, 0xA0, 100, 0, 0, 0x50, 0x2D, 0, 0x50, 0x2D],
                ),
            ],
        )
        .await;
    assert_eq!(writes.len(), 2); // Do not proceed to gun 3 with gun 2's cached final.
    assert_eq!(
        h.runtimes.read().await[&20].state.status,
        FpStatus::Finalizing
    );
    h.command(DispatchCommand::ResetLane { byte: 20 }, vec![])
        .await;
    assert_eq!(h.runtimes.read().await[&20].state.nozzle_index, Some(2));
    sqlx::query("DROP TRIGGER fail_sale")
        .execute(&h.pool)
        .await
        .unwrap();
    let writes = h
        .poll_group(20, 1, vec![reply(21, 1, 0xA0, &[100, 0, 0, 0])])
        .await;
    assert_eq!(writes, vec![shelf_v22::total_counters(21, 1)]);
    let rows: Vec<(i64, i64)> = sqlx::query_as("SELECT nozzle_index, product_id FROM transactions")
        .fetch_all(&h.pool)
        .await
        .unwrap();
    assert_eq!(rows, vec![(2, 2)]);
}

#[tokio::test]
async fn startup_totals_populate_every_nozzle_before_any_sale() {
    let h = Harness::grouped().await;
    let mut pending: HashMap<_, _> = wire_addresses(&h.cfg)
        .into_iter()
        .map(|a| (a, Instant::now()))
        .collect();
    let mut indices = HashMap::new();
    let mut replies = Vec::new();
    for offset in 0..3 {
        for base in h.cfg.active_addresses() {
            replies.push(reply(base + offset, 0, 0xA0, &[100 + offset, 0, 0, 0]));
        }
    }
    let fake = Arc::new(Mutex::new(FakeSerial::new(replies)));
    let mut events = h.events.subscribe();
    for _ in 0..3 {
        for fp in h.cfg.active_positions() {
            refresh_pending_totalizer(
                fp,
                &SerialBackend::Fake(fake.clone()),
                &h.runtimes,
                &h.events,
                &mut indices,
                &mut pending,
            )
            .await;
        }
    }
    assert!(pending.is_empty());
    assert_eq!(fake.lock().unwrap().remaining(), 0);
    assert_eq!(fake.lock().unwrap().written().len(), 18);
    assert!(events.try_recv().is_ok());
    for rt in h.runtimes.read().await.values() {
        assert_eq!(rt.state.status, FpStatus::Idle);
        assert_eq!(rt.state.pump_totals.len(), 3);
        assert!(rt.current_tx.is_none());
    }
}

#[tokio::test]
async fn startup_totals_defer_reserved_sides_and_retry_failed_reads() {
    let h = Harness::grouped().await;
    let fp = h.cfg.position_by_address(20).unwrap();
    let mut pending = HashMap::from([(21, Instant::now())]);
    let mut indices = HashMap::new();
    let fake = Arc::new(Mutex::new(FakeSerial::new([reply(21, 0, 0xFF, &[])])));
    let backend = SerialBackend::Fake(fake.clone());
    h.command(
        DispatchCommand::Preauthorize {
            byte: 20,
            price: 11600,
            preset: Preset::Volume(2.0),
            nozzle_index: 2,
        },
        vec![],
    )
    .await;
    refresh_pending_totalizer(
        fp,
        &backend,
        &h.runtimes,
        &h.events,
        &mut indices,
        &mut pending,
    )
    .await;
    assert!(fake.lock().unwrap().written().is_empty());
    h.command(DispatchCommand::CancelPreauth { byte: 20 }, vec![])
        .await;
    refresh_pending_totalizer(
        fp,
        &backend,
        &h.runtimes,
        &h.events,
        &mut indices,
        &mut pending,
    )
    .await;
    assert!(pending.contains_key(&21));
    assert_eq!(fake.lock().unwrap().written().len(), 1);
    refresh_pending_totalizer(
        fp,
        &backend,
        &h.runtimes,
        &h.events,
        &mut indices,
        &mut pending,
    )
    .await;
    assert_eq!(fake.lock().unwrap().written().len(), 1); // Backoff, no immediate retry.
    pending.insert(21, Instant::now());
    let fake = Arc::new(Mutex::new(FakeSerial::new([reply(
        21,
        1,
        0xA0,
        &[100, 0, 0, 0],
    )])));
    refresh_pending_totalizer(
        fp,
        &SerialBackend::Fake(fake.clone()),
        &h.runtimes,
        &h.events,
        &mut indices,
        &mut pending,
    )
    .await;
    assert!(pending.is_empty());
    assert_eq!(
        h.runtimes.read().await[&20].state.pump_totals[0].nozzle_index,
        2
    );
}
