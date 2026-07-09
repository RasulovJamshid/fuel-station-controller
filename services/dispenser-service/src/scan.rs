//! AZT 2.0 RS-485 bus scanner.
//!
//! Read-only sweep of network addresses 1..=15: for each address that answers a
//! status poll, collect a full profile (status, TRK type, totalizer, protocol
//! version) and write a JSON report. Sends only query commands — never anything
//! that could arm, dose, start, or reset a pump — so it is safe on a live
//! forecourt.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::Serialize;
use site_config::Protocol;
use tracing::{info, warn};

use crate::config::load;
use crate::engine::ReconnectingSerial;

/// Highest network address on a single start-byte offset (§3).
const MAX_ADDR: u8 = 15;

#[derive(Serialize)]
struct ScanReport {
    port: String,
    baud_rate: u32,
    parity: String,
    data_bits: u8,
    stop_bits: u8,
    scanned: String,
    live_count: usize,
    addresses: Vec<AddressEntry>,
}

#[derive(Serialize)]
struct AddressEntry {
    address: u8,
    alive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    /// Raw TRK identifier byte, e.g. "0x48" (reported even if not in the
    /// documented A–H range so undocumented pump types are visible).
    #[serde(skip_serializing_if = "Option::is_none")]
    type_id_raw: Option<String>,
    type_known: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    type_digits: Option<TypeDigits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    totals: Option<Totals>,
    #[serde(skip_serializing_if = "Option::is_none")]
    protocol_version: Option<u32>,
    /// Raw hex of each response, for debugging undecodable frames.
    raw: RawFrames,
}

#[derive(Serialize)]
struct TypeDigits {
    volume: u8,
    price: u8,
    cost: u8,
}

#[derive(Serialize)]
struct Totals {
    volume_l: f64,
    /// Currency total in soum (wire units × 10, see AZT_WIRE_UNIT).
    amount_soum: u64,
}

#[derive(Serialize, Default)]
struct RawFrames {
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    type_frame: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    totals: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

/// Regional wire-money convention — keep in sync with the poll loop's
/// `AZT_WIRE_UNIT` (1 wire unit = 10 soum).
const WIRE_UNIT: u64 = 10;

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Send a query and return the decoded response, logging raw hex.
fn query(serial: &ReconnectingSerial, frame: &[u8]) -> (Option<azt::Response>, Option<String>) {
    match serial.exchange(frame) {
        Ok(resp) if !resp.is_empty() => (azt::decode_response(&resp), Some(hex(&resp))),
        _ => (None, None),
    }
}

fn probe(serial: &ReconnectingSerial, net: u8) -> AddressEntry {
    let mut raw = RawFrames::default();

    // Status '1' — the aliveness gate. A valid, KNOWN status means a real device
    // answered; Unknown (garbage/echo) or no reply → not alive.
    let (status_resp, status_hex) = query(serial, &azt::status(net));
    raw.status = status_hex;
    let status = match status_resp {
        Some(azt::Response::Data(d)) => azt::parse_status(&d),
        _ => None,
    };
    let alive = matches!(status, Some(s) if s != azt::AztStatus::Unknown);
    if !alive {
        return AddressEntry {
            address: net,
            alive: false,
            status: None,
            type_id_raw: None,
            type_known: false,
            type_digits: None,
            totals: None,
            protocol_version: None,
            raw,
        };
    }

    // TRK type '7' — digit widths, and the raw identifier even if undocumented.
    let (type_resp, type_hex) = query(serial, &azt::trk_type(net));
    raw.type_frame = type_hex;
    let type_id = match type_resp {
        Some(azt::Response::Data(d)) => d.first().copied(),
        _ => None,
    };
    let type_known = type_id.and_then(azt::TrkType::from_identifier).is_some();
    let type_digits = type_id
        .and_then(azt::TrkType::from_identifier)
        .map(|t| TypeDigits {
            volume: t.volume_digits,
            price: t.price_digits,
            cost: t.cost_digits,
        });

    // Totalizer '6'.
    let (totals_resp, totals_hex) = query(serial, &azt::totals(net));
    raw.totals = totals_hex;
    let totals = match totals_resp {
        Some(azt::Response::Data(d)) => azt::parse_totals(&d).map(|(litres_cl, amount_wire)| Totals {
            volume_l: litres_cl as f64 / 100.0,
            amount_soum: amount_wire * WIRE_UNIT,
        }),
        _ => None,
    };

    // Protocol version 'P'.
    let (ver_resp, ver_hex) = query(serial, &azt::protocol_version(net));
    raw.version = ver_hex;
    let protocol_version = match ver_resp {
        Some(azt::Response::Data(d)) => azt::parse_protocol_version(&d),
        _ => None,
    };

    AddressEntry {
        address: net,
        alive: true,
        status: status.map(|s| format!("{s:?}")),
        type_id_raw: type_id.map(|b| format!("0x{b:02X}")),
        type_known,
        type_digits,
        totals,
        protocol_version,
        raw,
    }
}

/// Run the read-only bus scan and write a JSON report.
pub async fn run_scan(config_path: PathBuf, out: PathBuf) -> Result<()> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let (cfg, _) = load(Some(config_path))?;

    // Honor AZS_SERIAL_LOG so raw scan frames land alongside the JSON report.
    if let Some(path) = std::env::var("AZS_SERIAL_LOG")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| cfg.service.serial_log_file.clone())
    {
        let _ = crate::engine::init_serial_logger(&path);
    }

    if cfg.connection.protocol != Protocol::Azt20 {
        warn!(
            protocol = ?cfg.connection.protocol,
            "config protocol is not azt2_0 — scanning with AZT commands anyway"
        );
    }

    let serial = ReconnectingSerial::new(&cfg).context("open serial port for scan")?;
    info!(
        port = %cfg.connection.port,
        baud = cfg.connection.baud_rate,
        "AZT bus scan: sweeping addresses 1..={MAX_ADDR} (read-only)"
    );

    let mut addresses = Vec::new();
    for net in 1..=MAX_ADDR {
        let entry = probe(&serial, net);
        if entry.alive {
            info!(
                address = net,
                status = ?entry.status,
                type_id = ?entry.type_id_raw,
                "AZT scan: live"
            );
        }
        addresses.push(entry);
        // RS-485 turnaround between addresses.
        std::thread::sleep(std::time::Duration::from_millis(60));
    }

    let live_count = addresses.iter().filter(|a| a.alive).count();
    let report = ScanReport {
        port: cfg.connection.port.clone(),
        baud_rate: cfg.connection.baud_rate,
        parity: format!("{:?}", cfg.connection.parity),
        data_bits: cfg.connection.data_bits,
        stop_bits: cfg.connection.stop_bits,
        scanned: format!("1..={MAX_ADDR}"),
        live_count,
        addresses,
    };

    let json = serde_json::to_string_pretty(&report)?;
    std::fs::write(&out, json).with_context(|| format!("write scan report {}", out.display()))?;
    info!(
        live = live_count,
        out = %out.display(),
        "AZT bus scan complete"
    );
    println!(
        "AZT bus scan: {live_count} live address(es). Report written to {}",
        out.display()
    );
    Ok(())
}
