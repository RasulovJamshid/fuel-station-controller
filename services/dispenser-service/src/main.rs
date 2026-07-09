mod admin;
mod api;
mod config;
mod db;
mod engine;
mod scan;
mod shifts;
mod sync;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use clap::{Parser, Subcommand};
use engine::{
    initial_runtimes, run_poll_loop, spawn_preauth_timeout_task, DispatchCommand, MockSerial,
    SerialBackend,
};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing_subscriber::EnvFilter;

use crate::admin::AdminSessions;
use crate::api::routes::{router, AppState};
use crate::config::load;
use crate::engine::{init_serial_logger, ReconnectingSerial};
use crate::shifts::{spawn_warning_task, ShiftCoordinator};

#[derive(Parser)]
#[command(name = "dispenser-service")]
struct Cli {
    /// Path to site.config.json (allowed before or after the subcommand).
    #[arg(long, global = true, default_value = "site.config.json")]
    config: std::path::PathBuf,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run HTTP + WebSocket API and poll loop (foreground).
    Run,
    /// Read-only AZT RS-485 bus scan (addresses 1..=15) → JSON report.
    /// Requires the serial port to be free (stop the running service first).
    Scan {
        /// Output JSON path.
        #[arg(long, default_value = "azt-scan.json")]
        out: std::path::PathBuf,
    },
    /// Install as Windows service (Windows only).
    #[cfg(windows)]
    Install,
    #[cfg(windows)]
    Uninstall,
    #[cfg(windows)]
    Start,
    #[cfg(windows)]
    Stop,
    #[command(hide = true)]
    ReinitAuth,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Run => run(cli.config).await,
        Commands::Scan { out } => scan::run_scan(cli.config, out).await,
        Commands::ReinitAuth => reinit_auth(cli.config).await,
        #[cfg(windows)]
        Commands::Install | Commands::Uninstall | Commands::Start | Commands::Stop => {
            tracing::warn!("service control is not implemented in this build");
            Ok(())
        }
    }
}

async fn reinit_auth(config_path: std::path::PathBuf) -> Result<()> {
    let (cfg, _) = load(Some(config_path))?;
    let db_opts = SqliteConnectOptions::new()
        .filename(&cfg.service.db_path)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(db_opts)
        .await?;
    admin::reset_admin_pin_to_default(&pool).await?;
    println!("Admin PIN reset to factory default. Must-change flag is set.");
    Ok(())
}

