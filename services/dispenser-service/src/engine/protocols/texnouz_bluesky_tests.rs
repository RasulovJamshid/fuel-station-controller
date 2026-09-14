//! Replay physical sale sequences through the actual BlueSky poll/command paths.
use super::super::shared::FakeSerial;
use super::*;
use std::sync::Mutex;

fn reply(hose: u8, cmd: u8, data: &[u8]) -> Vec<u8> {
    texnouz_bluesky::build_request(hose, cmd, data).unwrap()
}
fn status(value: u8) -> Vec<u8> {
    reply(1, 0xD5, &[value])
}
fn fill(volume: u64, amount: u64) -> Vec<u8> {
    let mut data = texnouz_bluesky::encode_bcd(volume, 4).unwrap();
    data.extend(texnouz_bluesky::encode_bcd(amount, 4).unwrap());
    reply(1, 0xD9, &data)
}
fn final_replies(state: u8, volume: u64, amount: u64, commit: bool) -> Vec<Vec<u8>> {
    let mut replies = vec![status(state), fill(volume, amount), status(state)];
    if commit {
        replies.push(reply(
            1,
            0xB6,
            &texnouz_bluesky::encode_bcd(11300, 3).unwrap(),
        ));
        replies.push(reply(1, 0xC5, &[0; 12]));
    }
    replies
}

struct Harness {
    cfg: SiteConfig,
    runtimes: Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    pool: SqlitePool,
    shifts: ShiftCoordinator,
    events: broadcast::Sender<WsEvent>,
}

impl Harness {
    async fn new() -> Self {
        let mut cfg: SiteConfig =
            serde_json::from_str(include_str!("../../../site.config.texnouz-bluesky.json"))
                .unwrap();
        cfg.fueling_positions.truncate(1);
        cfg.fueling_positions[0].nozzles.truncate(1);
        cfg.fueling_positions[0].address_byte = 1;
        cfg.fueling_positions[0].nozzles[0].bluesky_hose_number = 1;
        cfg.shifts.mode = site_config::ShiftMode::Manual;
        cfg.shifts.require_operator_pin = false;
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let runtimes = Arc::new(RwLock::new(crate::engine::initial_runtimes(&cfg)));
        runtimes.write().await.get_mut(&1).unwrap().state.status = FpStatus::NozzleUp;
        let shifts = ShiftCoordinator::new(pool.clone(), Arc::new(cfg.clone()));
        shifts
            .start(types::StartShiftCmd {
                operator_name: "Test operator".into(),
                operator_id: None,
                pin: None,
                notes: None,
                started_at_override: None,
            })
            .await
            .unwrap();
        Self {
            cfg,
            runtimes,
            pool,
            shifts,
            events: broadcast::channel(64).0,
        }
    }

    async fn authorize(&self, preset: Preset) -> String {
        let fake = Arc::new(Mutex::new(FakeSerial::new([
            status(0x08),
            reply(1, 0xE5, &[]),
            reply(1, 0xB2, &[0x59]),
            reply(
                1,
                if matches!(preset, Preset::Amount(_)) {
                    0xB5
                } else {
                    0xB9
                },
                &[],
            ),
            status(0x08),
            reply(1, 0xC3, &[0x59]),
        ])));
        do_authorize(
            &self.cfg,
            &self.runtimes,
            &self.events,
            &SerialBackend::Fake(fake.clone()),
            &mut HashMap::from([(1, 1)]),
            1,
            11300,
            preset,
            Some(1),
        )
        .await;
        assert_eq!(fake.lock().unwrap().remaining(), 0);
        let map = self.runtimes.read().await;
        let rt = map.get(&1).unwrap();
        assert_eq!(rt.state.status, FpStatus::Authorizing);
        rt.current_tx.as_ref().unwrap().id.clone()
    }

