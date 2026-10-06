//! Forecourt operations API: fuel deliveries, wetstock reconciliation, and
//! future-dated price changes.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use types::{
    CreateDeliveryCmd, CreateScheduledPriceCmd, FuelDelivery, ReconcileCmd, ScheduledPrice,
    ScheduledPriceStatus, WetstockReconciliation,
};
use uuid::Uuid;

use crate::api::admin::require_admin;
use crate::api::routes::AppState;
use crate::db::price_schedule_queries as sched;
use crate::db::wetstock_queries as wetstock;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/deliveries", get(list_deliveries).post(create_delivery))
        .route("/deliveries/:id", get(get_delivery))
        .route("/wetstock/preview", get(preview_reconciliation))
        .route("/wetstock/reconcile", post(reconcile))
        .route("/wetstock/reconciliations", get(list_reconciliations))
        .route(
            "/admin/prices/schedule",
            get(list_scheduled).post(create_scheduled),
        )
        .route(
            "/admin/prices/schedule/:id",
            axum::routing::delete(cancel_scheduled),
        )
}

fn internal<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

fn bad<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, e.to_string())
}

// ── Deliveries ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DeliveryQuery {
    pub tank_id: Option<String>,
    pub product_id: Option<u8>,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    pub limit: Option<i64>,
}

async fn list_deliveries(
    State(st): State<AppState>,
    Query(q): Query<DeliveryQuery>,
) -> Result<Json<Vec<FuelDelivery>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    wetstock::list_deliveries(
        &st.pool,
        q.product_id,
        q.from_ms,
        q.to_ms,
        limit,
        q.tank_id.as_deref(),
    )
    .await
    .map(Json)
    .map_err(internal)
}

async fn get_delivery(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<FuelDelivery>, (StatusCode, String)> {
    wetstock::get_delivery(&st.pool, &id)
        .await
        .map_err(internal)?
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "delivery not found".into()))
}

async fn create_delivery(
    State(st): State<AppState>,
    Json(cmd): Json<CreateDeliveryCmd>,
) -> Result<Json<FuelDelivery>, (StatusCode, String)> {
    if !cmd.delivered_l.is_finite() || cmd.delivered_l <= 0.0 {
        return Err(bad("delivered_l must be greater than zero"));
    }
    let (product_name, tank_label, tank_id) = {
        let cfg = st.cfg.read().await;
        let product = cfg.product(cmd.product_id).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                format!("unknown product_id {}", cmd.product_id),
            )
        })?;
        let tanks: Vec<_> = cfg
            .tanks
            .iter()
            .filter(|t| {
                t.product_id == cmd.product_id
                    && cmd.tank_id.as_ref().is_none_or(|id| t.id() == *id)
            })
            .collect();
        if tanks.len() != 1 {
            return Err(bad("Select the physical tank_id receiving this delivery"));
        }
        let tank = tanks[0];
        for volume in [cmd.tank_before_l, cmd.tank_after_l].into_iter().flatten() {
            if !volume.is_finite() || volume < 0.0 || volume > tank.capacity_l {
                return Err(bad(
                    "Delivery tank measurements exceed capacity or are invalid",
                ));
            }
        }
        (product.name.clone(), tank.label.clone(), Some(tank.id()))
    };
    let (shift_id, operator_name) = st.shifts.active_info().await;
    let now = chrono::Utc::now().timestamp_millis();
    let delivered_at = cmd.delivered_at.unwrap_or(now);

    // A delivery dated in the future would land after the next reconciliation's
    // period end and silently vanish from the book.
    if delivered_at > now + 60_000 {
        return Err(bad("delivered_at cannot be in the future"));
    }

    let delivery = FuelDelivery {
        tank_id,
        id: Uuid::new_v4().to_string(),
        product_id: cmd.product_id,
        product_name,
        tank_label,
        delivered_at,
        document_ref: cmd.document_ref.clone(),
        supplier: cmd.supplier.clone(),
        ordered_l: cmd.ordered_l,
        delivered_l: cmd.delivered_l,
        tank_before_l: cmd.tank_before_l,
        tank_after_l: cmd.tank_after_l,
        variance_l: match (cmd.tank_before_l, cmd.tank_after_l) {
            (Some(b), Some(a)) => Some((a - b) - cmd.delivered_l),
            _ => None,
        },
        temperature_c: cmd.temperature_c,
        price_per_l: cmd.price_per_l,
        shift_id,
        operator_name,
        notes: cmd.notes.clone(),
        created_at: now,
    };
    wetstock::insert_delivery(&st.pool, &delivery)
        .await
        .map_err(bad)?;
    tracing::info!(
        id = %delivery.id,
        product = %delivery.product_name,
        litres = delivery.delivered_l,
        "fuel delivery recorded"
    );
    Ok(Json(delivery))
}

