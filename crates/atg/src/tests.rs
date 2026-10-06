use super::*;
#[test]
fn empty_tank_is_valid_and_invalid_fields_are_rejected() {
    assert!(slot_values(&[0., 0., 20., 0., 0., 0.], 1).is_some());
    assert!(slot_values(&[0., 0., f32::NAN, 0., 0., 0.], 1).is_none());
    assert!(slot_values(&[0., 0., 20., 0., -1., 0.], 1).is_none());
    assert!(slot_values(&[0.; 6], 0).is_none());
    assert!(slot_values(&[0.; 6], 2).is_none());
}

fn config(tanks: usize) -> SiteConfig {
    let mut value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../services/dispenser-service/site.mock.json"
    ))
    .unwrap();
    let pid = value["products"][0]["id"].clone();
    value["tanks"]=serde_json::json!((1..=tanks).map(|i|serde_json::json!({"tank_id":format!("tank-{i}"),"product_id":pid,"label":format!("Tank {i}"),"capacity_l":25000,"current_l":0})).collect::<Vec<_>>());
    value["atg"] = serde_json::json!({"poll_interval_secs":10,"branches":[{"id":1,"external_station_id":42,"host":"192.0.2.1","register_count":tanks*12,
        "slots":(1..=tanks).map(|i|serde_json::json!({"slot":i,"tank_id":format!("tank-{i}"),"product_id":pid,"type":"AI-92"})).collect::<Vec<_>>() }]});
    serde_json::from_value(value).unwrap()
}
#[test]
fn accepts_twelve_independent_tanks_for_one_product() {
    let mut cfg = config(12);
    cfg.normalize_tank_ids().unwrap();
    cfg.validate().unwrap();
    let tanks = snapshots(&cfg, &HashMap::new(), 0);
    assert_eq!(tanks.len(), 12);
    assert!(tanks.iter().all(|t| t.reading_status == "waiting"));
    assert_ne!(tanks[0].tank_id, tanks[1].tank_id);
}
#[test]
fn validates_mapping_capacity_and_register_bounds() {
    let base = config(2);
    for mutate in [
        |c: &mut SiteConfig| c.tanks[1].tank_id = "tank-1".into(),
        |c: &mut SiteConfig| {
            c.atg.as_mut().unwrap().branches[0].slots[1].tank_id = Some("tank-1".into())
        },
        |c: &mut SiteConfig| c.atg.as_mut().unwrap().branches[0].start_register = 0,
        |c: &mut SiteConfig| c.atg.as_mut().unwrap().branches[0].start_register = 65530,
        |c: &mut SiteConfig| {
            c.atg.as_mut().unwrap().branches[0].slots[0].capacity_l = Some(20000.0)
        },
        |c: &mut SiteConfig| c.atg.as_mut().unwrap().modbus_timeout_secs = f64::NAN,
    ] {
        let mut cfg = base.clone();
        mutate(&mut cfg);
        assert!(cfg.validate().is_err());
    }
}
#[test]
fn aggregates_empty_tanks_and_suppresses_incomplete_external_groups() {
    let mut cfg = config(2);
    let mut b = cfg.atg.as_ref().unwrap().branches[0].clone();
    b.id = 2;
    b.host = "192.0.2.2".into();
    b.register_count = 12;
    b.slots = vec![b.slots[1].clone()];
    b.slots[0].slot = 1;
    cfg.atg.as_mut().unwrap().branches[0].slots.truncate(1);
    cfg.atg.as_mut().unwrap().branches[0].register_count = 12;
    cfg.atg.as_mut().unwrap().branches.push(b);
    cfg.validate().unwrap();
    let mut readings = HashMap::from([
        (1, vec![1., 0., 20., 100., 100., 0.]),
        (2, vec![0., 0., 10., 0., 0., 0.]),
    ]);
    let bodies = integration::build_round(&cfg, &readings, "now");
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0]["metadata"]["product_volume"], 100.0);
    assert_eq!(bodies[0]["metadata"]["max_product_volume"], 50000.0);
    readings.remove(&2);
    assert!(integration::build_round(&cfg, &readings, "now").is_empty());
    readings.insert(2, vec![0., 0., f32::NAN, 0., 0., 0.]);
    assert!(integration::build_round(&cfg, &readings, "now").is_empty());
    readings.insert(1, vec![0.; 6]);
    readings.insert(2, vec![0.; 6]);
    assert_eq!(
        integration::build_round(&cfg, &readings, "now")[0]["metadata"]["product_volume"],
        0.0
    );
}
#[test]
fn freshness_is_per_physical_tank_and_disabled_readings_are_not_live() {
    let mut cfg = config(2);
    let levels = HashMap::from([(
        "tank-1".into(),
        TankLiveLevel {
            tank_id: "tank-1".into(),
            product_id: cfg.tanks[0].product_id,
            current_l: 100.,
            temperature_c: 20.,
            water_l: 0.,
            updated_at_ms: 1000,
            last_error: None,
        },
    )]);
    let fresh = snapshots(&cfg, &levels, 2000);
    assert_eq!(fresh[0].reading_status, "fresh");
    assert_eq!(fresh[1].reading_status, "waiting");
    assert_eq!(snapshots(&cfg, &levels, 32000)[0].reading_status, "stale");
    cfg.atg = None;
    let disabled = snapshots(&cfg, &levels, 2000);
    assert_eq!(disabled[0].reading_status, "disabled");
    assert_eq!(disabled[0].updated_at_ms, None);
}
#[test]
fn normalizes_legacy_ids_once_and_preserves_explicit_ids_on_rename() {
    let mut cfg = config(1);
    cfg.tanks[0].tank_id.clear();
    cfg.normalize_tank_ids().unwrap();
    assert_eq!(cfg.tanks[0].tank_id, "tank-1");
    cfg.tanks[0].label = "Renamed".into();
    cfg.atg.as_mut().unwrap().branches[0].slots[0].label = Some("Other name".into());
    cfg.normalize_tank_ids().unwrap();
    assert_eq!(cfg.tanks[0].tank_id, "tank-1");
}
#[tokio::test]
async fn readings_and_external_exports_are_durable_and_retry_idempotently() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../services/dispenser-service/migrations/008_sync_queue.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("CREATE TABLE atg_outbox(id TEXT PRIMARY KEY,target_url TEXT,payload_json TEXT,created_at INTEGER,next_attempt_at INTEGER DEFAULT 0,attempts INTEGER DEFAULT 0,last_error TEXT)").execute(&pool).await.unwrap();
    let readings = vec![serde_json::json!({"tank_id":"tank-1","reading_at":123,"volume_litres":0})];
    let external = vec![serde_json::json!({"type":"AI-92","metadata":{"product_volume":0}})];
    for _ in 0..2 {
        outbox::persist(&pool, &readings, &external, "https://example.invalid")
            .await
            .unwrap();
    }
    let local: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue")
        .fetch_one(&pool)
        .await
        .unwrap();
    let remote: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM atg_outbox")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!((local, remote), (1, 1));
    sqlx::query("DROP TABLE atg_outbox")
        .execute(&pool)
        .await
        .unwrap();
    let next = vec![serde_json::json!({"tank_id":"tank-1","reading_at":124,"volume_litres":1})];
    assert!(
        outbox::persist(&pool, &next, &external, "https://example.invalid")
            .await
            .is_err()
    );
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_queue")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(after, 1);
}