    async fn arm(&self, preset: Preset) {
        self.runtimes
            .write()
            .await
            .get_mut(&1)
            .unwrap()
            .state
            .status = FpStatus::Idle;
        self.command(
            DispatchCommand::Preauthorize {
                byte: 1,
                price: 11300,
                preset,
                nozzle_index: 1,
            },
            vec![status(0x88)],
        )
        .await;
        assert_eq!(
            self.runtimes.read().await[&1].state.status,
            FpStatus::PreAuthorized
        );
    }

    async fn poll(&self, responses: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        let fake = Arc::new(Mutex::new(FakeSerial::new(responses)));
        poll_position(
            1,
            &self.cfg,
            &SerialBackend::Fake(fake.clone()),
            &self.runtimes,
            &active_positions_by_byte(&self.cfg),
            &self.events,
            &self.pool,
            &self.shifts,
            &mut HashMap::new(),
            &mut HashMap::from([(1, 1)]),
        )
        .await;
        let fake = fake.lock().unwrap();
        assert_eq!(fake.remaining(), 0, "unexpected unconsumed pump responses");
        fake.written().to_vec()
    }

    async fn command(&self, cmd: DispatchCommand, replies: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        let fake = Arc::new(Mutex::new(FakeSerial::new(replies)));
        apply_command(
            &self.cfg,
            &self.runtimes,
            &self.events,
            &SerialBackend::Fake(fake.clone()),
            &mut HashMap::from([(1, 1)]),
            cmd,
        )
        .await;
        let fake = fake.lock().unwrap();
        assert_eq!(fake.remaining(), 0);
        fake.written().to_vec()
    }

    async fn settle(&self) {
        // Advance only the confirmation timestamp: tests never sleep or alter fuel values.
        if let Some((_, since)) = self
            .runtimes
            .write()
            .await
            .get_mut(&1)
            .unwrap()
            .bluesky
            .finish_candidate
            .as_mut()
        {
            *since -= 1000;
        }
    }