async fn run(config_path: std::path::PathBuf) -> Result<()> {
    let (cfg_loaded, config_path_buf) = load(Some(config_path))?;
    let log_level = cfg_loaded.service.log_level.clone();
    let db_path = cfg_loaded.service.db_path.clone();
    let port = cfg_loaded.service.port;
    // Extract before the move into Arc.
    let serial_log_path = std::env::var("AZS_SERIAL_LOG")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| cfg_loaded.service.serial_log_file.clone());
    let cfg = Arc::new(RwLock::new(cfg_loaded));
    let cfg_for_shifts = Arc::new(cfg.read().await.clone());
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&log_level));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    // Serial frame logger: AZS_SERIAL_LOG env var takes priority over config field.
    if let Some(ref path) = serial_log_path {
        match init_serial_logger(path) {
            Ok(()) => tracing::info!(path = %path, "serial frame logger enabled"),
            Err(e) => {
                tracing::warn!(path = %path, ?e, "failed to open serial log — logging disabled")
            }
        }
    }

    let db_opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(db_opts)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    db::repair::ensure_price_history_columns(&pool).await?;
    db::repair::ensure_fp_nozzles_schema(&pool).await?;
    match db::shift_queries::recompute_shift_totals_from_transactions(&pool).await {
        Ok(n) if n > 0 => tracing::info!(count = n, "repaired shift totals from transactions"),
        Ok(_) => {}
        Err(e) => tracing::warn!(%e, "shift total repair failed"),
    }

    admin::ensure_admin_defaults(&pool).await?;

    // DB is the source of truth for products and nozzle configs.
    // Seed from JSON on first run so DB is always populated.
    {
        use crate::db::admin_queries;
        let products_db = admin_queries::load_products_from_db(&pool).await?;
        if products_db.is_empty() {
            let cfg_r = cfg.read().await;
            admin_queries::save_products_to_db(&pool, &cfg_r.products, "system").await?;
            for fp in &cfg_r.fueling_positions {
                admin_queries::save_fp_nozzles_to_db(&pool, &fp.id, &fp.nozzles, "system").await?;
            }
            tracing::info!(
                "seeded {} products from JSON config into DB",
                cfg_r.products.len()
            );
        } else {
            let nozzles_db = admin_queries::load_fp_nozzles_from_db(&pool).await?;
            let mut w = cfg.write().await;
            tracing::info!(count = products_db.len(), "loaded products from DB");
            w.products = products_db;
            for fp in &mut w.fueling_positions {
                if let Some(nozzles) = nozzles_db.get(&fp.id) {
                    fp.nozzles = nozzles.clone();
                }
            }
        }
    }

    let runtimes = Arc::new(RwLock::new(initial_runtimes(&*cfg.read().await)));
    let disp_by_byte: HashMap<u8, _> = cfg
        .read()
        .await
        .fueling_positions
        .iter()
        .filter(|fp| fp.active)
        .map(|fp| (fp.address_byte, fp.clone()))
        .collect();

    let (events_tx, _events_rx) = broadcast::channel::<types::WsEvent>(256);
    let (cmd_tx, cmd_rx) = mpsc::channel::<DispatchCommand>(64);
    let tank_levels: atg::TankLevels =
        Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));

    let shifts = Arc::new(ShiftCoordinator::new(pool.clone(), cfg_for_shifts.clone()));
    shifts.restore().await?;
    // Recover shifts closed locally whose CLOSED state never reached the backend (so they are
    // stuck ACTIVE on the server admin). Idempotent + self-limiting; drains via the sync worker.
    match db::shift_queries::backfill_unsynced_closed_shifts(&pool).await {
        Ok(n) if n > 0 => tracing::info!(
            count = n,
            "re-enqueued unsynced CLOSED shift(s) for backend sync"
        ),
        Ok(_) => {}
        Err(e) => tracing::warn!(%e, "backfill of unsynced closed shifts failed"),
    }
    spawn_warning_task(shifts.clone(), events_tx.clone());
    spawn_preauth_timeout_task(
        cfg_for_shifts.clone(),
        runtimes.clone(),
        cmd_tx.clone(),
        events_tx.clone(),
    );

    let backend = if cfg.read().await.is_mock_serial() {
        SerialBackend::Mock(Arc::new(std::sync::Mutex::new(MockSerial::new())))
    } else {
        match ReconnectingSerial::new(&*cfg.read().await) {
            Ok(real) => SerialBackend::Real(real),
            Err(e) => {
                tracing::warn!(?e, "serial open failed — using MOCK");
                SerialBackend::Mock(Arc::new(std::sync::Mutex::new(MockSerial::new())))
            }
        }
    };

    let cfg_loop = {
        let g = cfg.read().await;
        Arc::new(g.clone())
    };
    let rt_clone = runtimes.clone();
    let ev_clone = events_tx.clone();
    let disp_clone = disp_by_byte.clone();
    let pool_loop = pool.clone();
    let shifts_loop = shifts.clone();
    tokio::spawn(async move {
        run_poll_loop(
            cfg_loop,
            backend,
            rt_clone,
            disp_clone,
            ev_clone,
            cmd_rx,
            pool_loop,
            shifts_loop,
        )
        .await;
    });

    // Spawn outbound sync worker.
    let sync_status = {
        let r = cfg.read().await;
        crate::sync::new_status(&r.sync)
    };
    tokio::spawn(crate::sync::run(
        pool.clone(),
        cfg.clone(),
        config_path_buf.clone(),
        sync_status.clone(),
        cmd_tx.clone(),
    ));

    // Spawn ATG Modbus polling task. It reads the shared config each cycle, so admin
    // changes to ATG settings take effect without restarting the service.
    {
        let atg_cfg = cfg.read().await.atg.clone();
        let (atg_sync_tx, mut atg_sync_rx) =
            tokio::sync::mpsc::unbounded_channel::<atg::LocalTankReading>();
        let atg_pool = pool.clone();
        tokio::spawn(async move {
            while let Some(reading) = atg_sync_rx.recv().await {
                let payload = serde_json::json!({
                    "tank_id": reading.tank_id,
                    "product_id": reading.product_id,
                    "volume_litres": reading.volume_litres,
                    "level_mm": reading.level_mm,
                    "temperature_c": reading.temperature_c,
                    "water_mm": reading.water_mm,
                    "fill_percent": reading.fill_percent,
                    "reading_at": reading.reading_at_ms,
                });
                let entity_id = format!(
                    "{}/{}",
                    payload["tank_id"].as_str().unwrap_or("tank"),
                    reading.reading_at_ms
                );
                if let Err(e) =
                    crate::sync::enqueue(&atg_pool, "reservoir_reading", &entity_id, &payload).await
                {
                    tracing::warn!(?e, "ATG reservoir_reading sync enqueue failed");
                }
            }
        });
        tracing::info!(
            enabled = atg_cfg.is_some(),
            branches = atg_cfg.as_ref().map(|a| a.branches.len()).unwrap_or(0),
            interval_secs = atg_cfg
                .as_ref()
                .map(|a| a.poll_interval_secs)
                .unwrap_or(300),
            "ATG task starting"
        );
        tokio::spawn(atg::run(
            cfg.clone(),
            tank_levels.clone(),
            events_tx.clone(),
            Some(atg_sync_tx),
        ));
    }

    tracing::info!(config = %config_path_buf.display(), "config file");
    let state = AppState {
        cfg,
        config_path: config_path_buf,
        runtimes,
        events: events_tx,
        commands: cmd_tx,
        pool,
        shifts,
        admin_sessions: AdminSessions::new(),
        started: Instant::now(),
        sync_status,
        tank_levels,
    };

    let app = router(state);
    let addr = format!("127.0.0.1:{}", port);
    tracing::info!("listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
