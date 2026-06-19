use anyhow::{Context, Result};
use serialport::{ClearBuffer, DataBits, StopBits};
use site_config::{ConnectionConfig, SiteConfig};
use std::io::{BufWriter, Write};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tracing::{info, trace, warn};

// ── Serial frame logger ───────────────────────────────────────────────────────
// Writes timestamped TX/RX hex lines to a file when enabled.
// Initialised once at startup via `init_serial_logger`; disabled by default.

static SERIAL_LOG: OnceLock<Mutex<BufWriter<std::fs::File>>> = OnceLock::new();

/// Open (or create/truncate) `path` and start logging every serial frame.
/// Safe to call multiple times — only the first call takes effect.
pub fn init_serial_logger(path: &str) -> Result<()> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .with_context(|| format!("open serial log '{path}'"))?;
    // Ignore the error when already initialised (second call is a no-op).
    let _ = SERIAL_LOG.set(Mutex::new(BufWriter::new(file)));
    Ok(())
}

fn serial_log(dir: &str, bytes: &[u8]) {
    let Some(lock) = SERIAL_LOG.get() else { return };
    let Ok(mut w) = lock.lock() else { return };
    let ts = chrono::Local::now().format("%H:%M:%S%.3f");
    let _ = writeln!(w, "[{ts}] {dir} {}", hex_bytes(bytes));
    let _ = w.flush();
}

/// After the last byte, wait this long with no new data before treating the response as complete.
const INTER_BYTE_SILENCE_MS: u64 = 30;

/// Serial port that closes on I/O failure and reopens when the device is plugged back in.
pub struct ReconnectingSerial {
    connection: ConnectionConfig,
    port: Mutex<Option<Box<dyn serialport::SerialPort + Send>>>,
    last_open_fail_log: Mutex<Option<Instant>>,
}

impl ReconnectingSerial {
    pub fn new(cfg: &SiteConfig) -> Result<Arc<Self>> {
        let this = Arc::new(Self {
            connection: cfg.connection.clone(),
            port: Mutex::new(None),
            last_open_fail_log: Mutex::new(None),
        });
        let _ = this.try_open();
        Ok(this)
    }

    /// Open the port if it is not already open. Returns `false` when the device is absent.
    pub fn try_open(&self) -> bool {
        let mut guard = match self.port.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        if guard.is_some() {
            return true;
        }
        match open_port_inner(&self.connection) {
            Ok(p) => {
                info!(port = %self.connection.port, "serial port opened");
                *guard = Some(p);
                true
            }
            Err(e) => {
                let should_log = self
                    .last_open_fail_log
                    .lock()
                    .ok()
                    .and_then(|g| g.as_ref().map(|t| t.elapsed() > Duration::from_secs(10)))
                    .unwrap_or(true);
                if should_log {
                    warn!(
                        port = %self.connection.port,
                        ?e,
                        "serial port not available — will retry"
                    );
                    if let Ok(mut g) = self.last_open_fail_log.lock() {
                        *g = Some(Instant::now());
                    }
                }
                false
            }
        }
    }

    fn invalidate(&self) {
        let mut guard = match self.port.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if guard.take().is_some() {
            warn!(
                port = %self.connection.port,
                "serial port invalidated — will reopen on next poll"
            );
        }
    }

    fn with_open_port<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut dyn serialport::SerialPort) -> Result<T>,
    {
        let mut guard = self.port.lock().unwrap();
        let port = guard
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("serial port {} not open", self.connection.port))?;
        match f(port.as_mut()) {
            Ok(v) => Ok(v),
            Err(e) => {
                if port_io_dead(&e) {
                    drop(guard);
                    self.invalidate();
                }
                Err(e)
            }
        }
    }

    /// Poll exchange: clear RX, send, read full response. Reopens the port once on dead I/O.
    pub fn exchange(&self, out: &[u8]) -> Result<Vec<u8>> {
        if !self.try_open() {
            return Ok(Vec::new());
        }
        match self.try_exchange_once(out) {
            Ok(v) => Ok(v),
            Err(e) if port_io_dead(&e) => {
                if self.try_open() {
                    self.try_exchange_once(out).or(Ok(Vec::new()))
                } else {
                    Ok(Vec::new())
                }
            }
            Err(_) => Ok(Vec::new()),
        }
    }

    fn try_exchange_once(&self, out: &[u8]) -> Result<Vec<u8>> {
        let initial_ms = self.connection.response_timeout_ms;
        self.with_open_port(|port| {
            let _ = port.clear(ClearBuffer::Input);
            trace!(tx = %hex_bytes(out), "serial TX");
            serial_log("TX", out);
            port.write_all(out)?;
            port.flush()?;
            let mut rx = read_response_until_silent(port, initial_ms)?;
            // RS-485 dispensers echo the TX bytes back on the bus immediately,
            // then send the actual response frame some time later (~130 ms on
            // Gilbarco hardware).  The echo switches read_response_until_silent
            // to the 30 ms inter-byte timeout before the real frame arrives, so
            // we miss it.  Strip the echo; if nothing remains try one more read
            // with the full initial timeout to catch the late-arriving frame.
            // Offline pumps don't echo at all, so starts_with never fires and
            // there is no extra timeout penalty for them.
            if rx.len() >= out.len() && rx.starts_with(out) {
                rx.drain(..out.len());
                if rx.is_empty() {
                    rx = read_response_until_silent(port, initial_ms)?;
                }
            }
            serial_log("RX", &rx);
            trace!(rx = %hex_bytes(&rx), "serial RX");
            Ok(rx)
        })
    }

    /// Short write (ACK / stop-pre) with the same reopen behaviour.
    pub fn write_only(&self, out: &[u8]) -> Result<()> {
        if !self.try_open() {
            return Ok(());
        }
        match self.try_write_once(out) {
            Ok(()) => Ok(()),
            Err(e) if port_io_dead(&e) => {
                if self.try_open() {
                    let _ = self.try_write_once(out);
                }
                Ok(())
            }
            Err(_) => Ok(()),
        }
    }

    fn try_write_once(&self, out: &[u8]) -> Result<()> {
        self.with_open_port(|port| {
            trace!(tx = %hex_bytes(out), "serial TX (write-only)");
            serial_log("TX", out);
            port.write_all(out)?;
            port.flush()?;
            Ok(())
        })
    }
}