    async fn sales(&self) -> Vec<(String, f64, i64, String)> {
        sqlx::query_as("SELECT id, volume, amount, status FROM transactions ORDER BY started_at")
            .fetch_all(&self.pool)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn delayed_zero_and_small_startup_samples_produce_one_sale() {
    let h = Harness::new().await;
    let id = h.authorize(Preset::Volume(10.0)).await;
    // No second Auth: the pump accepts Start, waits, briefly reports a tiny
    // reading, then dispenses the originally entered quantity.
    for volume in [0, 3, 0, 3] {
        h.poll(final_replies(0x08, volume, volume * 113, false))
            .await;
        h.settle().await;
        assert!(h.sales().await.is_empty());
        assert_eq!(
            h.runtimes.read().await[&1].current_tx.as_ref().unwrap().id,
            id
        );
    }
    h.poll(vec![status(0x28), fill(3, 339)]).await;
    h.poll(final_replies(0x08, 3, 339, false)).await;
    h.settle().await;
    h.poll(final_replies(0x08, 3, 339, false)).await;
    assert!(
        h.sales().await.is_empty(),
        "tiny startup flow is not a completed preset"
    );
    h.poll(vec![status(0x28), fill(1000, 113000)]).await;
    h.poll(final_replies(0x08, 1000, 113000, false)).await;
    assert!(
        h.sales().await.is_empty(),
        "one idle status does not commit"
    );
    h.settle().await;
    h.poll(final_replies(0x08, 1000, 113000, true)).await;
    assert_eq!(
        h.sales().await,
        vec![(id, 10.0, 113000, "COMPLETED".into())]
    );
    let shift = h.shifts.current().await.unwrap();
    assert_eq!(shift.total_transactions, 1);
    assert_eq!(shift.total_volume, 10.0);
    assert_eq!(shift.total_amount, 113000);
}

#[tokio::test]
async fn finished_sale_rejects_auth_reset_and_late_busy_until_holster() {
    let h = Harness::new().await;
    let id = h.authorize(Preset::Amount(113000)).await;
    h.poll(vec![status(0x28), fill(1000, 113000)]).await;
    h.poll(final_replies(0x08, 1000, 113000, false)).await;
    h.settle().await;
    h.poll(final_replies(0x08, 1000, 113000, true)).await;
    assert!(h
        .command(DispatchCommand::ResetLane { byte: 1 }, vec![])
        .await
        .is_empty());
    assert!(h
        .command(DispatchCommand::ResetAll, vec![])
        .await
        .is_empty());
    assert!(h
        .command(
            DispatchCommand::Authorize {
                byte: 1,
                price: 11300,
                preset: Preset::Volume(10.0)
            },
            vec![]
        )
        .await
        .is_empty());
    h.poll(vec![status(0x28)]).await; // never re-adopt the completed hose as a new sale
    h.poll(vec![status(0x08)]).await;
    assert_eq!(h.sales().await.len(), 1);
    assert_eq!(h.sales().await[0].0, id);
    h.poll(vec![status(0x88)]).await;
    assert_eq!(h.runtimes.read().await[&1].state.status, FpStatus::Idle);
    let next_id = h.authorize(Preset::Volume(5.0)).await;
    assert_ne!(next_id, id);
}

#[tokio::test]
async fn queued_auth_and_cancel_cannot_replace_a_started_transaction() {
    let h = Harness::new().await;
    let id = h.authorize(Preset::Volume(10.0)).await;
    for cmd in [
        DispatchCommand::Authorize {
            byte: 1,
            price: 11300,
            preset: Preset::Volume(20.0),
        },
        DispatchCommand::Preauthorize {
            byte: 1,
            price: 11300,
            preset: Preset::Volume(20.0),
            nozzle_index: 1,
        },
        DispatchCommand::ResetLane { byte: 1 },
    ] {
        assert!(h.command(cmd, vec![]).await.is_empty());
    }
    h.command(DispatchCommand::CancelPreauth { byte: 1 }, vec![])
        .await; // Stop ACK lost
    assert_eq!(
        h.runtimes.read().await[&1].current_tx.as_ref().unwrap().id,
        id
    );
    h.poll(final_replies(0x08, 0, 0, false)).await;
    assert!(
        h.sales().await.is_empty(),
        "unacknowledged Stop must not close pending Start"
    );
    h.poll(vec![status(0x28), fill(3, 339), reply(1, 0xCA, &[])])
        .await;
    h.poll(final_replies(0x08, 3, 339, false)).await;
    h.settle().await;
    h.poll(final_replies(0x08, 3, 339, true)).await;
    assert_eq!(h.sales().await, vec![(id, 0.03, 339, "COMPLETED".into())]);
}

#[tokio::test]
async fn actual_tiny_fill_and_zero_cancellation_are_saved_on_holster() {
    for (volume, expected) in [(3, "COMPLETED"), (0, "ABORTED")] {
        let h = Harness::new().await;
        let id = h.authorize(Preset::Str("full".into())).await;
        if volume > 0 {
            h.poll(vec![status(0x28), fill(volume, volume * 113)]).await;
        }
        h.poll(final_replies(0x88, volume, volume * 113, false))
            .await;
        h.settle().await;
        h.poll(final_replies(0x88, volume, volume * 113, true))
            .await;
        assert_eq!(
            h.sales().await,
            vec![(
                id,
                volume as f64 / 100.0,
                (volume * 113) as i64,
                expected.into()
            )]
        );
    }
}

#[tokio::test]
async fn active_hose_missing_or_other_hose_busy_cannot_close_or_switch_sale() {
    let mut h = Harness::new().await;
    let id = h.authorize(Preset::Volume(10.0)).await;
    let mut other = h.cfg.fueling_positions[0].nozzles[0].clone();
    other.index = 2;
    other.bluesky_hose_number = 2;
    h.cfg.fueling_positions[0].nozzles.push(other);
    let written = h.poll(vec![vec![], reply(2, 0xD5, &[0x88])]).await;
    assert_eq!(
        written,
        vec![
            texnouz_bluesky::read_status(1),
            texnouz_bluesky::read_status(2)
        ]
    );
    h.poll(vec![
        status(0x08),
        reply(2, 0xD5, &[0x28]),
        fill(0, 0),
        status(0x08),
    ])
    .await;
    let map = h.runtimes.read().await;
    assert_eq!(map[&1].current_tx.as_ref().unwrap().id, id);
    assert_eq!(map[&1].current_tx.as_ref().unwrap().nozzle_index, 1);
    assert!(h.sales().await.is_empty());
}

#[tokio::test]
async fn unstable_missing_or_backwards_final_readings_do_not_commit() {
    let h = Harness::new().await;
    h.authorize(Preset::Volume(10.0)).await;
    h.poll(vec![status(0x28), fill(1000, 113000)]).await;
    h.poll(final_replies(0x08, 1000, 113000, false)).await;
    h.settle().await;
    h.poll(vec![status(0x08), fill(1000, 113000), status(0x28)])
        .await;
    assert!(h.runtimes.read().await[&1]
        .bluesky
        .finish_candidate
        .is_none());
    h.poll(final_replies(0x88, 1, 113, false)).await;
    assert!(h.runtimes.read().await[&1]
        .bluesky
        .finish_candidate
        .is_none());
    h.poll(final_replies(0x88, 1000, 113000, false)).await;
    h.settle().await;
    h.poll(vec![status(0x88), vec![], vec![]]).await;
    assert!(h.runtimes.read().await[&1]
        .bluesky
        .finish_candidate
        .is_none());
    assert!(h.sales().await.is_empty());
}

#[tokio::test]
async fn failed_database_commit_retries_same_id_without_done() {
    let h = Harness::new().await;
    let id = h.authorize(Preset::Volume(10.0)).await;
    h.poll(vec![status(0x28), fill(1000, 113000)]).await;
    h.poll(final_replies(0x08, 1000, 113000, false)).await;
    h.settle().await;
    sqlx::query("CREATE TRIGGER fail_sale BEFORE INSERT ON transactions BEGIN SELECT RAISE(FAIL, 'test write failure'); END").execute(&h.pool).await.unwrap();
    let mut replies = final_replies(0x08, 1000, 113000, true);
    replies.pop(); // Failed commit must not proceed to totalizer refresh.
    let mut events = h.events.subscribe();
    h.poll(replies).await;
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(event, WsEvent::Done(_)));
    }
    assert_eq!(
        h.runtimes.read().await[&1].current_tx.as_ref().unwrap().id,
        id
    );
    sqlx::query("DROP TRIGGER fail_sale")
        .execute(&h.pool)
        .await
        .unwrap();
    h.poll(final_replies(0x08, 1000, 113000, true)).await;
    assert_eq!(h.sales().await.len(), 1);
    assert_eq!(h.sales().await[0].0, id);
}