// ── Wetstock reconciliation ───────────────────────────────────────────────

/// Build the per-tank inputs that only config and the live ATG map can supply.
async fn tank_contexts(
    st: &AppState,
    product_id: Option<u8>,
    tank_id: Option<&str>,
) -> Result<Vec<wetstock::TankContext>, (StatusCode, String)> {
    let cfg = st.cfg.read().await;
    let levels = st.tank_levels.read().await;
    let snapshots = atg::snapshots(&cfg, &levels, chrono::Utc::now().timestamp_millis());
    let mut groups: std::collections::BTreeMap<u8, Vec<&site_config::TankConfig>> =
        std::collections::BTreeMap::new();
    for tank in &cfg.tanks {
        if product_id.is_none_or(|p| p == tank.product_id)
            && tank_id.is_none_or(|id| id == tank.id())
        {
            groups.entry(tank.product_id).or_default().push(tank);
        }
    }
    if groups.is_empty() {
        return Err(bad("No matching tank configured"));
    }
    groups.into_iter().map(|(pid,tanks)| {
        let source= tanks[0];
        if tank_id.is_some() && cfg.tanks.iter().filter(|t|t.product_id==pid).count()>1 && source.nozzle_sources.is_empty() {
            return Err(bad("Per-tank reconciliation requires nozzle_sources for products stored in multiple tanks; omit tank_id for a combined product balance"));
        }
        let readings:Option<Vec<f64>>=tanks.iter().map(|t| snapshots.iter().find(|s|s.tank_id==t.id() && s.reading_status=="fresh").map(|s|s.current_l)).collect();
        Ok(wetstock::TankContext { tank_id:tank_id.map(str::to_string),
            nozzle_sources:if tank_id.is_some() { source.nozzle_sources.clone() } else { vec![] },
            product_id:pid,product_name:cfg.product(pid).map(|p|p.name.clone()).unwrap_or_default(),
            tank_label:if tanks.len()==1 {source.label.clone()} else {format!("{} tanks / product {}",tanks.len(),pid)},
            measured_l:readings.map(|r|r.iter().sum()),configured_opening_l:tanks.iter().map(|t|t.current_l).sum() })
    }).collect()
}

#[derive(Debug, Deserialize)]
pub struct ReconcileQuery {
    pub tank_id: Option<String>,
    pub product_id: Option<u8>,
    pub period_start: Option<i64>,
}

/// Compute reconciliation without recording it — lets an operator see the variance
/// before committing a closing figure that anchors the next period.
async fn preview_reconciliation(
    State(st): State<AppState>,
    Query(q): Query<ReconcileQuery>,
) -> Result<Json<Vec<WetstockReconciliation>>, (StatusCode, String)> {
    let contexts = tank_contexts(&st, q.product_id, q.tank_id.as_deref()).await?;
    let now = chrono::Utc::now().timestamp_millis();
    let (shift_id, _) = st.shifts.active_info().await;
    let mut out = Vec::new();
    for ctx in &contexts {
        out.push(
            wetstock::compute_reconciliation(&st.pool, ctx, q.period_start, now, shift_id.clone())
                .await
                .map_err(bad)?,
        );
    }
    Ok(Json(out))
}

