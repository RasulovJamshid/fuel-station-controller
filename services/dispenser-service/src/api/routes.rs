use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use site_config::ShiftMode;
use site_config::{FuelingPositionConfig, Protocol, SiteConfig};
use sqlx::SqlitePool;
use tokio::sync::{broadcast, mpsc, RwLock};
use tower_http::trace::TraceLayer;
use types::{
    AuthorizeCmd, CloseStoppedTxCmd, ContinueFillCmd, CreateOperatorCmd, EndShiftCmd, FpSnapshot,
    FpState, FpStatus, HandoverCmd, NozzleSnapshot, Operator, Preset, ProductSnapshot,
    ResumeFillCmd, Shift, ShiftSlot, SiteSnapshot, StartShiftCmd, StopCmd, StopSource, Transaction,
    TxStatus, UpdateAllPricesCmd, WsEvent,
};

use crate::admin::AdminSessions;
use crate::api::admin;
use crate::api::ws::ws_upgrade;
use crate::db::{queries, shift_queries};
use crate::engine::{DispatchCommand, RuntimeFp};
use crate::shifts::ShiftCoordinator;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<RwLock<SiteConfig>>,
    pub config_path: PathBuf,
    pub runtimes: Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    pub events: broadcast::Sender<WsEvent>,
    pub commands: mpsc::Sender<DispatchCommand>,
    pub pool: SqlitePool,
    pub shifts: Arc<ShiftCoordinator>,
    pub admin_sessions: AdminSessions,
    pub started: Instant,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/config", get(get_config))
        .route("/status", get(get_status))
        .route("/status/:fp_id", get(get_status_one))
        .route("/authorize", post(authorize))
        .route("/dispenser/:fp_id/preauthorize", post(preauthorize))
        .route("/dispenser/:fp_id/cancel-preauth", post(cancel_preauth))
        .route("/dispenser/:fp_id/continue", post(continue_fill))
        .route("/dispenser/:fp_id/resume", post(resume_fill))
        .route("/dispenser/:fp_id/close", post(close_stopped_tx))
        .route("/dispenser/:fp_id/dismiss", post(dismiss_lane))
        .route("/stop", post(stop))
        .route("/estop", post(emergency_stop))
        .route("/emergency-stop", post(estop_alias))
        .route("/reset", post(reset_all))
        .route("/prices", post(update_prices))
        .route("/products", get(get_products))
        .route("/transactions", get(get_transactions))
        .route("/transactions/:id", get(get_transaction))
        .route("/shifts/current", get(get_current_shift))
        .route("/shifts/start", post(start_shift))
        .route("/shifts/end", post(end_shift))
        .route("/shifts/handover", post(handover_shift))
        .route("/shifts", get(list_shifts))
        .route("/shifts/:id", get(get_shift))
        .route("/shifts/:id/report", get(shift_report))
        .route("/operators", get(list_operators).post(create_operator))
        .route("/ws", get(ws_handler))
        .merge(admin::router())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn ws_handler(ws: WebSocketUpgrade, State(st): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_upgrade(socket, st))
}

fn price_from_cfg(st: &AppState, byte: u8, nozzle_index: u8) -> Option<u32> {
    // Blocking read for use inside sync closures — callers are already in async handlers
    // but or_else closures cannot await; price lookup is in-memory.
    st.cfg
        .try_read()
        .ok()
        .and_then(|cfg| cfg.price_for(byte, nozzle_index))
}

async fn fp_config(
    st: &AppState,
    fp_id: &str,
) -> Result<FuelingPositionConfig, (StatusCode, String)> {
    st.cfg
        .read()
        .await
        .position_by_id(fp_id)
        .cloned()
        .ok_or_else(|| (StatusCode::BAD_REQUEST, format!("unknown fp_id {fp_id}")))
}

fn protocol_str(p: &Protocol) -> String {
    serde_json::to_value(p)
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| format!("{p:?}"))
}