#[tokio::test]
async fn holstered_reservation_only_polls_then_programs_on_lift() {
    for preset in [
        Preset::Volume(10.0),
        Preset::Amount(300000),
        Preset::Str("full".into()),
    ] {
        let h = Harness::new().await;
        let sent = h
            .command(
                DispatchCommand::Preauthorize {
                    byte: 1,
                    price: 11300,
                    preset: preset.clone(),
                    nozzle_index: 1,
                },
                vec![status(0x80)],
            )
            .await;
        assert_eq!(sent, vec![texnouz_bluesky::read_status(1)]);
        for _ in 0..5 {
            assert_eq!(
                h.poll(vec![status(0x80)]).await,
                vec![texnouz_bluesky::read_status(1)]
            );
        }
        assert!(h.runtimes.read().await[&1].current_tx.is_none());
        let dose = dose_frame(1, &preset, 11300).unwrap();
        let dose_cmd = dose[dose.len() - 2];
        let sent = h
            .poll(vec![
                status(0x00),
                reply(1, 0xE5, &[]),
                reply(1, 0xB2, &[0x59]),
                reply(1, dose_cmd, &[]),
                status(0x00),
                reply(1, 0xC3, &[0x59]),
            ])
            .await;
        assert_eq!(
            sent,
            vec![
                texnouz_bluesky::read_status(1),
                texnouz_bluesky::take_control(1),
                texnouz_bluesky::write_price(1, 11300).unwrap(),
                dose,
                texnouz_bluesky::read_status(1),
                texnouz_bluesky::start(1)
            ]
        );
        assert_eq!(
            h.runtimes.read().await[&1].state.status,
            FpStatus::Authorizing
        );
        h.poll(final_replies(0x00, 0, 0, false)).await;
        h.settle().await;
        h.poll(final_replies(0x00, 0, 0, false)).await;
        assert!(h.sales().await.is_empty());
    }
}