#[allow(dead_code)]
pub fn open_port(cfg: &SiteConfig) -> Result<Box<dyn serialport::SerialPort>> {
    open_port_inner(&cfg.connection)
}

fn open_port_inner(cfg: &ConnectionConfig) -> Result<Box<dyn serialport::SerialPort>> {
    let parity = cfg.parity.to_serialport();
    let stop = match cfg.stop_bits {
        1 => StopBits::One,
        2 => StopBits::Two,
        _ => anyhow::bail!("stop_bits must be 1 or 2"),
    };
    let data = match cfg.data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        8 => DataBits::Eight,
        _ => anyhow::bail!("data_bits must be 5-8"),
    };
    let port = serialport::new(&cfg.port, cfg.baud_rate)
        .parity(parity)
        .stop_bits(stop)
        .data_bits(data)
        .timeout(Duration::from_millis(cfg.response_timeout_ms))
        .open()
        .with_context(|| format!("open serial {}", cfg.port))?;
    Ok(port)
}

/// Read from the port until the bus goes silent for `INTER_BYTE_SILENCE_MS`.
///
/// Two-phase timeout:
///  1. Wait up to `initial_ms` for the **first** byte (dispenser response latency).
///  2. Once any data arrives switch the port timeout to `INTER_BYTE_SILENCE_MS` so that
///     each subsequent read only blocks for the inter-character gap, not the full 600 ms.
///     This makes a successful 3-byte response take ~6 ms + ~30 ms = ~36 ms instead of
///     ~6 ms + 600 ms = ~606 ms.
fn read_response_until_silent(
    port: &mut dyn serialport::SerialPort,
    initial_ms: u64,
) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 512];
    let mut switched = false;

    loop {
        match port.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                if !switched {
                    // First byte received — switch to silence-gap timeout
                    switched = true;
                    let _ = port.set_timeout(Duration::from_millis(INTER_BYTE_SILENCE_MS));
                }
                buf.extend_from_slice(&tmp[..n]);
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                // Either initial wait expired (no response) or silence detected.
                break;
            }
            Err(e) => {
                // Restore port timeout before propagating
                if switched {
                    let _ = port.set_timeout(Duration::from_millis(initial_ms));
                }
                return Err(e.into());
            }
        }
    }

    // Restore the original timeout for the next operation on this port.
    if switched {
        let _ = port.set_timeout(Duration::from_millis(initial_ms));
    }

    Ok(buf)
}

/// Format a byte slice as space-separated hex for logging.
fn hex_bytes(b: &[u8]) -> String {
    b.iter()
        .map(|x| format!("{x:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// True when the OS handle is dead (USB unplugged, permission lost, etc.).
fn port_io_dead(err: &anyhow::Error) -> bool {
    let Some(io) = err.downcast_ref::<std::io::Error>() else {
        return false;
    };
    use std::io::ErrorKind::*;
    match io.kind() {
        TimedOut | WouldBlock | InvalidData | InvalidInput | Interrupted => false,
        NotFound | PermissionDenied | ConnectionReset | ConnectionAborted | BrokenPipe
        | UnexpectedEof | AddrNotAvailable => true,
        Other => {
            #[cfg(unix)]
            {
                matches!(
                    io.raw_os_error(),
                    Some(5) | Some(6) | Some(9) | Some(19) // EIO, ENXIO, EBADF, ENODEV
                )
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
        _ => false,
    }
}
