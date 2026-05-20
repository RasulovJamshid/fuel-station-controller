use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::dispenser::{SharedDispensers, SimStatus};

pub fn router(dispensers: SharedDispensers) -> Router {
    Router::new()
        .route("/sim/state", get(get_state))
        .route("/sim/nozzle-up", post(nozzle_up))
        .route("/sim/nozzle-down", post(nozzle_down))
        .route("/sim/go-offline", post(go_offline))
        .route("/sim/go-online", post(go_online))
        .route("/sim/estop", post(estop_all))
        .route("/sim/reset", post(reset_all))
        .route("/sim/scenario", post(run_scenario))
        .route("/sim/preauth-expectation", post(preauth_expectation))
        .route("/sim/prepare-preauth", post(prepare_preauth))
        .with_state(dispensers)
}

#[derive(Deserialize)]
pub struct PreauthExpectationCmd {
    #[serde(flatten)]
    pub target: FpCmd,
    pub nozzle: u8,
    pub product: u8,
    #[serde(default)]
    pub product_name: Option<String>,
}

#[derive(Deserialize)]
pub struct NozzleUpCmd {
    /// Preferred: `"FP1"`, … (matches site `fueling_positions[].id`).
    #[serde(default)]
    pub fp_id: Option<String>,
    /// Legacy: `"P0"` … `"P3"` (0x50–0x53).
    #[serde(default)]
    pub addr: Option<String>,
    pub product: Option<u8>,
    pub product_name: Option<String>,
    pub nozzle: Option<u8>,
    pub price: Option<u32>,
}

#[derive(Deserialize)]
pub struct FpCmd {
    #[serde(default)]
    pub fp_id: Option<String>,
    #[serde(default)]
    pub addr: Option<String>,
}

#[derive(Deserialize)]
pub struct OfflineCmd {
    #[serde(flatten)]
    pub target: FpCmd,
    pub flush: Option<bool>,
}

#[derive(Deserialize)]
pub struct ScenarioCmd {
    pub name: String,
}

#[derive(Serialize)]
pub struct ApiResponse {
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Serialize)]
pub struct DispenserInfo {
    pub fp_id: String,
    pub addr: u8,
    pub label: String,
    pub status: String,
    pub volume: f64,
    pub amount: u64,
    pub respond: bool,
}

fn resolve_addr(disps: &[crate::dispenser::SimDispenser], cmd: &FpCmd) -> Option<u8> {
    if let Some(ref id) = cmd.fp_id {
        if !id.is_empty() {
            return disps.iter().find(|d| d.fp_id == *id).map(|d| d.addr);
        }
    }
    if let Some(ref a) = cmd.addr {
        if let Some(b) = legacy_p_to_byte(a) {
            return Some(b);
        }
        return disps.iter().find(|d| d.fp_id == *a).map(|d| d.addr);
    }
    None
}

fn legacy_p_to_byte(addr: &str) -> Option<u8> {
    match addr {
        "P0" => Some(0x50),
        "P1" => Some(0x51),
        "P2" => Some(0x52),
        "P3" => Some(0x53),
        _ => None,
    }
}

async fn get_state(State(disps): State<SharedDispensers>) -> Json<Vec<DispenserInfo>> {
    let disps = disps.lock().unwrap();
    let info = disps
        .iter()
        .map(|d| DispenserInfo {
            fp_id: d.fp_id.clone(),
            addr: d.addr,
            label: d.label.clone(),
            status: format!("{:?}", d.status),
            volume: d.volume,
            amount: d.amount,
            respond: d.respond,
        })
        .collect();
    Json(info)
}

async fn nozzle_up(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<NozzleUpCmd>,
) -> (StatusCode, Json<ApiResponse>) {
    let disps_guard = disps.lock().unwrap();
    let target = FpCmd {
        fp_id: cmd.fp_id.clone(),
        addr: cmd.addr.clone(),
    };
    let Some(byte) = resolve_addr(&disps_guard, &target) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                ok: false,
                message: Some("fp_id or addr required".into()),
            }),
        );
    };
    drop(disps_guard);
    let mut disps = disps.lock().unwrap();
    match disps.iter_mut().find(|d| d.addr == byte) {
        None => (
            StatusCode::NOT_FOUND,
            Json(ApiResponse {
                ok: false,
                message: Some(format!("position for 0x{:02X} not found", byte)),
            }),
        ),
        Some(d) => match d.lift_nozzle(
            cmd.product,
            cmd.product_name.clone(),
            cmd.nozzle,
            cmd.price,
        ) {
            Ok(()) => (
                StatusCode::OK,
                Json(ApiResponse {
                    ok: true,
                    message: None,
                }),
            ),
            Err(e) => (
                StatusCode::CONFLICT,
                Json(ApiResponse {
                    ok: false,
                    message: Some(e.to_string()),
                }),
            ),
        },
    }
}

