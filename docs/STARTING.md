# Starting the stack: service, simulator, desktop

All commands assume the **repository root** (`fuel-dispenser/`) unless noted.

## One command, multiple modes (`scripts/azs.sh`)

From the repo root:

```bash
./scripts/azs.sh help
```

Or with npm (same script):

```bash
npm run start -- help
```

**Common modes**

| Mode | What it does |
|------|----------------|
| `dev-mock` | Background **dispenser-service** (in-process MOCK bus) + foreground **Tauri desktop**. Good default for UI work without hardware or `socat`. |
| `dev-sim` | **`socat`** PTY pair + background **wayne-sim** + background **service** (`site.pty.json`, `/tmp/wayne-real`) + foreground **desktop**. Full simulator stack. |
| `sim-backend` | Same as `dev-sim` but **no desktop** — only socat + sim + service (all background, `disown`). |
| `service-mock-fg` | Foreground service only (mock config). |
| `service-mock-bg` / `service-pty-bg` | Background service only (`site.mock.json` vs `site.pty.json`). |
| `desktop` | Desktop only; expects service already on port 3001. |
| `stop` | Kills PIDs saved under `.azs-run/` from this launcher. |

**Configuration** uses environment variables (see `./scripts/azs.sh help`), including:

- `AZS_SERVICE_MOCK`, `AZS_SERVICE_PTY` — paths to site configs (defaults: `services/dispenser-service/site.mock.json`, `site.pty.json`).
- `AZS_SIM_CONFIG`, `AZS_PTY_REAL`, `AZS_PTY_SIM`, `AZS_STATE_DIR`.

Configs shipped for the launcher:

- `services/dispenser-service/site.mock.json` — `protocol: mock`, separate SQLite file.
- `services/dispenser-service/site.pty.json` — `wayne_europump` + `/tmp/wayne-real` + **odd** parity (matches `tools/simulators/wayne-sim/sim.config.json`).

---

## Prerequisites

- **Rust** toolchain (`cargo`, `rustc`) with a default stable profile.
- **Node.js** and **npm** (for the desktop UI and Tauri CLI).
- **Tauri v2** host dependencies (WebKitGTK on Linux, Xcode on macOS, WebView2 on Windows). See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.
- **socat** (recommended on Linux/macOS for **Option B**) to create a linked pseudo-terminal pair so the simulator and dispenser-service each open a different end of the same virtual link.

---

## Ports and URLs (defaults)

| Component            | Default URL / port |
|---------------------|--------------------|
| `dispenser-service` | `http://127.0.0.1:3001` (HTTP + WebSocket `/ws`) |
| `wayne-sim` API     | `http://127.0.0.1:3002` (control only) |
| Desktop → service   | `AZS_SERVICE_URL` or `http://127.0.0.1:3001` |

---

## Option A — Service only (built-in mock serial)

`services/dispenser-service/site.config.json` can use `"protocol": "mock"` and `"port": "MOCK"`. The service then talks to an **in-process** mock bus; **wayne-sim does not need to run** for basic UI and poll behaviour.

**Terminal 1 — dispenser-service**

```bash
cargo run -p dispenser-service -- run --config services/dispenser-service/site.config.json
```

**Terminal 2 — desktop (Tauri + React)**

```bash
cd apps/desktop
npm install
npm run tauri dev
```

From `apps/desktop` you can also use:

```bash
npm run service:mock
```

in another terminal (same as the `cargo run` above with the bundled config path).

---

## Virtual serial port (socat)

Two programs cannot open the **same** PTY device for exclusive full-duplex serial like two real cables. Use **socat** to create a **pair** of symlinked PTYs: one path for `wayne-sim`, the other for `dispenser-service`.

### 1. Install `socat`

- **Debian / Ubuntu:** `sudo apt install socat`
- **Fedora:** `sudo dnf install socat`
- **macOS:** `brew install socat`

### 2. Start `socat` (leave this terminal open)

From the repo root (or any directory; paths are absolute):