#[tokio::test]
async fn reservation_cancel_is_local_even_without_replies_and_never_starts_later() {
    for stop in [false, true] {
        let h = Harness::new().await;
        h.arm(Preset::Amount(300000)).await;
        h.poll(vec![]).await;
        let mut events = h.events.subscribe();
        let cmd = if stop {
            DispatchCommand::Stop { byte: 1 }
        } else {
            DispatchCommand::CancelPreauth { byte: 1 }
        };
        assert!(h.command(cmd, vec![]).await.is_empty());
        assert!(h
            .command(DispatchCommand::CancelPreauth { byte: 1 }, vec![])
            .await
            .is_empty());
        let rt = h.runtimes.read().await;
        assert!(rt[&1].pre_auth.is_none());
        assert!(rt[&1].pre_auth_started_at.is_none());
        assert!(rt[&1].bluesky.completed_nozzle.is_none());
        assert_eq!(rt[&1].state.status, FpStatus::Idle);
        assert!(rt[&1].snapshot_state().pre_auth_cancel_wait.is_none());
        drop(rt);
        let mut cancelled = 0;
        while let Ok(event) = events.try_recv() {
            if matches!(event, WsEvent::PreAuthCancelled { .. }) {
                cancelled += 1;
            }
            assert!(!matches!(event, WsEvent::Done(_)));
        }
        assert_eq!(cancelled, 1);
        assert_eq!(
            h.poll(vec![status(0x00)]).await,
            vec![texnouz_bluesky::read_status(1)]
        );
        assert!(h.runtimes.read().await[&1].current_tx.is_none());
        assert!(h.sales().await.is_empty());
        let id = h.authorize(Preset::Volume(5.0)).await;
        h.poll(vec![status(0x28), fill(500, 56500)]).await;
        h.poll(final_replies(0x88, 500, 56500, false)).await;
        h.settle().await;
        h.poll(final_replies(0x88, 500, 56500, true)).await;
        assert_eq!(h.sales().await, vec![(id, 5.0, 56500, "COMPLETED".into())]);
    }
}

#[tokio::test]
async fn reservation_timeout_cancels_once_before_lift_or_even_without_status() {
    for response in [vec![], vec![status(0x00)]] {
        let mut h = Harness::new().await;
        h.cfg.ui.preauth_timeout_seconds = 120;
        h.arm(Preset::Volume(10.0)).await;
        h.runtimes
            .write()
            .await
            .get_mut(&1)
            .unwrap()
            .pre_auth_started_at = Some(Utc::now().timestamp_millis() - 121000);
        let mut events = h.events.subscribe();
        assert_eq!(
            h.poll(response).await,
            vec![texnouz_bluesky::read_status(1)]
        );
        assert!(h.runtimes.read().await[&1].pre_auth.is_none());
        assert!(h.runtimes.read().await[&1].current_tx.is_none());
        h.poll(vec![status(0x00)]).await;
        let mut timeouts = 0;
        while let Ok(event) = events.try_recv() {
            if matches!(event, WsEvent::PreAuthTimeout { .. }) {
                timeouts += 1;
            }
        }
        assert_eq!(timeouts, 1);
        assert!(h.sales().await.is_empty());
    }
}