fn site_snapshot(cfg: &SiteConfig) -> SiteSnapshot {
    let positions: Vec<FpSnapshot> = cfg
        .fueling_positions
        .iter()
        .map(|fp| {
            let nozzles: Vec<NozzleSnapshot> = fp
                .nozzles
                .iter()
                .map(|n| {
                    let pr = cfg.product(n.product_id);
                    NozzleSnapshot {
                        index: n.index,
                        product_id: n.product_id,
                        product_name: pr.map(|p| p.name.clone()).unwrap_or_default(),
                        product_color: pr.map(|p| p.color.clone()).unwrap_or_default(),
                        price: n.price,
                        active: n.active,
                    }
                })
                .collect();
            FpSnapshot {
                fp_id: fp.id.clone(),
                label: fp.label.clone(),
                address_byte: fp.address_byte,
                active: fp.active,
                nozzles,
            }
        })
        .collect();
    let products: Vec<ProductSnapshot> = cfg
        .products
        .iter()
        .map(|p| ProductSnapshot {
            id: p.id,
            name: p.name.clone(),
            color: p.color.clone(),
            unit: p.unit.clone(),
        })
        .collect();
    let shift_mode = match cfg.shifts.mode {
        ShiftMode::Disabled => "disabled",
        ShiftMode::Manual => "manual",
        ShiftMode::Scheduled => "scheduled",
    }
    .to_string();
    let shift_schedule: Vec<ShiftSlot> = cfg
        .shifts
        .scheduled
        .iter()
        .map(|s| ShiftSlot {
            name: s.name.clone(),
            start: s.start.clone(),
            end: s.end.clone(),
        })
        .collect();
    SiteSnapshot {
        site_id: cfg.site.id.clone(),
        site_name: cfg.site.name.clone(),
        protocol: protocol_str(&cfg.connection.protocol),
        positions,
        products,
        shift_mode,
        shift_schedule,
        require_operator_pin: cfg.shifts.require_operator_pin,
        default_auth_mode: cfg.ui.default_auth_mode.clone(),
        preauth_timeout_seconds: cfg.ui.preauth_timeout_seconds,
    }
}

/// Ensure `stopped_context` exists, loading from DB after restart if needed.
async fn ensure_stopped_context(
    rt: &mut RuntimeFp,
    fp_id: &str,
    stopped_tx_id: &str,
    pool: &SqlitePool,
    require_source: Option<StopSource>,
) -> Result<(), String> {
    if let Some(sc) = rt.stopped_context.as_ref() {
        if sc.stopped_tx_id != stopped_tx_id {
            return Err("stopped_tx_id does not match this lane".into());
        }
        if let Some(req) = require_source {
            if sc.stop_source != req {
                return Err(match req {
                    StopSource::App => {
                        "this pause was not caused by the app; use continue after lifting the nozzle"
                            .into()
                    }
                    StopSource::External => {
                        "this pause was caused by the app; use resume while the hose is still in the tank"
                            .into()
                    }
                });
            }
        }
        return Ok(());
    }
    let tx = queries::get_transaction(pool, stopped_tx_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("transaction {stopped_tx_id} not found"))?;
    if tx.fp_id != fp_id {
        return Err("transaction belongs to another fueling position".into());
    }
    if !matches!(tx.status, TxStatus::Stopped) {
        return Err(format!(
            "transaction is not STOPPED (already finalized or continued)"
        ));
    }
    let preset = rt.last_preset.clone();
    let source = require_source.unwrap_or(StopSource::App);
    rt.rehydrate_stopped_context(&tx, preset, source);
    if let Some(req) = require_source {
        if let Some(sc) = rt.stopped_context.as_ref() {
            if sc.stop_source != req {
                return Err("stop source mismatch for this transaction".into());
            }
        }
    }
    Ok(())
}

