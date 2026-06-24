use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use atg::TankLevels;
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
    ResumeFillCmd, Shift, ShiftSlot, SiteSnapshot, StartShiftCmd, StopCmd, StopSource,
    TankSnapshot, Transaction, TxStatus, TxSummary, UpdateAllPricesCmd, WsEvent,
};

use crate::admin::AdminSessions;
use crate::api::admin;
use crate::api::ws::ws_upgrade;
use crate::db::{queries, shift_queries};
use crate::engine::{DispatchCommand, RuntimeFp};
use crate::shifts::ShiftCoordinator;
use crate::sync::SharedSyncStatus;

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
    pub sync_status: SharedSyncStatus,
    /// Live ATG tank levels keyed by product_id. Empty map when ATG is not configured.
    pub tank_levels: TankLevels,
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
        .route("/totals/refresh", post(refresh_totals))
        .route("/prices", post(update_prices))
        .route("/products", get(get_products))
        .route("/transactions", get(get_transactions))
        .route("/transactions/summary", get(get_transactions_summary))
        .route("/transactions/:id", get(get_transaction))
        .route("/shifts/current", get(get_current_shift))
        .route("/shifts/start", post(start_shift))
        .route("/shifts/end", post(end_shift))
        .route("/shifts/handover", post(handover_shift))
        .route("/shifts", get(list_shifts))
        .route("/shifts/:id", get(get_shift))
        .route("/shifts/:id/report", get(shift_report))
        .route("/operators", get(list_operators).post(create_operator))
        .route("/sync/status", get(get_sync_status))
        .route("/admin/sync-config", post(update_sync_config))
        .route(
            "/admin/atg-config",
            get(get_atg_config).post(update_atg_config),
        )
        .route("/admin/atg-discover", get(atg_discover))
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