#[tokio::test]
async fn another_hose_lift_cannot_start_the_reservation() {
    let mut h = Harness::new().await;
    h.arm(Preset::Volume(10.0)).await;
    let mut other = h.cfg.fueling_positions[0].nozzles[0].clone();
    other.index = 2;
    other.bluesky_hose_number = 2;
    h.cfg.fueling_positions[0].nozzles.push(other);
    for own in [status(0x80), vec![]] {
        assert_eq!(
            h.poll(vec![own, reply(2, 0xD5, &[0x00])]).await,
            vec![
                texnouz_bluesky::read_status(1),
                texnouz_bluesky::read_status(2)
            ]
        );
        assert!(h.runtimes.read().await[&1].current_tx.is_none());
        assert!(h.runtimes.read().await[&1].pre_auth.is_some());
    }
    assert!(h
        .command(DispatchCommand::CancelPreauth { byte: 1 }, vec![])
        .await
        .is_empty());
}

#[tokio::test]
async fn failed_setup_or_reholster_does_not_start_or_retry_a_cancelled_reservation() {
    for responses in [
        vec![status(0x00), reply(1, 0xE5, &[])], // Price replies lost.
        vec![status(0x00), reply(1, 0xE5, &[]), reply(1, 0xB2, &[0x59])], // Dose replies lost.
        vec![
            status(0x00),
            reply(1, 0xE5, &[]),
            reply(1, 0xB2, &[0x59]),
            reply(1, 0xB9, &[]),
            status(0x80),
        ],
    ] {
        let h = Harness::new().await;
        h.arm(Preset::Volume(10.0)).await;
        let sent = h.poll(responses).await;
        assert!(!sent.contains(&texnouz_bluesky::start(1)));
        assert!(h.runtimes.read().await[&1].pre_auth.is_none());
        assert!(h.runtimes.read().await[&1].current_tx.is_none());
        assert_eq!(
            h.poll(vec![status(0x00)]).await,
            vec![texnouz_bluesky::read_status(1)]
        );
        assert!(h.sales().await.is_empty());
    }
}

#[tokio::test]
async fn lost_start_reply_cannot_be_cancelled_as_an_unstarted_order() {
    for start_on_lift in [true, false] {
        let h = Harness::new().await;
        if start_on_lift {
            h.arm(Preset::Volume(10.0)).await;
            h.poll(vec![
                status(0x08),
                reply(1, 0xE5, &[]),
                reply(1, 0xB2, &[0x59]),
                reply(1, 0xB9, &[]),
                status(0x08),
            ])
            .await; // Both C3 replies lost.
        } else {
            h.command(
                DispatchCommand::Authorize {
                    byte: 1,
                    price: 11300,
                    preset: Preset::Volume(10.0),
                },
                vec![
                    status(0x08),
                    reply(1, 0xE5, &[]),
                    reply(1, 0xB2, &[0x59]),
                    reply(1, 0xB9, &[]),
                    status(0x08),
                ],
            )
            .await;
        }
        let id = h.runtimes.read().await[&1]
            .current_tx
            .as_ref()
            .unwrap()
            .id
            .clone();
        let mut events = h.events.subscribe();
        assert_eq!(
            h.command(
                DispatchCommand::CancelPreauth { byte: 1 },
                vec![reply(1, 0xCA, &[])]
            )
            .await,
            vec![texnouz_bluesky::stop(1)]
        );
        while let Ok(event) = events.try_recv() {
            assert!(!matches!(event, WsEvent::PreAuthCancelled { .. }));
        }
        h.poll(final_replies(0x88, 3, 339, false)).await;
        h.settle().await;
        h.poll(final_replies(0x88, 3, 339, true)).await;
        assert_eq!(h.sales().await, vec![(id, 0.03, 339, "COMPLETED".into())]);
    }
}

