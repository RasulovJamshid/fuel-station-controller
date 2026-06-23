use tokio::time::{sleep, Duration};

use crate::dispenser::SharedDispensers;

pub async fn run(name: &str, disps: SharedDispensers) -> anyhow::Result<()> {
    match name {
        "wrong_nozzle" => wrong_nozzle(disps).await,
        _ => anyhow::bail!("Unknown scenario: {}", name),
    }
}

/// Wrong-nozzle-during-preauth recovery (FP3, addr 0x03).
///
/// Reproduces the field report: nozzle 3 is pre-authorized from the desktop UI,
/// but the operator lifts nozzle 2 by mistake. Exercises the backend fix in the
/// Gilbarco poll loop — the lane must show NOZZLE_UP (not a misleading IDLE)
/// while the wrong nozzle is in hand, and a fresh pre-authorization must succeed
/// the moment the wrong nozzle is holstered.
///
/// The pre-authorization itself is a desktop/service action (the simulator cannot
/// arm it), so this scenario drives only the simulator half and prints, at each
/// phase, exactly what to do in the UI and what to expect on screen. The holds are
/// deliberately generous so an operator can follow along live.
async fn wrong_nozzle(disps: SharedDispensers) -> anyhow::Result<()> {
    const ADDR: u8 = 0x03; // FP3
    const EXPECTED_NOZZLE: u8 = 3; // pre-authorize THIS one in the UI
    const WRONG_NOZZLE: u8 = 2; // …then we lift THIS one

    tracing::info!("[scenario] wrong_nozzle start (FP3) — resetting all pumps");
    reset_all(&disps);
    sleep(Duration::from_millis(500)).await;

    tracing::info!(
        "[scenario] STEP 1/5 → In the desktop UI, PRE-AUTHORIZE nozzle {} on FP3 NOW. \
         Lifting the wrong nozzle in 6s…",
        EXPECTED_NOZZLE
    );
    sleep(Duration::from_millis(6000)).await;

    lift(&disps, ADDR, WRONG_NOZZLE)?;
    tracing::info!(
        "[scenario] STEP 2/5 → Lifted WRONG nozzle {} (expected {}). \
         EXPECT: backend cancels the preauth, fires PreAuthNozzleMismatch, and the FP3 \
         card shows a RED 'WRONG NOZZLE' overlay with status NOZZLE_UP — NOT idle.",
        WRONG_NOZZLE, EXPECTED_NOZZLE
    );
    sleep(Duration::from_millis(6000)).await;

    holster(&disps, ADDR);
    tracing::info!(
        "[scenario] STEP 3/5 → Wrong nozzle holstered. \
         EXPECT: the red overlay clears and FP3 returns to IDLE."
    );
    sleep(Duration::from_millis(4000)).await;

    tracing::info!(
        "[scenario] STEP 4/5 → PRE-AUTHORIZE nozzle {} on FP3 AGAIN now. \
         Lifting the correct nozzle in 6s… EXPECT: no error (the earlier bug rejected this).",
        EXPECTED_NOZZLE
    );
    sleep(Duration::from_millis(6000)).await;

    lift(&disps, ADDR, EXPECTED_NOZZLE)?;
    tracing::info!(
        "[scenario] STEP 5/5 → Lifted CORRECT nozzle {}. \
         EXPECT: lane authorizes and starts DELIVERING. Filling ~8s…",
        EXPECTED_NOZZLE
    );
    sleep(Duration::from_millis(8000)).await;

    holster(&disps, ADDR);
    {
        let d = disps.lock().unwrap();
        if let Some(disp) = d.iter().find(|x| x.addr == ADDR) {
            tracing::info!(
                "[scenario] correct fill committed — vol={:.2}L amt={} (raw)",
                disp.volume_ml as f64 / 1000.0,
                disp.amount_raw
            );
        }
    }
    tracing::info!("[scenario] wrong_nozzle complete");
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn lift(disps: &SharedDispensers, addr: u8, nozzle: u8) -> anyhow::Result<()> {
    let mut d = disps.lock().unwrap();
    match d.iter_mut().find(|x| x.addr == addr) {
        Some(disp) => disp.lift_nozzle(Some(nozzle), None),
        None => anyhow::bail!("addr 0x{:02X} not found", addr),
    }
}

fn holster(disps: &SharedDispensers, addr: u8) {
    let mut d = disps.lock().unwrap();
    if let Some(disp) = d.iter_mut().find(|x| x.addr == addr) {
        let _ = disp.replace_nozzle();
    }
}

fn reset_all(disps: &SharedDispensers) {
    let mut d = disps.lock().unwrap();
    for disp in d.iter_mut() {
        disp.reset();
    }
}
