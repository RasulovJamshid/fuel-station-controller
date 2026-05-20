//! Admin API — bearer token auth, price and station configuration.

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use site_config::{NozzleConfig, ProductConfig, ShiftMode, SiteConfig};
use types::{
    AdminApplyPricesCmd, AdminAuthCmd, AdminAuthResponse, AdminCatalog, AdminChangePinCmd,
    AdminConfigEntry, AdminNozzleInput, AdminNozzleRow, AdminPositionCatalog, AdminPriceEntry,
    AdminSetConfigCmd, AdminSettingsSnapshot, AdminShiftScheduleCmd,
    AdminUpdateOperatorCmd, CreateOperatorCmd, Operator, Preset, PriceChange, ProductSnapshot,
    SavePositionNozzlesCmd, SaveProductsCmd, UpdateAllPricesCmd,
};

use super::routes::AppState;
use crate::admin;
use crate::config;
use crate::db::{admin_queries, shift_queries};
use crate::engine::DispatchCommand;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/auth", post(admin_auth))
        .route("/admin/prices", get(admin_get_prices).post(admin_post_prices))
        .route("/admin/prices/apply-now", post(admin_apply_prices_now))
        .route("/admin/prices/history", get(admin_price_history))
        .route(
            "/admin/operators",
            get(admin_list_operators).post(admin_create_operator),
        )
        .route(
            "/admin/operators/:id",
            post(admin_update_operator).delete(admin_delete_operator),
        )
        .route("/admin/config", get(admin_list_config).post(admin_set_config))
        .route("/admin/settings", get(admin_get_settings).post(admin_post_settings))
        .route("/admin/shift-schedule", post(admin_shift_schedule))
        .route("/admin/catalog", get(admin_get_catalog))
        .route("/admin/products", post(admin_save_products))
        .route(
            "/admin/positions/:fp_id/nozzles",
            post(admin_save_position_nozzles),
        )
        .route("/admin/change-pin", post(admin_change_pin))
}

fn catalog_from_cfg(cfg: &SiteConfig) -> AdminCatalog {
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
    let positions: Vec<AdminPositionCatalog> = cfg
        .fueling_positions
        .iter()
        .map(|fp| {
            let nozzles: Vec<AdminNozzleRow> = fp
                .nozzles
                .iter()
                .map(|n| AdminNozzleRow {
                    index: n.index,
                    product_id: n.product_id,
                    product_name: cfg
                        .product(n.product_id)
                        .map(|p| p.name.clone())
                        .unwrap_or_else(|| "?".into()),
                    price: n.price,
                    active: n.active,
                })
                .collect();
            AdminPositionCatalog {
                fp_id: fp.id.clone(),
                label: fp.label.clone(),
                address_byte: fp.address_byte,
                active: fp.active,
                nozzles,
            }
        })
        .collect();
    AdminCatalog {
        products,
        positions,
    }
}

async fn sync_runtimes_from_cfg(st: &AppState) {
    let cfg = st.cfg.read().await;
    let mut map = st.runtimes.write().await;
    for fp in cfg.fueling_positions.iter().filter(|p| p.active) {
        if let Some(rt) = map.get_mut(&fp.address_byte) {
            rt.sync_nozzles_from_config(fp);
            let _ = st.events.send(types::WsEvent::Status(rt.state.clone()));
        }
    }
}

async fn require_admin(
    st: &AppState,
    headers: &HeaderMap,
) -> Result<String, (StatusCode, String)> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "missing Authorization".into()))?;
    let token = auth
        .strip_prefix("Bearer ")
        .ok_or((StatusCode::UNAUTHORIZED, "expected Bearer token".into()))?;
    st.admin_sessions
        .validate(token)
        .await
        .map_err(|_| (StatusCode::UNAUTHORIZED, "invalid or expired token".into()))
}

async fn admin_auth(
    State(st): State<AppState>,
    Json(cmd): Json<AdminAuthCmd>,
) -> Result<Json<AdminAuthResponse>, (StatusCode, String)> {
    if !admin::verify_admin_pin(&st.pool, &cmd.pin)
        .await
        .map_err(internal)?
    {
        return Err((StatusCode::UNAUTHORIZED, "invalid PIN".into()));
    }
    let must_change = admin::must_change_pin(&st.pool)
        .await
        .map_err(internal)?;
    let (token, expires_in) = st.admin_sessions.create("admin").await;
    Ok(Json(AdminAuthResponse {
        token,
        expires_in,
        must_change_pin: must_change,
    }))
}