async fn dispatch_resume_or_continue(
    st: &AppState,
    fp_id: &str,
    stopped_tx_id: &str,
    require_source: StopSource,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let fp = fp_config(st, fp_id).await?;
    let byte = fp.address_byte;
    let preset = {
        let mut map = st.runtimes.write().await;
        let Some(rt) = map.get_mut(&byte) else {
            return Err((StatusCode::BAD_REQUEST, "lane offline".into()));
        };
        ensure_stopped_context(rt, fp_id, stopped_tx_id, &st.pool, Some(require_source))
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
        rt.prepare_continue(stopped_tx_id)
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?
    };
    let (_nozzle_index, price) = {
        let map = st.runtimes.read().await;
        let Some(rt) = map.get(&byte) else {
            return Err((StatusCode::BAD_REQUEST, "lane offline".into()));
        };
        let nozzle_index = rt
            .state
            .nozzle_index
            .or_else(|| rt.stopped_context.as_ref().map(|s| s.nozzle_index))
            .or_else(|| fp.active_nozzles().first().map(|n| n.index))
            .unwrap_or(1);
        let price = if rt.stopped_context.is_some() || rt.state.price > 0 {
            rt.state.price
        } else {
            rt.nozzle_prices
                .get(&nozzle_index)
                .copied()
                .or_else(|| price_from_cfg(&st, byte, nozzle_index))
                .ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        "could not resolve price for nozzle".into(),
                    )
                })?
        };
        (nozzle_index, price)
    };
    let cmd = match require_source {
        StopSource::App => DispatchCommand::ResumeFill {
            byte,
            price,
            preset,
        },
        StopSource::External => DispatchCommand::ContinueFill {
            byte,
            price,
            preset,
        },
    };
    st.commands
        .send(cmd)
        .await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    if let Some(s) = st.runtimes.read().await.get(&byte).map(|r| r.state.clone()) {
        let _ = st.events.send(WsEvent::Status(s));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn validate_preset(preset: &Preset) -> Result<(), (StatusCode, String)> {
    match preset {
        Preset::Str(s) if s.eq_ignore_ascii_case("full") => Ok(()),
        Preset::Str(_) => Err((
            StatusCode::BAD_REQUEST,
            "preset string must be \"full\" (use a JSON number for volume or amount)".into(),
        )),
        Preset::Volume(v) => {
            if *v <= 0.0 || *v > 10_000.0 {
                Err((
                    StatusCode::BAD_REQUEST,
                    "volume preset must be in (0, 10000] litres".into(),
                ))
            } else {
                Ok(())
            }
        }
        Preset::Amount(a) => {
            if *a == 0 || *a > 500_000_000_000 {
                Err((
                    StatusCode::BAD_REQUEST,
                    "amount preset must be a positive sum (minor units) within limits".into(),
                ))
            } else {
                Ok(())
            }
        }
    }
}

async fn get_current_shift(State(st): State<AppState>) -> Json<Option<Shift>> {
    Json(st.shifts.current().await)
}

async fn start_shift(
    State(st): State<AppState>,
    Json(cmd): Json<StartShiftCmd>,
) -> Result<Json<Shift>, (StatusCode, String)> {
    let shift = st
        .shifts
        .start(cmd)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let _ = st.events.send(WsEvent::ShiftStarted(shift.clone()));
    Ok(Json(shift))
}

async fn end_shift(
    State(st): State<AppState>,
    Json(cmd): Json<EndShiftCmd>,
) -> Result<Json<Shift>, (StatusCode, String)> {
    let shift = st
        .shifts
        .end(cmd)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let _ = st.events.send(WsEvent::ShiftEnded(shift.clone()));
    Ok(Json(shift))
}

async fn handover_shift(
    State(st): State<AppState>,
    Json(cmd): Json<HandoverCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (outgoing, incoming) = st
        .shifts
        .handover(cmd)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let _ = st.events.send(WsEvent::ShiftHandover {
        outgoing: outgoing.clone(),
        incoming: incoming.clone(),
    });
    Ok(Json(serde_json::json!({
        "outgoing": outgoing,
        "incoming": incoming,
    })))
}

#[derive(serde::Deserialize)]
pub struct ShiftListParams {
    pub status: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

async fn list_shifts(
    State(st): State<AppState>,
    Query(q): Query<ShiftListParams>,
) -> Result<Json<Vec<Shift>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(20).clamp(1, 500);
    let offset = q.offset.unwrap_or(0).max(0);
    let rows = shift_queries::list_shifts(&st.pool, limit, offset, q.status.as_deref())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(rows))
}

