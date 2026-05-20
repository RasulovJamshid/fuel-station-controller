use tokio::time::{sleep, Duration};

use crate::dispenser::{SharedDispensers, SimStatus};

pub async fn run(name: &str, disps: SharedDispensers) -> anyhow::Result<()> {
    match name {
        "normal_fill" => normal_fill(disps).await,
        "emergency_stop" => emergency_stop(disps).await,
        "two_simultaneous" => two_simultaneous(disps).await,
        "ghost_fill" => ghost_fill(disps).await,
        "long_disconnect" => long_disconnect(disps).await,
        "all_scenarios" => all_scenarios(disps).await,
        _ => anyhow::bail!("Unknown scenario: {}", name),
    }
}

async fn normal_fill(disps: SharedDispensers) -> anyhow::Result<()> {
    tracing::info!("[scenario] normal_fill start");
    reset_all(&disps);

    {
        let mut d = disps.lock().unwrap();
        d.iter_mut()
            .find(|x| x.addr == 0x52)
            .unwrap()
            .lift_nozzle(None, None, None, None)?;
    }
    tracing::info!("[scenario] P2 nozzle up — waiting for service to authorize...");
    sleep(Duration::from_millis(2000)).await;
    sleep(Duration::from_millis(15000)).await;

    {
        let mut d = disps.lock().unwrap();
        if let Some(disp) = d.iter_mut().find(|x| x.addr == 0x52) {
            let _ = disp.replace_nozzle();
            tracing::info!(
                "[scenario] P2 nozzle down — vol={:.2}L amt={} sum",
                disp.volume,
                disp.amount
            );
        }
    }

    sleep(Duration::from_millis(2000)).await;
    tracing::info!("[scenario] normal_fill complete");
    Ok(())
}

async fn emergency_stop(disps: SharedDispensers) -> anyhow::Result<()> {
    tracing::info!("[scenario] emergency_stop start");
    reset_all(&disps);

    {
        let mut d = disps.lock().unwrap();
        d.iter_mut()
            .find(|x| x.addr == 0x52)
            .unwrap()
            .lift_nozzle(None, None, None, None)?;
    }

    sleep(Duration::from_millis(1500)).await;
    sleep(Duration::from_millis(5000)).await;

    {
        let d = disps.lock().unwrap();
        let disp = d.iter().find(|x| x.addr == 0x52).unwrap();
        tracing::info!(
            "[scenario] P2 delivering: vol={:.2}L — service should stop",
            disp.volume
        );
    }

    sleep(Duration::from_millis(3000)).await;
    tracing::info!("[scenario] emergency_stop complete");
    Ok(())
}

async fn two_simultaneous(disps: SharedDispensers) -> anyhow::Result<()> {
    tracing::info!("[scenario] two_simultaneous start");
    reset_all(&disps);

    {
        let mut d = disps.lock().unwrap();
        d.iter_mut()
            .find(|x| x.addr == 0x51)
            .unwrap()
            .lift_nozzle(None, None, None, None)?;
    }
    sleep(Duration::from_millis(200)).await;
    {
        let mut d = disps.lock().unwrap();
        d.iter_mut()
            .find(|x| x.addr == 0x52)
            .unwrap()
            .lift_nozzle(None, None, None, None)?;
    }

    tracing::info!("[scenario] P1 and P2 nozzles up");
    sleep(Duration::from_millis(20000)).await;

    {
        let mut d = disps.lock().unwrap();
        let _ = d
            .iter_mut()
            .find(|x| x.addr == 0x51)
            .unwrap()
            .replace_nozzle();
    }
    sleep(Duration::from_millis(3000)).await;
    {
        let mut d = disps.lock().unwrap();
        let _ = d
            .iter_mut()
            .find(|x| x.addr == 0x52)
            .unwrap()
            .replace_nozzle();
    }

    sleep(Duration::from_millis(3000)).await;
    tracing::info!("[scenario] two_simultaneous complete");
    Ok(())
}

async fn ghost_fill(disps: SharedDispensers) -> anyhow::Result<()> {
    tracing::info!("[scenario] ghost_fill start");
    reset_all(&disps);

    {
        let mut d = disps.lock().unwrap();
        d.iter_mut()
            .find(|x| x.addr == 0x52)
            .unwrap()
            .lift_nozzle(None, None, None, None)?;
    }
    tracing::info!("[scenario] P2 nozzle up");
    sleep(Duration::from_millis(500)).await;

    {
        let mut d = disps.lock().unwrap();
        if let Some(disp) = d.iter_mut().find(|x| x.addr == 0x52) {
            disp.status = SimStatus::Idle;
        }
    }
    tracing::info!("[scenario] P2 nozzle down immediately (ghost fill)");
    sleep(Duration::from_millis(2000)).await;
    tracing::info!("[scenario] ghost_fill complete");
    Ok(())
}

async fn long_disconnect(disps: SharedDispensers) -> anyhow::Result<()> {
    tracing::info!("[scenario] long_disconnect start — going offline");

    {
        let mut d = disps.lock().unwrap();
        for disp in d.iter_mut() {
            disp.go_offline();
        }
    }

    tracing::info!("[scenario] all dispensers offline for 10s (shortened for testing)");
    sleep(Duration::from_millis(10000)).await;

    {
        let mut d = disps.lock().unwrap();
        for disp in d.iter_mut() {
            disp.go_online(true);
        }
    }
    tracing::info!("[scenario] all dispensers online — sending data flush frames");
    sleep(Duration::from_millis(3000)).await;
    tracing::info!("[scenario] long_disconnect complete — service should be back to normal");
    Ok(())
}

async fn all_scenarios(disps: SharedDispensers) -> anyhow::Result<()> {
    normal_fill(disps.clone()).await?;
    sleep(Duration::from_millis(5000)).await;
    emergency_stop(disps.clone()).await?;
    sleep(Duration::from_millis(5000)).await;
    two_simultaneous(disps.clone()).await?;
    sleep(Duration::from_millis(5000)).await;
    ghost_fill(disps.clone()).await?;
    sleep(Duration::from_millis(5000)).await;
    long_disconnect(disps.clone()).await?;
    Ok(())
}

fn reset_all(disps: &SharedDispensers) {
    let mut d = disps.lock().unwrap();
    for disp in d.iter_mut() {
        disp.reset();
    }
}