async fn admin_get_prices(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AdminPriceEntry>>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    let cfg = st.cfg.read().await;
    Ok(Json(collect_price_entries(&cfg, &st).await))
}

async fn collect_price_entries(cfg: &SiteConfig, st: &AppState) -> Vec<AdminPriceEntry> {
    let runtimes = st.runtimes.read().await;
    let mut out = Vec::new();
    for fp in cfg.fueling_positions.iter().filter(|p| p.active) {
        for n in fp.nozzles.iter().filter(|n| n.active) {
            let price = runtimes
                .get(&fp.address_byte)
                .and_then(|rt| rt.nozzle_prices.get(&n.index).copied())
                .unwrap_or(n.price);
            let product_name = cfg
                .product(n.product_id)
                .map(|p| p.name.clone())
                .unwrap_or_default();
            out.push(AdminPriceEntry {
                fp_id: fp.id.clone(),
                label: fp.label.clone(),
                nozzle_index: n.index,
                product_id: n.product_id,
                product_name,
                price,
            });
        }
    }
    out.sort_by(|a, b| {
        a.fp_id
            .cmp(&b.fp_id)
            .then(a.nozzle_index.cmp(&b.nozzle_index))
    });
    out
}

async fn admin_post_prices(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(cmd): Json<UpdateAllPricesCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let who = require_admin(&st, &headers).await?;
    let mut updates = Vec::new();
    {
        let mut cfg = st.cfg.write().await;
        for u in &cmd.updates {
            let (product_id, product_name) = {
                let fp = cfg.position_by_id(&u.fp_id).ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        format!("unknown fp_id {}", u.fp_id),
                    )
                })?;
                if !fp
                    .nozzles
                    .iter()
                    .any(|n| n.index == u.nozzle_index && n.active)
                {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        format!("nozzle {} not active on {}", u.nozzle_index, u.fp_id),
                    ));
                }
                if u.price == 0 {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "price must be greater than zero".into(),
                    ));
                }
                let product_id = fp
                    .nozzles
                    .iter()
                    .find(|n| n.index == u.nozzle_index)
                    .map(|n| n.product_id)
                    .unwrap_or(0);
                let product_name = cfg
                    .product(product_id)
                    .map(|p| p.name.clone())
                    .unwrap_or_default();
                (product_id, product_name)
            };
            let old = cfg
                .set_nozzle_price(&u.fp_id, u.nozzle_index, u.price)
                .unwrap_or(0);
            if old != u.price {
                admin_queries::insert_price_change(
                    &st.pool,
                    &u.fp_id,
                    u.nozzle_index,
                    product_id,
                    &product_name,
                    old,
                    u.price,
                    &who,
                )
                .await
                .map_err(internal)?;
            }
            updates.push(u.clone());
        }
        config::save(&cfg, &st.config_path).map_err(internal)?;
    }
    let n = updates.len();
    if !updates.is_empty() {
        st.commands
            .send(DispatchCommand::UpdatePrices {
                updates,
                changed_by: who,
            })
            .await
            .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    }
    Ok(Json(serde_json::json!({ "ok": true, "updated": n })))
}

async fn admin_apply_prices_now(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(cmd): Json<AdminApplyPricesCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    let cfg = st.cfg.read().await;
    let fp = cfg
        .position_by_id(&cmd.fp_id)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, format!("unknown fp_id {}", cmd.fp_id)))?
        .clone();
    drop(cfg);
    let byte = fp.address_byte;
    let nozzle_index = fp
        .active_nozzles()
        .first()
        .map(|n| n.index)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "no active nozzle for position".into(),
            )
        })?;
    {
        let map = st.runtimes.read().await;
        let is_idle = map
            .get(&byte)
            .is_some_and(|r| matches!(r.state.status, types::FpStatus::Idle));
        if !is_idle {
            return Err((
                StatusCode::BAD_REQUEST,
                "apply-now requires IDLE (holstered nozzle)".into(),
            ));
        }
    }
    let cfg = st.cfg.read().await;
    let price = {
        let map = st.runtimes.read().await;
        map.get(&byte)
            .and_then(|r| r.nozzle_prices.get(&nozzle_index).copied())
            .or_else(|| cfg.price_for(byte, nozzle_index))
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
            preset: Preset::Str("full".into()),
            nozzle_index,
        })
        .await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct HistoryQuery {
    limit: Option<i64>,
}