async fn get_shift(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Shift>, StatusCode> {
    shift_queries::get_shift(&st.pool, &id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

async fn shift_report(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Shift>, StatusCode> {
    shift_queries::get_shift(&st.pool, &id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

async fn list_operators(
    State(st): State<AppState>,
) -> Result<Json<Vec<Operator>>, (StatusCode, String)> {
    let rows = shift_queries::list_operators(&st.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(rows))
}

async fn create_operator(
    State(st): State<AppState>,
    Json(cmd): Json<CreateOperatorCmd>,
) -> Result<Json<Operator>, (StatusCode, String)> {
    let op = shift_queries::insert_operator_stub(&st.pool, &cmd)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(op))
}

#[derive(Serialize)]
pub struct HealthBody {
    pub status: &'static str,
    pub site: String,
    pub uptime_s: u64,
}

pub async fn health(State(st): State<AppState>) -> Json<HealthBody> {
    let site = st.cfg.read().await.site.id.clone();
    Json(HealthBody {
        status: "ok",
        site,
        uptime_s: st.started.elapsed().as_secs(),
    })
}

pub async fn get_config(State(st): State<AppState>) -> Json<SiteSnapshot> {
    let cfg = st.cfg.read().await;
    Json(site_snapshot(&cfg))
}

pub async fn get_status(State(st): State<AppState>) -> Json<Vec<FpState>> {
    let map = st.runtimes.read().await;
    let mut v: Vec<FpState> = map.values().map(|r| r.snapshot_state()).collect();
    v.sort_by(|a, b| a.fp_id.cmp(&b.fp_id));
    Json(v)
}

pub async fn get_status_one(
    State(st): State<AppState>,
    Path(fp_id): Path<String>,
) -> Result<Json<FpState>, StatusCode> {
    let map = st.runtimes.read().await;
    for r in map.values() {
        if r.state.fp_id == fp_id {
            return Ok(Json(r.snapshot_state()));
        }
    }
    Err(StatusCode::NOT_FOUND)
}

pub async fn get_products(State(st): State<AppState>) -> Json<Vec<ProductSnapshot>> {
    let cfg = st.cfg.read().await;
    let v: Vec<ProductSnapshot> = cfg
        .products
        .iter()
        .map(|p| ProductSnapshot {
            id: p.id,
            name: p.name.clone(),
            color: p.color.clone(),
            unit: p.unit.clone(),
        })
        .collect();
    Json(v)
}

pub async fn authorize(
    State(st): State<AppState>,
    Json(cmd): Json<AuthorizeCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let fp = fp_config(&st, &cmd.fp_id).await?;
    let nozzle_index = cmd
        .nozzle_index
        .or_else(|| fp.active_nozzles().first().map(|n| n.index))
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "no active nozzle for position".into(),
            )
        })?;
    if !fp
        .nozzles
        .iter()
        .any(|n| n.index == nozzle_index && n.active)
    {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("nozzle {} not active on {}", nozzle_index, cmd.fp_id),
        ));
    }
    validate_preset(&cmd.preset)?;
    if let Some(p) = cmd.price_override {
        if p == 0 {
            return Err((
                StatusCode::BAD_REQUEST,
                "price_override must be greater than zero".into(),
            ));
        }
    }
    let byte = fp.address_byte;
    let map = st.runtimes.read().await;
    if map.get(&byte).is_some_and(|r| r.stopped_context.is_some()) {
        return Err((
            StatusCode::BAD_REQUEST,
            "sale is paused — use Resume fill or Continue fill with the original transaction, not a new authorization".into(),
        ));
    }
    let is_nozzle_up = map
        .get(&byte)
        .is_some_and(|r| matches!(r.state.status, FpStatus::NozzleUp));
    if !is_nozzle_up {
        return Err((
            StatusCode::BAD_REQUEST,
            "reactive authorize requires NOZZLE_UP (lift nozzle first)".into(),
        ));
    }
    let price = cmd
        .price_override
        .or_else(|| {
            map.get(&byte)
                .and_then(|r| r.nozzle_prices.get(&nozzle_index).copied())
        })
        .or_else(|| price_from_cfg(&st, byte, nozzle_index))
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "could not resolve price for nozzle".into(),
            )
        })?;
    drop(map);
    st.commands
        .send(DispatchCommand::Authorize {
            byte,
            price,
            preset: cmd.preset.clone(),
        })
        .await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn preauthorize(
    State(st): State<AppState>,
    Path(fp_id): Path<String>,
    Json(cmd): Json<AuthorizeCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if cmd.fp_id != fp_id {
        return Err((
            StatusCode::BAD_REQUEST,
            "fp_id in body must match path".into(),
        ));
    }
    let fp = fp_config(&st, &fp_id).await?;
    let nozzle_index = cmd
        .nozzle_index
        .or_else(|| fp.active_nozzles().first().map(|n| n.index))
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "no active nozzle for position".into(),
            )
        })?;
    if !fp
        .nozzles
        .iter()
        .any(|n| n.index == nozzle_index && n.active)
    {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("nozzle {} not active on {}", nozzle_index, fp_id),
        ));
    }
    validate_preset(&cmd.preset)?;
    if let Some(p) = cmd.price_override {
        if p == 0 {
            return Err((
                StatusCode::BAD_REQUEST,
                "price_override must be greater than zero".into(),
            ));
        }
    }
    let byte = fp.address_byte;
    {
        let map = st.runtimes.read().await;
        if map.get(&byte).is_some_and(|r| r.stopped_context.is_some()) {
            return Err((
                StatusCode::BAD_REQUEST,
                "sale is paused — use Resume fill or Continue fill, not a new pre-authorization"
                    .into(),
            ));
        }
        let preauth_ok = map.get(&byte).is_some_and(|r| {
            match r.state.status {
                FpStatus::Idle => true,
                FpStatus::NozzleUp => r.state.nozzle_index == Some(nozzle_index),
                _ => false,
            }
        });
        if !preauth_ok {
            return Err((
                StatusCode::BAD_REQUEST,
                "pre-authorize requires IDLE (holstered) or NOZZLE_UP on the selected nozzle"
                    .into(),
            ));
        }
    }
    let price = {
        let map = st.runtimes.read().await;
        cmd.price_override
            .or_else(|| {
                map.get(&byte)
                    .and_then(|r| r.nozzle_prices.get(&nozzle_index).copied())
            })
            .or_else(|| price_from_cfg(&st, byte, nozzle_index))
            .ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    "could not resolve price for nozzle".into(),
                )
            })?
    };
    st.commands
        .send(DispatchCommand::Preauthorize {
            byte,
            price,
            preset: cmd.preset.clone(),
            nozzle_index,
        })
        .await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn cancel_preauth(
    State(st): State<AppState>,
    Path(fp_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let fp = fp_config(&st, &fp_id).await?;
    let byte = fp.address_byte;
    {
        let map = st.runtimes.read().await;
        let cancellable = map.get(&byte).is_some_and(|r| r.has_cancellable_preauth());
        if !cancellable {
            return Err((StatusCode::BAD_REQUEST, "lane is not pre-authorized".into()));
        }
    }
    st.commands
        .send(DispatchCommand::CancelPreauth { byte })
        .await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn continue_fill(
    State(st): State<AppState>,
    Path(fp_id): Path<String>,
    Json(cmd): Json<ContinueFillCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    dispatch_resume_or_continue(&st, &fp_id, &cmd.stopped_tx_id, StopSource::External).await
}

pub async fn resume_fill(
    State(st): State<AppState>,
    Path(fp_id): Path<String>,
    Json(cmd): Json<ResumeFillCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    dispatch_resume_or_continue(&st, &fp_id, &cmd.stopped_tx_id, StopSource::App).await
}

pub async fn close_stopped_tx(
    State(st): State<AppState>,
    Path(fp_id): Path<String>,
    Json(cmd): Json<CloseStoppedTxCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let fp = fp_config(&st, &fp_id).await?;
    let byte = fp.address_byte;
    {
        let mut map = st.runtimes.write().await;
        let Some(rt) = map.get_mut(&byte) else {
            return Err((StatusCode::BAD_REQUEST, "lane offline".into()));
        };
        ensure_stopped_context(rt, &fp_id, &cmd.stopped_tx_id, &st.pool, None)
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
        rt.close_stopped(&cmd.stopped_tx_id)
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    }
    let updated = queries::finalize_stopped_transaction(&st.pool, &cmd.stopped_tx_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if !updated {
        return Err((
            StatusCode::BAD_REQUEST,
            "transaction not found or not in STOPPED status".into(),
        ));
    }
    let states: Vec<FpState> = {
        let map = st.runtimes.read().await;
        map.values().map(|r| r.state.clone()).collect()
    };
    for s in states {
        let _ = st.events.send(WsEvent::Status(s));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn stop(
    State(st): State<AppState>,
    Json(cmd): Json<StopCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let fp = fp_config(&st, &cmd.fp_id).await?;
    let byte = fp.address_byte;
    st.commands
        .send(DispatchCommand::Stop { byte })
        .await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn emergency_stop(
    st: State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    st.commands
        .send(DispatchCommand::EStop)
        .await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn estop_alias(
    st: State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    emergency_stop(st).await
}

/// Operator finished reviewing a completed sale — idle the lane for the next customer.
pub async fn dismiss_lane(
    State(st): State<AppState>,
    Path(fp_id): Path<String>,
) -> Result<Json<FpState>, (StatusCode, String)> {
    let fp = fp_config(&st, &fp_id).await?;
    st.commands
        .send(DispatchCommand::ResetLane {
            byte: fp.address_byte,
        })
        .await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    let map = st.runtimes.read().await;
    let snap = map
        .get(&fp.address_byte)
        .map(|r| r.snapshot_state())
        .ok_or((StatusCode::BAD_REQUEST, "lane offline".into()))?;
    Ok(Json(snap))
}

/// Clear all lane runtimes to idle (after E-stop or stuck state). Does not write transaction rows.
pub async fn reset_all(
    st: State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    st.commands
        .send(DispatchCommand::ResetAll)
        .await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn update_prices(
    State(st): State<AppState>,
    Json(cmd): Json<UpdateAllPricesCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let n = cmd.updates.len();
    st.commands
        .send(DispatchCommand::UpdatePrices {
            updates: cmd.updates,
            changed_by: "operator_api".into(),
        })
        .await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true, "updated": n })))
}

#[derive(serde::Deserialize)]
pub struct TxQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub fp_id: Option<String>,
    pub status: Option<String>,
}

pub async fn get_transactions(
    State(st): State<AppState>,
    Query(q): Query<TxQuery>,
) -> Result<Json<Vec<Transaction>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let offset = q.offset.unwrap_or(0).max(0);
    let rows = queries::list_transactions(
        &st.pool,
        limit,
        offset,
        q.fp_id.as_deref(),
        q.status.as_deref(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(rows))
}

pub async fn get_transaction(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Transaction>, StatusCode> {
    let row = queries::get_transaction(&st.pool, &id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    row.map(Json).ok_or(StatusCode::NOT_FOUND)
}