```bash
rm -f /tmp/wayne-real /tmp/wayne-sim
socat -d -d \
  pty,raw,echo=0,link=/tmp/wayne-real \
  pty,raw,echo=0,link=/tmp/wayne-sim
```

- **`/tmp/wayne-real`** — point **`dispenser-service`** `connection.port` here.
- **`/tmp/wayne-sim`** — point **`wayne-sim`** `virtual_port` here (this matches the default in `tools/simulators/wayne-sim/sim.config.json`).

You should see `socat` logging that it created the link endpoints. If open fails later, remove stale symlinks with the `rm` line above and restart `socat`.

**Windows:** use WSL2 and the same `socat` command inside Linux, or another PTY bridge your team standardises on; the repo paths above are examples—change them consistently in both configs.

---

## Option B — Service + Wayne simulator (real serial loop)

Use this when **wayne-sim** answers Europump frames on the virtual wire and **dispenser-service** polls that bus.

### 1. Align configs with the PTY pair and each other

**`tools/simulators/wayne-sim/sim.config.json`**

- **`virtual_port`:** `/tmp/wayne-sim` (simulator side; default in repo).

**`services/dispenser-service/site.config.json`**

- **`connection.port`:** `/tmp/wayne-real` (service side — **not** the same path as the sim).
- **`connection.protocol`:** **`wayne_europump`** (not `mock`).
- Match **`baud_rate`**, **`parity`**, **`data_bits`**, and **`stop_bits`** to the simulator (`sim.config.json` uses `9600` and `odd` by default).

`fueling_positions` / addresses should match what the simulator builds from the same universal site file (`site_config_path` in `sim.config.json` points at `services/dispenser-service/site.config.json`).

### 2. Start order

1. **`socat`** — virtual port pair (see [Virtual serial port (socat)](#virtual-serial-port-socat) above).
2. **`wayne-sim`** — opens `/tmp/wayne-sim` and retries until it succeeds:

   ```bash
   cargo run -p wayne-sim -- tools/simulators/wayne-sim/sim.config.json
   ```

3. **`dispenser-service`** — opens `/tmp/wayne-real`:

   ```bash
   cargo run -p dispenser-service -- run --config services/dispenser-service/site.config.json
   ```

4. **Desktop**:

   ```bash
   cd apps/desktop
   npm run tauri dev
   ```

### 3. Pointing the desktop at the service

By default the Tauri app uses `http://127.0.0.1:3001`. To override:

```bash
export AZS_SERVICE_URL=http://127.0.0.1:3001
cd apps/desktop && npm run tauri dev
```

---

## Simulator HTTP API (optional)

`wayne-sim` exposes control endpoints on port **3002** (see `sim.config.json`). Examples:

- `GET http://127.0.0.1:3002/sim/state`
- `POST http://127.0.0.1:3002/sim/nozzle-up` with JSON body `{"fp_id":"FP1","nozzle":1}` (optional fields: `product`, `product_name`, `price`; legacy `addr` such as `"P0"` is still accepted)

---

## SQLite migrations

The service runs SQLx migrations from `services/dispenser-service/migrations/` on startup. If you see a checksum error after pulling migration edits, remove the local DB file used in `site.config.json` (for example `services/dispenser-service/transactions.db`) and start the service again (development only; you lose local transaction history).

---

## Quick checklist

- [ ] Service listening: open `http://127.0.0.1:3001/health` in a browser or `curl` it.
- [ ] Desktop shows data: WebSocket connects and status cards update (or hit `GET /status`).
- [ ] With **Option B**: **`socat`** is running; **`wayne-sim`** log shows `virtual_port` opened; **`dispenser-service`** uses the **other** symlink (`wayne-real`); baud and parity match `sim.config.json`.

---

## Production-style run (built frontend)

```bash
cd apps/desktop
npm run build
npm run tauri build
```

Install/run the generated bundle from `apps/desktop/src-tauri/target/release/` (exact artefact name depends on the target triple).