async fn reconcile(
    State(st): State<AppState>,
    Json(cmd): Json<ReconcileCmd>,
) -> Result<Json<Vec<WetstockReconciliation>>, (StatusCode, String)> {
    let contexts = tank_contexts(&st, cmd.product_id, cmd.tank_id.as_deref()).await?;
    let now = chrono::Utc::now().timestamp_millis();
    let (shift_id, _) = st.shifts.active_info().await;
    let mut out = Vec::new();
    for ctx in &contexts {
        let r = wetstock::compute_reconciliation(
            &st.pool,
            ctx,
            cmd.period_start,
            now,
            shift_id.clone(),
        )
        .await
        .map_err(bad)?;
        wetstock::insert_reconciliation(&st.pool, &r, cmd.notes.as_deref())
            .await
            .map_err(internal)?;
        if r.measured_available && r.status != types::VarianceStatus::Ok {
            tracing::warn!(
                product = %r.product_name,
                variance_l = r.variance_l,
                variance_pct = r.variance_pct,
                status = ?r.status,
                "wetstock variance outside tolerance"
            );
        }
        out.push(r);
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize)]
pub struct ReconListQuery {
    pub tank_id: Option<String>,
    pub product_id: Option<u8>,
    pub limit: Option<i64>,
}

async fn list_reconciliations(
    State(st): State<AppState>,
    Query(q): Query<ReconListQuery>,
) -> Result<Json<Vec<WetstockReconciliation>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    wetstock::list_reconciliations(&st.pool, q.product_id, limit, q.tank_id.as_deref())
        .await
        .map(Json)
        .map_err(internal)
}

// ── Scheduled prices ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SchedQuery {
    /// PENDING | APPLIED | CANCELLED | FAILED
    pub status: Option<String>,
    pub limit: Option<i64>,
}

fn parse_status(s: &str) -> Option<ScheduledPriceStatus> {
    match s.to_ascii_uppercase().as_str() {
        "PENDING" => Some(ScheduledPriceStatus::Pending),
        "APPLIED" => Some(ScheduledPriceStatus::Applied),
        "CANCELLED" => Some(ScheduledPriceStatus::Cancelled),
        "FAILED" => Some(ScheduledPriceStatus::Failed),
        _ => None,
    }
}

async fn list_scheduled(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<SchedQuery>,
) -> Result<Json<Vec<ScheduledPrice>>, (StatusCode, String)> {
    require_admin(&st, &headers).await?;
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let status = q.status.as_deref().and_then(parse_status);
    sched::list(&st.pool, status, limit)
        .await
        .map(Json)
        .map_err(internal)
}

async fn create_scheduled(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(cmd): Json<CreateScheduledPriceCmd>,
) -> Result<Json<ScheduledPrice>, (StatusCode, String)> {
    let who = require_admin(&st, &headers).await?;
    let product_name = {
        let cfg = st.cfg.read().await;
        // Reject a schedule that could never apply, rather than letting it sit
        // PENDING until the scheduler fails it hours later.
        let product = cfg.product(cmd.product_id).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                format!("unknown product_id {}", cmd.product_id),
            )
        })?;
        let carried = cfg.fueling_positions.iter().any(|fp| {
            fp.active
                && fp
                    .nozzles
                    .iter()
                    .any(|n| n.active && n.product_id == cmd.product_id)
        });
        if !carried {
            return Err(bad(format!(
                "no active nozzle carries product {}",
                product.name
            )));
        }
        product.name.clone()
    };
    let scheduled = sched::insert(
        &st.pool,
        cmd.product_id,
        &product_name,
        cmd.new_price,
        cmd.effective_at,
        &who,
        cmd.notes.as_deref(),
    )
    .await
    .map_err(bad)?;
    tracing::info!(
        id = %scheduled.id,
        product = %scheduled.product_name,
        price = scheduled.new_price,
        effective_at = scheduled.effective_at,
        "price change scheduled"
    );
    Ok(Json(scheduled))
}

async fn cancel_scheduled(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_admin(&st, &headers).await?;
    if sched::cancel(&st.pool, &id).await.map_err(internal)? {
        Ok(Json(serde_json::json!({ "ok": true })))
    } else {
        Err(bad("no pending scheduled price with that id"))
    }
}