async fn admin_price_history(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HistoryQuery>,
) -> Result<Json<Vec<PriceChange>>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let rows = admin_queries::list_price_history(&st.pool, limit)
        .await
        .map_err(internal)?;
    Ok(Json(rows))
}

async fn admin_list_operators(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Operator>>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    let ops = shift_queries::list_operators(&st.pool)
        .await
        .map_err(internal)?;
    Ok(Json(ops))
}

async fn admin_create_operator(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(cmd): Json<CreateOperatorCmd>,
) -> Result<Json<Operator>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    let op = admin_queries::insert_operator(&st.pool, &cmd)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(op))
}

async fn admin_update_operator(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(cmd): Json<AdminUpdateOperatorCmd>,
) -> Result<Json<Operator>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    let op = admin_queries::update_operator(
        &st.pool,
        &id,
        cmd.active,
        cmd.pin.as_deref(),
    )
    .await
    .map_err(internal)?
    .ok_or_else(|| (StatusCode::NOT_FOUND, "operator not found".into()))?;
    Ok(Json(op))
}

async fn admin_delete_operator(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    let ok = admin_queries::delete_operator(&st.pool, &id)
        .await
        .map_err(internal)?;
    if !ok {
        return Err((StatusCode::NOT_FOUND, "operator not found".into()));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn admin_list_config(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AdminConfigEntry>>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    let rows = admin_queries::list_admin_config(&st.pool)
        .await
        .map_err(internal)?;
    Ok(Json(rows))
}

async fn admin_set_config(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(cmd): Json<AdminSetConfigCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let who = require_admin(&st, &headers).await?;
    if cmd.key == "admin_pin_hash" || cmd.key == "admin_pin_must_change" {
        return Err((
            StatusCode::BAD_REQUEST,
            "use /admin/change-pin to update admin PIN".into(),
        ));
    }
    admin_queries::set_config_value(&st.pool, &cmd.key, &cmd.value, &who)
        .await
        .map_err(internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn admin_get_settings(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminSettingsSnapshot>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    let cfg = st.cfg.read().await;
    Ok(Json(AdminSettingsSnapshot {
        polling_interval_ms: cfg.polling.interval_ms,
        polling_offline_threshold_polls: cfg.polling.offline_threshold_polls,
        preauth_timeout_seconds: cfg.ui.preauth_timeout_seconds,
        shifts_warn_before_end_minutes: cfg.shifts.warn_before_end_minutes,
        shift_mode: serde_json::to_value(&cfg.shifts.mode)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "manual".into()),
        shift_schedule: cfg
            .shifts
            .scheduled
            .iter()
            .map(|s| types::ShiftSlot {
                name: s.name.clone(),
                start: s.start.clone(),
                end: s.end.clone(),
            })
            .collect(),
    }))
}

#[derive(Deserialize)]
struct SettingsPost {
    polling_interval_ms: Option<u64>,
    polling_offline_threshold_polls: Option<u32>,
    preauth_timeout_seconds: Option<u64>,
    shifts_warn_before_end_minutes: Option<u32>,
}

async fn admin_post_settings(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SettingsPost>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    {
        let mut cfg = st.cfg.write().await;
        if let Some(v) = body.polling_interval_ms {
            cfg.polling.interval_ms = v;
        }
        if let Some(v) = body.polling_offline_threshold_polls {
            cfg.polling.offline_threshold_polls = v;
        }
        if let Some(v) = body.preauth_timeout_seconds {
            cfg.ui.preauth_timeout_seconds = v;
        }
        if let Some(v) = body.shifts_warn_before_end_minutes {
            cfg.shifts.warn_before_end_minutes = v;
        }
        cfg.validate().map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        config::save(&cfg, &st.config_path).map_err(internal)?;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn admin_shift_schedule(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(cmd): Json<AdminShiftScheduleCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    let mode = match cmd.mode.to_lowercase().as_str() {
        "disabled" => ShiftMode::Disabled,
        "manual" => ShiftMode::Manual,
        "scheduled" => ShiftMode::Scheduled,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                "mode must be disabled, manual, or scheduled".into(),
            ))
        }
    };
    {
        let mut cfg = st.cfg.write().await;
        cfg.shifts.mode = mode;
        cfg.shifts.scheduled = cmd
            .scheduled
            .into_iter()
            .map(|s| site_config::ScheduledShift {
                name: s.name,
                start: s.start,
                end: s.end,
            })
            .collect();
        cfg.validate().map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        config::save(&cfg, &st.config_path).map_err(internal)?;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn admin_get_catalog(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AdminCatalog>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    let cfg = st.cfg.read().await;
    Ok(Json(catalog_from_cfg(&cfg)))
}

async fn admin_save_products(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(cmd): Json<SaveProductsCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    if cmd.products.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "at least one product is required".into()));
    }
    let mut products: Vec<ProductConfig> = Vec::new();
    let mut used_ids = std::collections::HashSet::new();
    {
        let cfg = st.cfg.read().await;
        let mut next_id = cfg.next_product_id();
        for p in cmd.products {
            let name = p.name.trim().to_string();
            if name.is_empty() {
                return Err((StatusCode::BAD_REQUEST, "product name is required".into()));
            }
            let id = if let Some(id) = p.id {
                id
            } else {
                while used_ids.contains(&next_id) {
                    next_id = next_id.saturating_add(1);
                }
                let id = next_id;
                next_id = next_id.saturating_add(1);
                id
            };
            if !used_ids.insert(id) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!("duplicate product id {id}"),
                ));
            }
            products.push(ProductConfig {
                id,
                name,
                color: if p.color.trim().is_empty() {
                    "#888888".into()
                } else {
                    p.color.trim().to_string()
                },
                unit: if p.unit.trim().is_empty() {
                    "litre".into()
                } else {
                    p.unit.trim().to_string()
                },
            });
        }
    }
    {
        let mut cfg = st.cfg.write().await;
        cfg.replace_products(products).map_err(|e| {
            (StatusCode::BAD_REQUEST, e.to_string())
        })?;
        config::save(&cfg, &st.config_path).map_err(internal)?;
    }
    sync_runtimes_from_cfg(&st).await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn nozzles_from_input(
    inputs: Vec<AdminNozzleInput>,
    cfg: &SiteConfig,
) -> Result<Vec<NozzleConfig>, (StatusCode, String)> {
    if inputs.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "at least one nozzle is required".into(),
        ));
    }
    let mut indices = std::collections::HashSet::new();
    let mut out = Vec::new();
    for n in inputs {
        if n.index == 0 {
            return Err((StatusCode::BAD_REQUEST, "nozzle index must be >= 1".into()));
        }
        if !indices.insert(n.index) {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("duplicate nozzle index {}", n.index),
            ));
        }
        if cfg.product(n.product_id).is_none() {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("unknown product_id {}", n.product_id),
            ));
        }
        if n.active && n.price == 0 {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("nozzle {} price must be > 0 when active", n.index),
            ));
        }
        out.push(NozzleConfig {
            index: n.index,
            product_id: n.product_id,
            price: n.price,
            active: n.active,
            wayne_code: n.wayne_code,
        });
    }
    out.sort_by_key(|n| n.index);
    Ok(out)
}

