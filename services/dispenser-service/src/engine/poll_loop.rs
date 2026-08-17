use std::collections::HashMap;
use std::sync::Arc;

use site_config::Protocol;
use site_config::{FuelingPositionConfig, SiteConfig};
use sqlx::SqlitePool;
use tokio::sync::{broadcast, mpsc, RwLock};
use types::{Preset, UpdatePriceCmd, WsEvent};

use super::protocols::shared::SerialBackend;
use super::state::RuntimeFp;
use crate::shifts::ShiftCoordinator;

#[derive(Debug)]
pub enum DispatchCommand {
    ReloadConfig {
        cfg: Arc<SiteConfig>,
    },
    Authorize {
        byte: u8,
        price: u32,
        preset: Preset,
    },
    ContinueFill {
        byte: u8,
        price: u32,
        preset: Preset,
    },
    ResumeFill {
        byte: u8,
        price: u32,
        preset: Preset,
    },
    Stop {
        byte: u8,
    },
    EStop,
    /// Clear all lane runtimes to idle (and optionally sync sim via desktop).
    ResetAll,
    /// Operator dismissed completed-sale display on one lane.
    ResetLane {
        byte: u8,
    },
    UpdatePrices {
        updates: Vec<UpdatePriceCmd>,
        changed_by: String,
    },
    Preauthorize {
        byte: u8,
        price: u32,
        preset: Preset,
        nozzle_index: u8,
    },
    CancelPreauth {
        byte: u8,
    },
    /// Re-read the pump lifetime totalizer for all lanes (e.g. operator opened the
    /// totalizer view). No-op on protocols without a totalizer.
    RefreshTotals,
}

pub async fn run_poll_loop(
    cfg: Arc<SiteConfig>,
    backend: SerialBackend,
    runtimes: Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    disp_by_byte: HashMap<u8, FuelingPositionConfig>,
    events: broadcast::Sender<WsEvent>,
    commands: mpsc::Receiver<DispatchCommand>,
    pool: SqlitePool,
    shifts: Arc<ShiftCoordinator>,
) {
    match &cfg.connection.protocol {
        Protocol::Azt20 => {
            super::protocols::azt::run(
                cfg,
                backend,
                runtimes,
                disp_by_byte,
                events,
                commands,
                pool,
                shifts,
            )
            .await
        }
        Protocol::Gilbarco => {
            super::protocols::gilbarco::run(
                cfg,
                backend,
                runtimes,
                disp_by_byte,
                events,
                commands,
                pool,
                shifts,
            )
            .await
        }
        Protocol::WayneEuropump
        | Protocol::WayneDartV1
        | Protocol::WayneDartV2
        | Protocol::Mock => {
            super::protocols::wayne::run(
                cfg,
                backend,
                runtimes,
                disp_by_byte,
                events,
                commands,
                pool,
                shifts,
            )
            .await
        }
    }
}
