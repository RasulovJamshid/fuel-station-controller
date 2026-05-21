mod admin;
mod api;
mod config;
mod db;
mod engine;
mod shifts;

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
    /// Install as Windows service (Windows only).
    #[cfg(windows)]
    Install,
    #[cfg(windows)]
    Uninstall,
    #[cfg(windows)]
    Start,
    #[cfg(windows)]
    Stop,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Run => run(cli.config).await,
        #[cfg(windows)]
        Commands::Install | Commands::Uninstall | Commands::Start | Commands::Stop => {
            tracing::warn!("service control is not implemented in this build");
            Ok(())
        }
    }
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

    admin::ensure_admin_defaults(&pool).await?;

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

    let shifts = Arc::new(ShiftCoordinator::new(pool.clone(), cfg_for_shifts.clone()));
    shifts.restore().await?;
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
    };

    let app = router(state);
    let addr = format!("127.0.0.1:{}", port);
    tracing::info!("listening on http://{}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
