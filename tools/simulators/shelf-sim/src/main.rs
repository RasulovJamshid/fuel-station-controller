mod simulator;

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use axum::{extract::State, routing::get, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use simulator::ShelfSimulator;
use tracing::{debug, info, warn};
use tracing_subscriber::EnvFilter;

type Shared = Arc<Mutex<Vec<ShelfSimulator>>>;

#[derive(Debug, Deserialize)]
struct SimConfig {
    virtual_port: String,
    api_port: u16,
    site_config_path: String,
    #[serde(default = "default_rate")]
    fill_rate_m3_per_second: f64,
    #[serde(default)]
    log_frames: bool,
}

fn default_rate() -> f64 {
    0.5
}

#[derive(Debug, Deserialize)]
struct Target {
    fp_id: String,
}

#[derive(Debug, Serialize)]
struct ApiReply {
    ok: bool,
    message: String,
}

#[derive(Debug, Serialize)]
struct SimState {
    fp_id: String,
    address: u8,
    state: String,
    nozzle_lifted: bool,
    volume_m3: f64,
    amount: u32,
    price: u32,
    online: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "sim.config.json".into());
    let config: SimConfig = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    let base = std::path::Path::new(&path)
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let site_path = base.join(&config.site_config_path);
    let site = site_config::SiteConfig::load(&site_path.to_string_lossy())
        .with_context(|| format!("load {}", site_path.display()))?;
    let simulators = site
        .active_positions()
        .into_iter()
        .map(|fp| {
            ShelfSimulator::new(
                fp.id.clone(),
                fp.address_byte,
                fp.default_price().unwrap_or(1),
                config.fill_rate_m3_per_second,
            )
        })
        .collect();
    let shared = Arc::new(Mutex::new(simulators));
    spawn_serial(
        config.virtual_port.clone(),
        shared.clone(),
        config.log_frames,
    );

    let app = Router::new()
        .route("/sim/state", get(get_state))
        .route("/sim/nozzle-up", post(nozzle_up))
        .route("/sim/nozzle-down", post(nozzle_down))
        .route("/sim/go-offline", post(go_offline))
        .route("/sim/go-online", post(go_online))
        .route("/sim/reset", post(reset))
        .with_state(shared);
    let address = format!("0.0.0.0:{}", config.api_port);
    let listener = tokio::net::TcpListener::bind(&address).await?;
    info!(%address, port = %config.virtual_port, "SHELF simulator ready");
    axum::serve(listener, app).await?;
    Ok(())
}

fn spawn_serial(port_name: String, simulators: Shared, log_frames: bool) {
    std::thread::spawn(move || loop {
        let result = serialport::new(&port_name, 19_200)
            .parity(serialport::Parity::None)
            .data_bits(serialport::DataBits::Eight)
            .stop_bits(serialport::StopBits::One)
            .timeout(Duration::from_millis(20))
            .open();
        let mut port = match result {
            Ok(port) => port,
            Err(error) => {
                warn!(%error, %port_name, "SHELF simulator waiting for serial port");
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
        };
        let mut accumulated = Vec::new();
        let mut buffer = [0u8; 256];
        loop {
            match port.read(&mut buffer) {
                Ok(count) if count > 0 => {
                    accumulated.extend_from_slice(&buffer[..count]);
                    while let Some((frame, consumed)) = shelf_v22::take_frame(&accumulated) {
                        accumulated.drain(..consumed);
                        if log_frames {
                            debug!(rx = %hex(&frame), "SHELF simulator frame");
                        }
                        let response = {
                            let mut all = simulators.lock().unwrap();
                            all.iter_mut()
                                .find(|sim| sim.address == frame[1])
                                .and_then(|sim| sim.handle(&frame))
                        };
                        if let Some(response) = response {
                            if log_frames {
                                debug!(tx = %hex(&response), "SHELF simulator frame");
                            }
                            if port.write_all(&response).is_err() {
                                break;
                            }
                        }
                    }
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                    for sim in simulators.lock().unwrap().iter_mut() {
                        sim.tick();
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

async fn get_state(State(shared): State<Shared>) -> Json<Vec<SimState>> {
    let mut all = shared.lock().unwrap();
    Json(
        all.iter_mut()
            .map(|sim| {
                sim.tick();
                SimState {
                    fp_id: sim.fp_id.clone(),
                    address: sim.address,
                    state: format!("{:?}", sim.state),
                    nozzle_lifted: sim.nozzle_lifted,
                    volume_m3: sim.volume_steps as f64 / 100.0,
                    amount: sim.amount(),
                    price: sim.price,
                    online: sim.online,
                }
            })
            .collect(),
    )
}

fn mutate(
    shared: &Shared,
    target: Target,
    action: impl FnOnce(&mut ShelfSimulator) -> anyhow::Result<()>,
) -> Json<ApiReply> {
    let mut all = shared.lock().unwrap();
    let result = all
        .iter_mut()
        .find(|sim| sim.fp_id == target.fp_id)
        .ok_or_else(|| anyhow::anyhow!("unknown fp_id"))
        .and_then(action);
    match result {
        Ok(()) => Json(ApiReply {
            ok: true,
            message: String::new(),
        }),
        Err(error) => Json(ApiReply {
            ok: false,
            message: error.to_string(),
        }),
    }
}

async fn nozzle_up(State(shared): State<Shared>, Json(target): Json<Target>) -> Json<ApiReply> {
    mutate(&shared, target, |sim| sim.lift())
}
async fn nozzle_down(State(shared): State<Shared>, Json(target): Json<Target>) -> Json<ApiReply> {
    mutate(&shared, target, |sim| sim.holster())
}
async fn go_offline(State(shared): State<Shared>, Json(target): Json<Target>) -> Json<ApiReply> {
    mutate(&shared, target, |sim| {
        sim.online = false;
        Ok(())
    })
}
async fn go_online(State(shared): State<Shared>, Json(target): Json<Target>) -> Json<ApiReply> {
    mutate(&shared, target, |sim| {
        sim.online = true;
        Ok(())
    })
}
async fn reset(State(shared): State<Shared>, Json(target): Json<Target>) -> Json<ApiReply> {
    mutate(&shared, target, |sim| {
        sim.reset();
        Ok(())
    })
}
