//! Durable AZT intent. Journal writes precede authorize and final confirmation.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u8,
    site_id: String,
    nozzles: Vec<(u8, u8)>,
    state: types::FpState,
    azt: super::super::azt_state::AztRuntimeState,
    current_tx: Option<CurrentTx>,
    pre_auth: Option<PreAuthContext>,
    preset: Preset,
    pre_auth_started_at: Option<i64>,
    auth_session_started_at: Option<i64>,
}

pub(super) async fn restore(
    byte: u8,
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    pool: &SqlitePool,
) -> anyhow::Result<()> {
    let fp = cfg
        .position_by_address(byte)
        .ok_or_else(|| anyhow::anyhow!("unknown lane"))?;
    {
        let map = runtimes.read().await;
        if let Some(rt) = map.get(&byte).filter(|rt| rt.azt.journal_loaded) {
            if let Some(json) = &rt.azt.journal_json {
                let saved: Snapshot = serde_json::from_str(json)?;
                anyhow::ensure!(
                    saved.site_id == cfg.site.id
                        && saved.state.fp_id == fp.id
                        && saved.nozzles == azt_fp_nozzles(fp),
                    "AZT active order mapping changed; restore the original configuration"
                );
            }
            return Ok(());
        }
    }
    let json: Option<String> =
        sqlx::query_scalar("SELECT payload_json FROM azt_recovery WHERE site_id = ? AND fp_id = ?")
            .bind(&cfg.site.id)
            .bind(&fp.id)
            .fetch_optional(pool)
            .await?;
    let saved = json
        .as_ref()
        .map(|json| serde_json::from_str::<Snapshot>(json))
        .transpose()?;
    if let Some(saved) = &saved {
        anyhow::ensure!(
            saved.version == 1
                && saved.site_id == cfg.site.id
                && saved.state.fp_id == fp.id
                && saved.nozzles == azt_fp_nozzles(fp),
            "AZT recovery nozzle mapping differs from configuration; restore the original mapping"
        );
    }
    if let Some(rt) = runtimes.write().await.get_mut(&byte) {
        if let Some(saved) = saved {
            // A stop may have been issued while the journal was temporarily
            // unreadable. Restoring older intent must not discard that stop.
            let stops = rt.azt.stop_addresses.clone();
            let stop_requested = rt.azt.stop_requested;
            let cancel_requested = rt.azt.cancel_requested;
            rt.state = saved.state;
            rt.azt = saved.azt;
            rt.azt.stop_addresses.extend(stops);
            rt.azt.stop_requested |= stop_requested;
            rt.azt.cancel_requested |= cancel_requested;
            rt.current_tx = saved.current_tx;
            rt.pre_auth = saved.pre_auth;
            rt.last_preset = saved.preset;
            rt.pre_auth_started_at = saved.pre_auth_started_at;
            rt.auth_session_started_at = saved.auth_session_started_at;
            // Cached meters are not evidence of a fresh poll after restart.
            if !rt.azt.pending_confirmation {
                rt.state.status = FpStatus::Offline;
            }
        }
        rt.azt.journal_loaded = true;
        rt.azt.journal_json = json;
    }
    Ok(())
}

pub(super) async fn save(
    byte: u8,
    cfg: &SiteConfig,
    runtimes: &Arc<RwLock<HashMap<u8, RuntimeFp>>>,
    pool: &SqlitePool,
) -> anyhow::Result<()> {
    restore(byte, cfg, runtimes, pool).await?;
    let fp = cfg
        .position_by_address(byte)
        .ok_or_else(|| anyhow::anyhow!("unknown lane"))?;
    let (json, previous) = {
        let map = runtimes.read().await;
        let rt = map
            .get(&byte)
            .ok_or_else(|| anyhow::anyhow!("unknown lane"))?;
        anyhow::ensure!(rt.azt.journal_loaded, "AZT recovery journal unavailable");
        let owns = rt.current_tx.is_some()
            || rt.pre_auth.is_some()
            || rt.azt.pending_confirmation
            || !rt.azt.stop_addresses.is_empty();
        let json = if owns {
            let mut state = rt.state.clone();
            // Avoid disk writes for every live pulse/timestamp: the pump owns
            // final meters. Persist intent and ownership changes only.
            if !rt.azt.pending_confirmation {
                state.volume = 0.0;
                state.amount = 0;
            }
            state.updated_at = 0;
            state.missed_polls = 0;
            state.protocol_error = None;
            state.pump_totals.clear();
            state.pump_total_volume = None;
            state.pump_total_amount = None;
            Some(serde_json::to_string(&Snapshot {
                version: 1,
                site_id: cfg.site.id.clone(),
                nozzles: azt_fp_nozzles(fp),
                state,
                azt: rt.azt.clone(),
                current_tx: rt.current_tx.clone(),
                pre_auth: rt.pre_auth.clone(),
                preset: rt.last_preset.clone(),
                pre_auth_started_at: rt.pre_auth_started_at,
                auth_session_started_at: rt.auth_session_started_at,
            })?)
        } else {
            None
        };
        (json, rt.azt.journal_json.clone())
    };
    if json == previous {
        return Ok(());
    }
    if let Some(json) = &json {
        sqlx::query("INSERT INTO azt_recovery (site_id, fp_id, payload_json) VALUES (?, ?, ?) ON CONFLICT(site_id, fp_id) DO UPDATE SET payload_json = excluded.payload_json")
            .bind(&cfg.site.id).bind(&fp.id).bind(json).execute(pool).await?;
    } else {
        sqlx::query("DELETE FROM azt_recovery WHERE site_id = ? AND fp_id = ?")
            .bind(&cfg.site.id)
            .bind(&fp.id)
            .execute(pool)
            .await?;
    }
    if let Some(rt) = runtimes.write().await.get_mut(&byte) {
        rt.azt.journal_json = json;
    }
    Ok(())
}