async fn admin_save_position_nozzles(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(fp_id): Path<String>,
    Json(cmd): Json<SavePositionNozzlesCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _who = require_admin(&st, &headers).await?;
    let nozzles = {
        let cfg = st.cfg.read().await;
        if cfg.position_by_id(&fp_id).is_none() {
            return Err((StatusCode::BAD_REQUEST, format!("unknown fp_id {fp_id}")));
        }
        nozzles_from_input(cmd.nozzles, &cfg)?
    };
    {
        let mut cfg = st.cfg.write().await;
        cfg.set_position_nozzles(&fp_id, nozzles)
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        config::save(&cfg, &st.config_path).map_err(internal)?;
    }
    sync_runtimes_from_cfg(&st).await;
    Ok(Json(serde_json::json!({ "ok": true, "fp_id": fp_id })))
}

async fn admin_change_pin(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(cmd): Json<AdminChangePinCmd>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    let who = if let Some(t) = token {
        st.admin_sessions
            .validate(t)
            .await
            .map_err(|_| (StatusCode::UNAUTHORIZED, "invalid token".into()))?
    } else {
        "admin".into()
    };
    if !admin::verify_admin_pin(&st.pool, &cmd.current_pin)
        .await
        .map_err(internal)?
    {
        return Err((StatusCode::UNAUTHORIZED, "invalid current PIN".into()));
    }
    admin::set_admin_pin(&st.pool, &cmd.new_pin, &who, true)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn internal(e: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}