async fn prepare_preauth(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<PreauthExpectationCmd>,
) -> (StatusCode, Json<ApiResponse>) {
    let disps_guard = disps.lock().unwrap();
    let target = FpCmd {
        fp_id: cmd.target.fp_id.clone(),
        addr: cmd.target.addr.clone(),
    };
    let Some(byte) = resolve_addr(&disps_guard, &target) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                ok: false,
                message: Some("fp_id or addr required".into()),
            }),
        );
    };
    drop(disps_guard);
    let mut disps = disps.lock().unwrap();
    match disps.iter_mut().find(|d| d.addr == byte) {
        None => (
            StatusCode::NOT_FOUND,
            Json(ApiResponse {
                ok: false,
                message: Some(format!("position for 0x{:02X} not found", byte)),
            }),
        ),
        Some(d) => {
            d.prepare_preauth_lane(cmd.nozzle, cmd.product, cmd.product_name.clone());
            (
                StatusCode::OK,
                Json(ApiResponse {
                    ok: true,
                    message: None,
                }),
            )
        }
    }
}

async fn preauth_expectation(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<PreauthExpectationCmd>,
) -> (StatusCode, Json<ApiResponse>) {
    let disps_guard = disps.lock().unwrap();
    let target = FpCmd {
        fp_id: cmd.target.fp_id.clone(),
        addr: cmd.target.addr.clone(),
    };
    let Some(byte) = resolve_addr(&disps_guard, &target) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                ok: false,
                message: Some("fp_id or addr required".into()),
            }),
        );
    };
    drop(disps_guard);
    let mut disps = disps.lock().unwrap();
    match disps.iter_mut().find(|d| d.addr == byte) {
        None => (
            StatusCode::NOT_FOUND,
            Json(ApiResponse {
                ok: false,
                message: Some(format!("position for 0x{:02X} not found", byte)),
            }),
        ),
        Some(d) => {
            d.set_preauth_expectation(cmd.nozzle, cmd.product, cmd.product_name.clone());
            (
                StatusCode::OK,
                Json(ApiResponse {
                    ok: true,
                    message: None,
                }),
            )
        }
    }
}

async fn nozzle_down(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<FpCmd>,
) -> (StatusCode, Json<ApiResponse>) {
    let disps_guard = disps.lock().unwrap();
    let Some(byte) = resolve_addr(&disps_guard, &cmd) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                ok: false,
                message: Some("fp_id or addr required".into()),
            }),
        );
    };
    drop(disps_guard);
    let mut disps = disps.lock().unwrap();
    match disps.iter_mut().find(|d| d.addr == byte) {
        None => (
            StatusCode::NOT_FOUND,
            Json(ApiResponse {
                ok: false,
                message: Some("not found".into()),
            }),
        ),
        Some(d) => match d.replace_nozzle() {
            Ok(()) => (
                StatusCode::OK,
                Json(ApiResponse {
                    ok: true,
                    message: None,
                }),
            ),
            Err(e) => (
                StatusCode::CONFLICT,
                Json(ApiResponse {
                    ok: false,
                    message: Some(e.to_string()),
                }),
            ),
        },
    }
}

async fn go_offline(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<OfflineCmd>,
) -> Json<ApiResponse> {
    let disps_guard = disps.lock().unwrap();
    if let Some(byte) = resolve_addr(&disps_guard, &cmd.target) {
        drop(disps_guard);
        let mut disps = disps.lock().unwrap();
        if let Some(d) = disps.iter_mut().find(|d| d.addr == byte) {
            d.go_offline();
        }
    }
    Json(ApiResponse {
        ok: true,
        message: None,
    })
}

async fn go_online(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<OfflineCmd>,
) -> Json<ApiResponse> {
    let flush = cmd.flush.unwrap_or(false);
    let disps_guard = disps.lock().unwrap();
    if let Some(byte) = resolve_addr(&disps_guard, &cmd.target) {
        drop(disps_guard);
        let mut disps = disps.lock().unwrap();
        if let Some(d) = disps.iter_mut().find(|d| d.addr == byte) {
            d.go_online(flush);
        }
    }
    Json(ApiResponse {
        ok: true,
        message: None,
    })
}

async fn estop_all(State(disps): State<SharedDispensers>) -> Json<ApiResponse> {
    let mut disps = disps.lock().unwrap();
    for d in disps.iter_mut() {
        if d.status == SimStatus::Delivering {
            d.status = SimStatus::Stopped;
        }
    }
    Json(ApiResponse {
        ok: true,
        message: None,
    })
}

async fn reset_all(State(disps): State<SharedDispensers>) -> Json<ApiResponse> {
    let mut disps = disps.lock().unwrap();
    for d in disps.iter_mut() {
        d.reset();
    }
    Json(ApiResponse {
        ok: true,
        message: None,
    })
}

async fn run_scenario(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<ScenarioCmd>,
) -> (StatusCode, Json<ApiResponse>) {
    let disps_clone = disps.clone();
    let name = cmd.name.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::scenarios::run(&name, disps_clone).await {
            tracing::error!("Scenario {} failed: {}", name, e);
        }
    });
    (
        StatusCode::OK,
        Json(ApiResponse {
            ok: true,
            message: Some(format!("Scenario '{}' started", cmd.name)),
        }),
    )
}