fn site_snapshot(
    cfg: &SiteConfig,
    live: &std::collections::HashMap<u8, types::TankLiveLevel>,
) -> SiteSnapshot {
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
    let tanks: Vec<TankSnapshot> = cfg
        .tanks
        .iter()
        .map(|t| {
            if let Some(l) = live.get(&t.product_id) {
                TankSnapshot {
                    product_id: t.product_id,
                    label: t.label.clone(),
                    capacity_l: t.capacity_l,
                    current_l: l.current_l,
                    temperature_c: Some(l.temperature_c),
                    water_l: Some(l.water_l),
                    updated_at_ms: Some(l.updated_at_ms),
                }
            } else {
                TankSnapshot {
                    product_id: t.product_id,
                    label: t.label.clone(),
                    capacity_l: t.capacity_l,
                    current_l: t.current_l,
                    temperature_c: None,
                    water_l: None,
                    updated_at_ms: None,
                }
            }
        })
        .collect();
    SiteSnapshot {
        site_id: cfg.site.id.clone(),
        site_name: cfg.site.name.clone(),
        protocol: protocol_str(&cfg.connection.protocol),
        positions,
        products,
        tanks,
        shift_mode,
        shift_schedule,
        require_operator_pin: cfg.shifts.require_operator_pin,
        default_auth_mode: cfg.ui.default_auth_mode.clone(),
        preauth_timeout_seconds: cfg.ui.preauth_timeout_seconds,
        use_stop_mode: cfg.ui.use_stop_mode,
        use_cancel_mode: cfg.ui.use_cancel_mode,
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
                    StopSource::AppFinal => {
                        "this stop is final and cannot be resumed"
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
        StopSource::AppFinal => {
            return Err((
                StatusCode::BAD_REQUEST,
                "stop-mode fills cannot be resumed".into(),
            ));
        }
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
    pub config_path: String,
}

pub async fn health(State(st): State<AppState>) -> Json<HealthBody> {
    let site = st.cfg.read().await.site.id.clone();
    Json(HealthBody {
        status: "ok",
        site,
        uptime_s: st.started.elapsed().as_secs(),
        config_path: st.config_path.display().to_string(),
    })
}

pub async fn get_config(State(st): State<AppState>) -> Json<SiteSnapshot> {
    let cfg = st.cfg.read().await;
    let live = st.tank_levels.read().await;
    Json(site_snapshot(&cfg, &live))
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
    let Some(rt) = map.get(&byte) else {
        return Err((StatusCode::BAD_REQUEST, "lane offline".into()));
    };
    if rt.stopped_context.is_some() {
        return Err((
            StatusCode::BAD_REQUEST,
            "sale is paused — use Resume fill or Continue fill with the original transaction, not a new authorization".into(),
        ));
    }
    let lifted_nozzle = if matches!(rt.state.status, FpStatus::NozzleUp) {
        rt.state.nozzle_index
    } else {
        None
    };
    let Some(lifted_nozzle) = lifted_nozzle else {
        return Err((
            StatusCode::BAD_REQUEST,
            "reactive authorize requires NOZZLE_UP (lift nozzle first)".into(),
        ));
    };
    let nozzle_index = cmd.nozzle_index.unwrap_or(lifted_nozzle);
    if nozzle_index != lifted_nozzle {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "requested nozzle {} but lifted nozzle is {}",
                nozzle_index, lifted_nozzle
            ),
        ));
    }
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
    let price = cmd
        .price_override
        .or_else(|| rt.nozzle_prices.get(&nozzle_index).copied())
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
    let (nozzle_index, route_as_reactive) = {
        let map = st.runtimes.read().await;
        let Some(rt) = map.get(&byte) else {
            return Err((StatusCode::BAD_REQUEST, "lane offline".into()));
        };
        if rt.stopped_context.is_some() {
            return Err((
                StatusCode::BAD_REQUEST,
                "sale is paused — use Resume fill or Continue fill, not a new pre-authorization"
                    .into(),
            ));
        }
        let lifted_nozzle = if matches!(rt.state.status, FpStatus::NozzleUp) {
            rt.state.nozzle_index
        } else {
            None
        };
        let nozzle_index = if lifted_nozzle.is_some() {
            cmd.nozzle_index.ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    "nozzle was lifted while pre-authorizing; selected nozzle is required".into(),
                )
            })?
        } else {
            cmd.nozzle_index
                .or_else(|| fp.active_nozzles().first().map(|n| n.index))
                .ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        "no active nozzle for position".into(),
                    )
                })?
        };
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
        if let Some(lifted_nozzle) = lifted_nozzle {
            if nozzle_index != lifted_nozzle {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!(
                        "pre-authorize requested nozzle {} but lifted nozzle is {}",
                        nozzle_index, lifted_nozzle
                    ),
                ));
            }
            (nozzle_index, true)
        } else if matches!(rt.state.status, FpStatus::Idle) {
            (nozzle_index, false)
        } else {
            return Err((
                StatusCode::BAD_REQUEST,
                "pre-authorize requires IDLE — nozzle must be holstered before authorizing".into(),
            ));
        }
    };
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
    let command = if route_as_reactive {
        DispatchCommand::Authorize {
            byte,
            price,
            preset: cmd.preset.clone(),
        }
    } else {
        DispatchCommand::Preauthorize {
            byte,
            price,
            preset: cmd.preset.clone(),
            nozzle_index,
        }
    };
    st.commands
        .send(command)
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
    // Idempotent: if the preauth was already cleared (e.g. auto-cancelled by a
    // nozzle mismatch or timeout), the lane is already in the desired state — return
    // ok rather than a confusing 400 to the operator who just pressed Cancel.
    let cancellable = {
        let map = st.runtimes.read().await;
        map.get(&byte).is_some_and(|r| r.has_cancellable_preauth())
    };
    if cancellable {
        st.commands
            .send(DispatchCommand::CancelPreauth { byte })
            .await
            .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    }
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
    // Emit fp.done so the UI shows the dispensed amount and populates lastSale for "oxirgi quyish".
    // Must be sent before fp.status so holdDoneUntil prevents the IDLE status from clearing the DONE display.
    if let Ok(Some(tx)) = queries::get_transaction(&st.pool, &cmd.stopped_tx_id).await {
        let _ = st.events.send(WsEvent::Done(tx));
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

/// Re-read pump lifetime totalizers on demand (operator opened the totalizer view).
pub async fn refresh_totals(
    st: State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    st.commands
        .send(DispatchCommand::RefreshTotals)
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
    pub shift_id: Option<String>,
    /// Comma-separated status values, e.g. "COMPLETED,CONTINUED_FROM". Empty = all.
    pub statuses: Option<String>,
    pub from_ms: Option<i64>,
    pub until_ms: Option<i64>,
}

pub async fn get_transactions(
    State(st): State<AppState>,
    Query(q): Query<TxQuery>,
) -> Result<Json<Vec<Transaction>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let offset = q.offset.unwrap_or(0).max(0);
    let statuses_raw = q.statuses.as_deref().unwrap_or("");
    let status_vec: Vec<&str> = statuses_raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let rows = queries::list_transactions(
        &st.pool,
        limit,
        offset,
        q.fp_id.as_deref(),
        q.shift_id.as_deref(),
        &status_vec,
        q.from_ms,
        q.until_ms,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(rows))
}