#[tokio::test]
async fn unexpected_flow_during_reservation_is_stopped_and_saved() {
    let h = Harness::new().await;
    h.arm(Preset::Volume(10.0)).await;
    h.poll(vec![status(0x28), fill(50, 5650), reply(1, 0xCA, &[])])
        .await;
    assert!(h.runtimes.read().await[&1].pre_auth.is_none());
    let id = h.runtimes.read().await[&1]
        .current_tx
        .as_ref()
        .unwrap()
        .id
        .clone();
    h.poll(final_replies(0x88, 50, 5650, false)).await;
    h.settle().await;
    h.poll(final_replies(0x88, 50, 5650, true)).await;
    assert_eq!(h.sales().await, vec![(id, 0.5, 5650, "COMPLETED".into())]);
}

#[tokio::test]
async fn active_stop_retries_are_paced_and_resume_without_resetting_the_sale() {
    let h = Harness::new().await;
    let id = h.authorize(Preset::Str("full".into())).await;
    h.poll(vec![status(0x28), fill(50, 5650)]).await;
    assert_eq!(
        h.command(DispatchCommand::Stop { byte: 1 }, vec![])
            .await
            .len(),
        EXCHANGE_RETRIES
    );
    for _ in 0..10 {
        assert!(h
            .command(DispatchCommand::Stop { byte: 1 }, vec![])
            .await
            .is_empty());
        assert_eq!(
            h.poll(vec![status(0x28), fill(50, 5650)]).await,
            vec![
                texnouz_bluesky::read_status(1),
                texnouz_bluesky::read_fill(1)
            ]
        );
    }
    h.runtimes
        .write()
        .await
        .get_mut(&1)
        .unwrap()
        .bluesky
        .next_stop_attempt = Some(std::time::Instant::now() - STOP_RETRY_INTERVAL);
    h.poll(vec![status(0x28), fill(51, 5763), reply(1, 0xCA, &[])])
        .await;
    h.poll(final_replies(0x08, 51, 5763, false)).await;
    h.settle().await;
    // Repeated Stop while confirming must not restart final-meter confirmation.
    assert!(h
        .command(DispatchCommand::Stop { byte: 1 }, vec![])
        .await
        .is_empty());
    h.poll(final_replies(0x08, 51, 5763, true)).await;
    assert_eq!(h.sales().await, vec![(id, 0.51, 5763, "COMPLETED".into())]);
}

#[tokio::test]
async fn stop_and_emergency_stop_save_partial_fill_only_after_stable_end() {
    for cmd in [DispatchCommand::Stop { byte: 1 }, DispatchCommand::EStop] {
        let h = Harness::new().await;
        let id = h.authorize(Preset::Str("full".into())).await;
        h.poll(vec![status(0x28), fill(50, 5650)]).await;
        let mut replies = vec![reply(1, 0xCA, &[])];
        if matches!(cmd, DispatchCommand::EStop) {
            replies.push(reply(1, 0xCA, &[]));
        }
        h.command(cmd, replies).await;
        assert!(h.sales().await.is_empty());
        h.poll(final_replies(0x08, 50, 5650, false)).await;
        h.settle().await;
        h.poll(final_replies(0x08, 50, 5650, true)).await;
        assert_eq!(h.sales().await, vec![(id, 0.5, 5650, "COMPLETED".into())]);
    }
}

