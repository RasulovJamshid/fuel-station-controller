mod api;
mod config;
mod dispenser;
mod engine;
mod scenarios;

use std::sync::{Arc, Mutex};

use anyhow::Context;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cfg_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "sim.config.json".to_string());
    let cfg = config::SimConfig::load(&cfg_path)?;

    tracing::info!("Wayne Simulator starting");
    tracing::info!("Virtual port: {}", cfg.virtual_port);
    tracing::info!("API port:     {}", cfg.api_port);

    let dispensers: Vec<dispenser::SimDispenser> = if let Some(site_path) = cfg.resolve_site_config_path(&cfg_path) {
        let site_path = site_path.to_string_lossy().to_string();
        let site = site_config::SiteConfig::load(&site_path)
            .with_context(|| format!("load site config {}", site_path))?;
        site
            .active_positions()
            .iter()
            .map(|fp| {
                let nozzles = fp.active_nozzles();
                let nozzle = *nozzles
                    .first()
                    .context("active position has no active nozzle")?;
                let product = nozzle.product_id;
                let product_name = site
                    .product(product)
                    .map(|p| p.name.as_str())
                    .unwrap_or("?");
                let disp = dispenser::SimDispenser::new(
                    &fp.id,
                    fp.address_byte,
                    &fp.label,
                    product,
                    product_name,
                    nozzle.price,
                    cfg.default_fill_rate_lps,
                );
                tracing::info!("  {} @ 0x{:02X} ({}) ready", fp.id, fp.address_byte, fp.label);
                Ok(disp)
            })
            .collect::<anyhow::Result<Vec<_>>>()?
    } else {
        anyhow::ensure!(
            !cfg.dispensers.is_empty(),
            "sim.config: set site_config_path or legacy dispensers[]"
        );
        cfg.dispensers
            .iter()
            .map(|d| {
                let fp_id = d.fp_id.clone().unwrap_or_else(|| d.addr.clone());
                let disp = dispenser::SimDispenser::new(
                    &fp_id,
                    d.byte,
                    &d.label,
                    d.product,
                    &d.product_name,
                    d.price,
                    d.fill_rate_lps,
                );
                tracing::info!("  {} @ 0x{:02X} ({}) ready", fp_id, d.byte, d.label);
                disp
            })
            .collect()
    };

    let dispensers: dispenser::SharedDispensers = Arc::new(Mutex::new(dispensers));

    let parity = match cfg.parity.as_str() {
        "odd" => serialport::Parity::Odd,
        "even" => serialport::Parity::Even,
        _ => serialport::Parity::None,
    };

    engine::spawn_serial_loop(
        cfg.virtual_port.clone(),
        cfg.baud_rate,
        parity,
        dispensers.clone(),
        cfg.log_frames,
    );

    let app = api::router(dispensers.clone());
    let addr = format!("0.0.0.0:{}", cfg.api_port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("Control API listening on http://{}", addr);
    tracing::info!("Ready. Waiting for dispenser-service to connect...");

    axum::serve(listener, app).await?;
    Ok(())
}