pub async fn get_transactions_summary(
    State(st): State<AppState>,
    Query(q): Query<TxQuery>,
) -> Result<Json<TxSummary>, (StatusCode, String)> {
    let statuses_raw = q.statuses.as_deref().unwrap_or("");
    let status_vec: Vec<&str> = statuses_raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let summary = queries::summarize_transactions(
        &st.pool,
        q.fp_id.as_deref(),
        q.shift_id.as_deref(),
        &status_vec,
        q.from_ms,
        q.until_ms,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(summary))
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

// ── Sync status + config endpoints ───────────────────────────────────────────

pub async fn get_sync_status(State(st): State<AppState>) -> Json<crate::sync::SyncStatus> {
    Json(st.sync_status.lock().await.clone())
}

#[derive(serde::Deserialize)]
pub struct UpdateSyncConfigBody {
    pub enabled: Option<bool>,
    pub backend_url: Option<String>,
    pub api_key: Option<String>,
    pub retry_interval_secs: Option<u64>,
    pub batch_size: Option<usize>,
    pub max_retries: Option<u32>,
    pub price_pull_interval_hours: Option<u64>,
    pub price_pull_enabled: Option<bool>,
}

pub async fn update_sync_config(
    State(st): State<AppState>,
    Json(body): Json<UpdateSyncConfigBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    {
        let mut cfg = st.cfg.write().await;
        if let Some(v) = body.enabled {
            cfg.sync.enabled = v;
        }
        if let Some(v) = body.backend_url {
            cfg.sync.backend_url = v;
        }
        if let Some(v) = body.api_key {
            cfg.sync.api_key = v;
        }
        if let Some(v) = body.retry_interval_secs {
            cfg.sync.retry_interval_secs = v;
        }
        if let Some(v) = body.batch_size {
            cfg.sync.batch_size = v;
        }
        if let Some(v) = body.max_retries {
            cfg.sync.max_retries = v;
        }
        if let Some(v) = body.price_pull_interval_hours {
            cfg.sync.price_pull_interval_hours = v;
        }
        if let Some(v) = body.price_pull_enabled {
            cfg.sync.price_pull_enabled = v;
        }

        crate::config::save(&cfg, &st.config_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── ATG config ────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct AtgBranchInfo {
    id: u32,
    name: String,
    host: String,
    port: u16,
    unit_id: u8,
    start_register: u16,
    address_base: u16,
    register_count: u16,
    slots: Vec<AtgSlotInfo>,
}

#[derive(serde::Serialize)]
struct AtgSlotInfo {
    slot: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    tank_id: Option<String>,
    #[serde(rename = "type")]
    fuel_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    product_id: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capacity_l: Option<f64>,
    maxima: std::collections::HashMap<String, f64>,
}

#[derive(serde::Serialize)]
struct AtgConfigSnapshot {
    enabled: bool,
    poll_interval_secs: u64,
    modbus_timeout_secs: f64,
    api_url: String,
    auth: Option<site_config::AtgAuth>,
    branches: Vec<AtgBranchInfo>,
}

async fn get_atg_config(State(st): State<AppState>) -> Json<AtgConfigSnapshot> {
    let cfg = st.cfg.read().await;
    match &cfg.atg {
        None => Json(AtgConfigSnapshot {
            enabled: false,
            poll_interval_secs: 300,
            modbus_timeout_secs: 10.0,
            api_url: String::new(),
            auth: None,
            branches: vec![],
        }),
        Some(atg) => Json(AtgConfigSnapshot {
            enabled: true,
            poll_interval_secs: atg.poll_interval_secs,
            modbus_timeout_secs: atg.modbus_timeout_secs,
            api_url: atg.api_url.clone(),
            auth: atg.auth.clone(),
            branches: atg
                .branches
                .iter()
                .map(|b| AtgBranchInfo {
                    id: b.id,
                    name: b.name.clone(),
                    host: b.host.clone(),
                    port: b.port,
                    unit_id: b.unit_id,
                    start_register: b.start_register,
                    address_base: b.address_base,
                    register_count: b.register_count,
                    slots: b
                        .slots
                        .iter()
                        .map(|s| AtgSlotInfo {
                            slot: s.slot,
                            tank_id: s.tank_id.clone(),
                            fuel_type: s.fuel_type.clone(),
                            product_id: s.product_id,
                            label: s.label.clone(),
                            capacity_l: s.capacity_l,
                            maxima: s.maxima.clone(),
                        })
                        .collect(),
                })
                .collect(),
        }),
    }
}

#[derive(serde::Deserialize)]
pub struct UpdateAtgConfigBody {
    pub poll_interval_secs: Option<u64>,
    pub modbus_timeout_secs: Option<f64>,
    pub api_url: Option<String>,
    pub auth: Option<site_config::AtgAuth>,
    pub branches: Option<Vec<site_config::AtgBranch>>,
}

async fn update_atg_config(
    State(st): State<AppState>,
    Json(body): Json<UpdateAtgConfigBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let snapshot = {
        let cfg = st.cfg.read().await;
        let mut snapshot = cfg.clone();
        if let Some(ref mut atg) = snapshot.atg {
            if let Some(v) = body.poll_interval_secs {
                atg.poll_interval_secs = v;
            }
            if let Some(v) = body.modbus_timeout_secs {
                atg.modbus_timeout_secs = v;
            }
            if let Some(v) = body.api_url {
                atg.api_url = v;
            }
            if let Some(v) = body.auth {
                atg.auth = Some(v);
            }
            if let Some(v) = body.branches {
                atg.branches = v;
            }
        }
        snapshot
            .validate()
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        snapshot
    };

    crate::config::save(&snapshot, &st.config_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    {
        let mut cfg = st.cfg.write().await;
        *cfg = snapshot;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── ATG network discovery ─────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct DiscoverQuery {
    /// Modbus TCP port to probe. Defaults to first configured ATG branch or 6400.
    port: Option<u16>,
    /// Connect timeout per host in milliseconds. Defaults to 600.
    timeout_ms: Option<u64>,
    /// Modbus unit id to use when decoding discovered tanks.
    unit_id: Option<u8>,
    /// First holding register in human/vendor numbering.
    start_register: Option<u16>,
    /// Register numbering base, usually 0 or 1.
    address_base: Option<u16>,
    /// Number of 16-bit registers to read.
    register_count: Option<u16>,
}

fn local_ipv4() -> Option<std::net::Ipv4Addr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(v4) => Some(v4),
        _ => None,
    }
}

#[derive(serde::Serialize)]
struct DiscoverResult {
    subnet: String,
    port: u16,
    found: Vec<String>,
    devices: Vec<DiscoveredAtgDevice>,
}

#[derive(serde::Serialize)]
struct DiscoveredAtgDevice {
    host: String,
    tanks: Vec<atg::DiscoveredTankSlot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn atg_discover(
    State(st): State<AppState>,
    Query(params): Query<DiscoverQuery>,
) -> Result<Json<DiscoverResult>, (StatusCode, String)> {
    let local = local_ipv4().ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine local IP".into(),
        )
    })?;

    let octets = local.octets();
    let subnet = format!("{}.{}.{}", octets[0], octets[1], octets[2]);
    let (configured, configured_host) = {
        let cfg = st.cfg.read().await;
        match cfg.atg.as_ref().and_then(|atg| {
            atg.branches.first().map(|branch| {
                (
                    (
                        branch.port,
                        branch.unit_id,
                        branch.start_register,
                        branch.address_base,
                        branch.register_count,
                        atg.modbus_timeout_secs,
                    ),
                    branch.host.clone(),
                )
            })
        }) {
            Some((cfg, host)) => (Some(cfg), Some(host)),
            None => (None, None),
        }
    };
    let port = params
        .port
        .or_else(|| configured.map(|c| c.0))
        .unwrap_or(6400);
    let unit_id = params
        .unit_id
        .or_else(|| configured.map(|c| c.1))
        .unwrap_or(1);
    let start_register = params
        .start_register
        .or_else(|| configured.map(|c| c.2))
        .unwrap_or(1000);
    let address_base = params
        .address_base
        .or_else(|| configured.map(|c| c.3))
        .unwrap_or(1);
    let register_count = params
        .register_count
        .or_else(|| configured.map(|c| c.4))
        .unwrap_or(48);
    let scan_timeout = Duration::from_millis(params.timeout_ms.unwrap_or(600));
    let probe_timeout = configured
        .map(|c| Duration::from_secs_f64(c.5.max(0.1)))
        .unwrap_or(scan_timeout);

    // If the configured branch host is on a different subnet than the local default-route
    // interface, include that subnet in the scan. This is the common case when the server
    // routes internet traffic via a VPN/WAN interface but the ATG device is on a local LAN.
    let extra_subnet: Option<String> = configured_host
        .as_deref()
        .and_then(|h| h.parse::<std::net::Ipv4Addr>().ok())
        .map(|ip| {
            let o = ip.octets();
            format!("{}.{}.{}", o[0], o[1], o[2])
        })
        .filter(|s| s != &subnet);

    let subnets_to_scan: Vec<String> = std::iter::once(subnet.clone())
        .chain(extra_subnet)
        .collect();

    let mut handles = Vec::with_capacity(subnets_to_scan.len() * 254);
    for sn in &subnets_to_scan {
        for host in 1u8..=254 {
            let addr = format!("{}.{}:{}", sn, host, port);
            let sn_clone = sn.clone();
            handles.push(tokio::spawn(async move {
                match tokio::time::timeout(scan_timeout, tokio::net::TcpStream::connect(&addr))
                    .await
                {
                    Ok(Ok(_)) => Some(format!("{}.{}", sn_clone, host)),
                    _ => None,
                }
            }));
        }
    }

    let mut found = Vec::new();
    for h in handles {
        if let Ok(Some(ip)) = h.await {
            found.push(ip);
        }
    }
    found.sort();
    found.dedup();

    let mut probe_handles = Vec::with_capacity(found.len());
    for host in &found {
        let host = host.clone();
        probe_handles.push(tokio::spawn(async move {
            match atg::discover_host_tanks(
                &host,
                port,
                unit_id,
                start_register,
                address_base,
                register_count,
                probe_timeout,
            )
            .await
            {
                Ok(tanks) => DiscoveredAtgDevice {
                    host,
                    tanks,
                    error: None,
                },
                Err(e) => DiscoveredAtgDevice {
                    host,
                    tanks: Vec::new(),
                    error: Some(e.to_string()),
                },
            }
        }));
    }

    let mut devices = Vec::with_capacity(probe_handles.len());
    for h in probe_handles {
        if let Ok(device) = h.await {
            devices.push(device);
        }
    }
    devices.sort_by(|a, b| a.host.cmp(&b.host));

    Ok(Json(DiscoverResult {
        subnet,
        port,
        found,
        devices,
    }))
}
