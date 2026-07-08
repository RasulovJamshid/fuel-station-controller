use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::dispenser::SharedDispensers;

pub fn router(dispensers: SharedDispensers) -> Router {
    Router::new()
        .route("/sim/state", get(get_state))
        .route("/sim/nozzle-up", post(nozzle_up))
        .route("/sim/nozzle-down", post(nozzle_down))
        .route("/sim/prepare-preauth", post(prepare_preauth))
        .route("/sim/preauth-expectation", post(prepare_preauth))
        .route("/sim/go-offline", post(go_offline))
        .route("/sim/go-online", post(go_online))
        .route("/sim/estop", post(estop_all))
        .route("/sim/reset", post(reset_all))
        .route("/sim/set-fill-rate", post(set_fill_rate))
        .with_state(dispensers)
}

#[derive(Deserialize)]
pub struct FpCmd {
    #[serde(default)]
    pub fp_id: Option<String>,
}

#[derive(Deserialize)]
pub struct NozzleUpCmd {
    #[serde(default)]
    pub fp_id: Option<String>,
    pub nozzle: Option<u8>,
    pub price: Option<u32>,
}

// Sent by sim-desktop's "Pre" button: {fp_id, nozzle, product, product_name}.
// AZT arming happens on the wire (dose + authorize), so this is nozzle-up.
#[allow(dead_code)]
#[derive(Deserialize)]
pub struct PreparePreAuthCmd {
    pub fp_id: String,
    pub nozzle: u8,
    #[serde(default)]
    pub product: Option<u8>,
    #[serde(default)]
    pub product_name: Option<String>,
}

#[derive(Deserialize)]
pub struct SetFillRateCmd {
    #[serde(flatten)]
    pub target: FpCmd,
    pub fill_rate_lps: f64,
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
    pub nozzle: u8,
    pub price: u32,
    pub volume: f64,
    pub amount: u64,
    pub respond: bool,
    pub fill_rate_lps: f64,
}

fn resolve_addr(disps: &[crate::dispenser::SimDispenser], cmd: &FpCmd) -> Option<u8> {
    if let Some(ref id) = cmd.fp_id {
        if !id.is_empty() {
            return disps.iter().find(|d| d.fp_id == *id).map(|d| d.addr);
        }
    }
    None
}

async fn get_state(State(disps): State<SharedDispensers>) -> Json<Vec<DispenserInfo>> {
    let mut disps = disps.lock().unwrap();
    let info = disps
        .iter_mut()
        .map(|d| {
            d.tick();
            DispenserInfo {
                fp_id: d.fp_id.clone(),
                addr: d.addr,
                label: d.label.clone(),
                status: format!("{:?}", d.status),
                nozzle: d.nozzle,
                // Registers hold wire units (1 = 10 soum); report soum outward.
                price: d.price * 10,
                volume: d.volume_cl as f64 / 100.0,
                amount: d.cost_min() * 10,
                respond: d.respond,
                fill_rate_lps: d.fill_rate,
            }
        })
        .collect();
    Json(info)
}

async fn nozzle_up(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<NozzleUpCmd>,
) -> (StatusCode, Json<ApiResponse>) {
    let target = FpCmd {
        fp_id: cmd.fp_id.clone(),
    };
    let mut disps = disps.lock().unwrap();
    let Some(addr) = resolve_addr(&disps, &target) else {
        return bad_request("fp_id required");
    };
    match disps.iter_mut().find(|d| d.addr == addr) {
        None => not_found(addr),
        // API price override arrives in soum; registers hold wire units.
        Some(d) => match d.lift_nozzle(cmd.nozzle, cmd.price.map(|p| p / 10)) {
            Ok(()) => ok(),
            Err(e) => conflict(e),
        },
    }
}

async fn nozzle_down(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<FpCmd>,
) -> (StatusCode, Json<ApiResponse>) {
    let mut disps = disps.lock().unwrap();
    let Some(addr) = resolve_addr(&disps, &cmd) else {
        return bad_request("fp_id required");
    };
    match disps.iter_mut().find(|d| d.addr == addr) {
        None => not_found(addr),
        Some(d) => match d.replace_nozzle() {
            Ok(()) => ok(),
            Err(e) => conflict(e),
        },
    }
}

async fn prepare_preauth(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<PreparePreAuthCmd>,
) -> (StatusCode, Json<ApiResponse>) {
    let target = FpCmd {
        fp_id: Some(cmd.fp_id),
    };
    let mut disps = disps.lock().unwrap();
    let Some(addr) = resolve_addr(&disps, &target) else {
        return bad_request("fp_id required");
    };
    match disps.iter_mut().find(|d| d.addr == addr) {
        None => not_found(addr),
        Some(d) => match d.lift_nozzle(Some(cmd.nozzle), None) {
            Ok(()) => ok(),
            Err(e) => conflict(e),
        },
    }
}

async fn go_offline(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<FpCmd>,
) -> Json<ApiResponse> {
    let mut disps = disps.lock().unwrap();
    if let Some(addr) = resolve_addr(&disps, &cmd) {
        if let Some(d) = disps.iter_mut().find(|d| d.addr == addr) {
            d.go_offline();
        }
    } else {
        for d in disps.iter_mut() {
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
    Json(cmd): Json<FpCmd>,
) -> Json<ApiResponse> {
    let mut disps = disps.lock().unwrap();
    if let Some(addr) = resolve_addr(&disps, &cmd) {
        if let Some(d) = disps.iter_mut().find(|d| d.addr == addr) {
            d.go_online();
        }
    } else {
        for d in disps.iter_mut() {
            d.go_online();
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
        d.force_stop();
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

async fn set_fill_rate(
    State(disps): State<SharedDispensers>,
    Json(cmd): Json<SetFillRateCmd>,
) -> (StatusCode, Json<ApiResponse>) {
    let rate = cmd.fill_rate_lps.clamp(0.0, 20.0);
    let mut disps = disps.lock().unwrap();
    let Some(addr) = resolve_addr(&disps, &cmd.target) else {
        return bad_request("fp_id required");
    };
    match disps.iter_mut().find(|d| d.addr == addr) {
        None => not_found(addr),
        Some(d) => {
            d.fill_rate = rate;
            ok()
        }
    }
}

fn ok() -> (StatusCode, Json<ApiResponse>) {
    (
        StatusCode::OK,
        Json(ApiResponse {
            ok: true,
            message: None,
        }),
    )
}

fn bad_request(msg: &str) -> (StatusCode, Json<ApiResponse>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiResponse {
            ok: false,
            message: Some(msg.into()),
        }),
    )
}

fn not_found(addr: u8) -> (StatusCode, Json<ApiResponse>) {
    (
        StatusCode::NOT_FOUND,
        Json(ApiResponse {
            ok: false,
            message: Some(format!("addr 0x{:02X} not found", addr)),
        }),
    )
}

fn conflict(e: anyhow::Error) -> (StatusCode, Json<ApiResponse>) {
    (
        StatusCode::CONFLICT,
        Json(ApiResponse {
            ok: false,
            message: Some(e.to_string()),
        }),
    )
}