#[tokio::test]
async fn full_fill_holster_announces_finalizing_until_final_meters_are_confirmed() {
    let h = Harness::new().await;
    let id = h.authorize(Preset::Str("full".into())).await;
    h.poll(vec![status(0x28), fill(1000, 113000)]).await;
    let mut events = h.events.subscribe();

    // Holster arrives before the final meter response is available.
    h.poll(vec![status(0x88)]).await;
    let WsEvent::Status(pending) = events.try_recv().unwrap() else {
        panic!("expected immediate finalizing status");
    };
    assert_eq!(pending.status, FpStatus::Finalizing);
    assert_eq!(pending.volume, 10.0);
    assert_eq!(pending.amount, 113000);
    assert!(h.sales().await.is_empty());
    for cmd in [
        DispatchCommand::ResetLane { byte: 1 },
        DispatchCommand::Authorize {
            byte: 1,
            price: 11300,
            preset: Preset::Volume(5.0),
        },
    ] {
        assert!(h.command(cmd, vec![]).await.is_empty());
    }
    assert_eq!(
        h.runtimes.read().await[&1].current_tx.as_ref().unwrap().id,
        id
    );

    h.poll(final_replies(0x88, 1000, 113000, false)).await;
    h.settle().await;
    h.poll(final_replies(0x88, 1001, 113113, false)).await;
    assert_eq!(
        h.runtimes.read().await[&1].state.status,
        FpStatus::Finalizing
    );
    assert!(h.sales().await.is_empty());
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(event, WsEvent::Done(_)));
    }
    h.settle().await;
    h.poll(final_replies(0x88, 1001, 113113, true)).await;
    assert_eq!(h.runtimes.read().await[&1].state.status, FpStatus::Done);
    let mut done_count = 0;
    while let Ok(event) = events.try_recv() {
        if matches!(event, WsEvent::Done(_)) {
            done_count += 1;
        }
    }
    assert_eq!(done_count, 1);
    h.poll(vec![status(0x88)]).await;
    assert_eq!(
        h.sales().await,
        vec![(id, 10.01, 113113, "COMPLETED".into())]
    );
}

#[tokio::test]
async fn final_confirmation_restarts_when_readings_change_or_flow_returns() {
    let h = Harness::new().await;
    h.authorize(Preset::Volume(10.0)).await;
    h.poll(vec![status(0x28), fill(1000, 113000)]).await;
    h.poll(final_replies(0x08, 1000, 113000, false)).await;
    h.settle().await;
    // Residual flow changed the final meter: it must settle again.
    h.poll(final_replies(0x08, 1001, 113113, false)).await;
    assert!(h.sales().await.is_empty());
    h.settle().await;
    h.poll(vec![status(0x68), fill(1001, 113113)]).await; // paused, not completed
    assert_eq!(
        h.runtimes.read().await[&1].state.status,
        FpStatus::Delivering
    );
    assert!(h.runtimes.read().await[&1]
        .bluesky
        .finish_candidate
        .is_none());
    h.poll(final_replies(0x08, 1001, 113113, false)).await;
    assert!(h.sales().await.is_empty());
    h.settle().await;
    h.poll(final_replies(0x08, 1001, 113113, true)).await;
    assert_eq!(h.sales().await[0].1, 10.01);
}

#[tokio::test]
async fn stale_idle_runtime_does_not_authorize_physically_busy_hose() {
    let h = Harness::new().await;
    let written = h
        .command(
            DispatchCommand::Authorize {
                byte: 1,
                price: 11300,
                preset: Preset::Volume(10.0),
            },
            vec![status(0x28)],
        )
        .await;
    assert_eq!(written, vec![texnouz_bluesky::read_status(1)]);
    assert!(h.runtimes.read().await[&1].current_tx.is_none());
}

#[tokio::test]
async fn flow_observed_during_setup_is_retained_and_stopped_without_sending_start() {
    let h = Harness::new().await;
    h.arm(Preset::Volume(10.0)).await;
    let sent = h
        .poll(vec![
            status(0x00),
            reply(1, 0xE5, &[]),
            reply(1, 0xB2, &[0x59]),
            reply(1, 0xB9, &[]),
            status(0x20),
            fill(50, 5650),
            reply(1, 0xCA, &[]),
        ])
        .await;
    assert!(!sent.contains(&texnouz_bluesky::start(1)));
    assert!(sent.contains(&texnouz_bluesky::stop(1)));
    assert!(h.runtimes.read().await[&1].pre_auth.is_none());
    assert!(h.runtimes.read().await[&1].current_tx.is_some());
    h.poll(final_replies(0x80, 50, 5650, false)).await;
    h.settle().await;
    h.poll(final_replies(0x80, 50, 5650, true)).await;
    assert_eq!(h.sales().await[0].1, 0.5);
}
