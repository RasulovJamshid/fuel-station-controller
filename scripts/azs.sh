#!/usr/bin/env bash
# Unified dev launcher. Usage: ./scripts/azs.sh <mode>   or   npm run start -- <mode>
#
# Environment (optional):
#   AZS_STATE_DIR           PID/log directory (default: <repo>/.azs-run)
#   AZS_SERVICE_MOCK        Site config for mock bus (default: services/dispenser-service/site.mock.json)
#   AZS_SERVICE_PTY         Site config for PTY + wayne-sim (default: services/dispenser-service/site.pty.json)
#   AZS_SERVICE_REAL        Site config for real hardware (default: services/dispenser-service/site.real.json)
#   AZS_SERVICE_CONFIG      Override site config for generic service-* modes
#   AZS_SIM_URL             Simulator HTTP API URL (default: auto-detected — 3002 for Wayne, 3003 for Gilbarco)
#   AZS_SERVICE_URL         dispenser-service HTTP API (default: http://127.0.0.1:3001)
#   AZS_PTY_REAL / AZS_PTY_SIM        Wayne PTY symlink paths (defaults: /tmp/wayne-real, /tmp/wayne-sim)
#   AZS_GBR_PTY_REAL / AZS_GBR_PTY_SIM  Gilbarco PTY symlink paths (defaults: /tmp/gilbarco-real, /tmp/gilbarco-sim)
#   AZS_SIM_CONFIG          Wayne sim JSON (default: tools/simulators/wayne-sim/sim.config.json)
#   AZS_GBR_SIM_CONFIG      Gilbarco sim JSON (default: tools/simulators/gilbarco-sim/sim.config.json)
#   AZS_SERIAL_PORT         Real serial port override (default: /dev/ttyUSB0)
#   AZS_SERIAL_LOG          Enable raw serial frame log. Set to "1" for default path
#                           (.azs-run/serial.log) or a custom file path. Unset = off.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STATE_DIR="${AZS_STATE_DIR:-$ROOT/.azs-run}"
mkdir -p "$STATE_DIR"

AZS_SERVICE_MOCK="${AZS_SERVICE_MOCK:-services/dispenser-service/site.mock.json}"
AZS_SERVICE_PTY="${AZS_SERVICE_PTY:-services/dispenser-service/site.pty.json}"
AZS_SERVICE_REAL="${AZS_SERVICE_REAL:-services/dispenser-service/site.real.json}"
AZS_SIM_CONFIG="${AZS_SIM_CONFIG:-tools/simulators/wayne-sim/sim.config.json}"
AZS_GBR_SIM_CONFIG="${AZS_GBR_SIM_CONFIG:-tools/simulators/gilbarco-sim/sim.config.json}"
AZS_PTY_REAL="${AZS_PTY_REAL:-/tmp/wayne-real}"
AZS_PTY_SIM="${AZS_PTY_SIM:-/tmp/wayne-sim}"
AZS_GBR_PTY_REAL="${AZS_GBR_PTY_REAL:-/tmp/gilbarco-real}"
AZS_GBR_PTY_SIM="${AZS_GBR_PTY_SIM:-/tmp/gilbarco-sim}"
AZS_SERIAL_PORT="${AZS_SERIAL_PORT:-/dev/ttyUSB0}"
# Resolve AZS_SERIAL_LOG: "1" → default log path; custom path → use as-is; unset → off.
AZS_SERIAL_LOG="${AZS_SERIAL_LOG:-}"
if [[ "$AZS_SERIAL_LOG" == "1" ]]; then
  AZS_SERIAL_LOG="$STATE_DIR/serial.log"
fi
export AZS_SERIAL_LOG

SOCAT_PID=""
SIM_PID=""
SIM_PID_FILE=""
SERVICE_PID=""

usage() {
  cat <<'EOF'
Unified dev launcher for dispenser-service, wayne-sim, and desktop.

Usage:
  ./scripts/azs.sh <mode>
  npm run start -- <mode>

Environment (optional):
  AZS_STATE_DIR       PID/log directory (default: <repo>/.azs-run)
  AZS_SERVICE_MOCK    Mock site config (default: services/dispenser-service/site.mock.json)
  AZS_SERVICE_PTY     PTY site config (default: services/dispenser-service/site.pty.json)
  AZS_SERVICE_CONFIG  Override site config for service-* modes
  AZS_SIM_CONFIG          Wayne sim JSON (default: tools/simulators/wayne-sim/sim.config.json)
  AZS_GBR_SIM_CONFIG      Gilbarco sim JSON (default: tools/simulators/gilbarco-sim/sim.config.json)
  AZS_SIM_URL             Simulator HTTP base (auto: 3002 for Wayne, 3003 for Gilbarco)
  AZS_SERVICE_URL         dispenser-service HTTP base (default: http://127.0.0.1:3001)
  AZS_PTY_REAL / AZS_PTY_SIM             Wayne PTY paths (defaults: /tmp/wayne-real, /tmp/wayne-sim)
  AZS_GBR_PTY_REAL / AZS_GBR_PTY_SIM    Gilbarco PTY paths (defaults: /tmp/gilbarco-real, /tmp/gilbarco-sim)
  AZS_SERIAL_LOG      Raw serial frame log. "1" → .azs-run/serial.log; custom path → that file.
                      Unset or empty = disabled (default).

Modes:
  help              Show this help.

  ── Real hardware ──────────────────────────────────────────────────────────
  dev-real          PRODUCTION: service (site.real.json) + operator desktop.
                    No simulator. Serial port read from AZS_SERIAL_PORT (default /dev/ttyUSB0)
                    or set directly in services/dispenser-service/site.real.json.

  service-real-fg   Foreground: dispenser-service with site.real.json only (no UI).
  service-real-bg   Background: same, logs in .azs-run/service.log.

  ── Simulator ──────────────────────────────────────────────────────────────
  service-mock-fg   Foreground: dispenser-service with in-process MOCK serial (site.mock.json).
  service-mock-bg   Background: same service; logs in .azs-run/service.log; PID in service.pid
  service-pty-bg    Background: service with site.pty.json (Wayne + /tmp/wayne-real). Start socat + sim first, or use dev-sim.

  sim-backend       Background: socat PTY pair + wayne-sim + dispenser-service (PTY stack). No UI.
  dev-mock          Background service (mock) + foreground operator desktop.
  dev-sim           Full stack: socat + simulator + service (bg) + sim control desktop (bg)
                    + operator desktop (fg). Two windows.
                    Protocol auto-detected from AZS_SERVICE_CONFIG (gilbarco or wayne).
                    Example: AZS_SERVICE_CONFIG=services/dispenser-service/site.config.gilbarco.json ./scripts/azs.sh dev-sim

  desktop           Foreground: operator desktop only (expects service on :3001).
  sim-desktop       Foreground: Wayne sim control only (expects sim on :3002).

  stop              Kill processes recorded in .azs-run/*.pid (from this tool).

Examples:
  ./scripts/azs.sh dev-mock
  AZS_STATE_DIR=/tmp/azs ./scripts/azs.sh dev-sim
  npm run start -- dev-mock
  AZS_SERIAL_LOG=1 ./scripts/azs.sh dev-real        # serial log → .azs-run/serial.log
  AZS_SERIAL_LOG=/tmp/serial.log ./scripts/azs.sh dev-real
EOF
}

stop_one_pidfile() {
  local f="$1"
  if [[ -f "$f" ]]; then
    local p
    p="$(cat "$f")"
    if kill -0 "$p" 2>/dev/null; then
      kill "$p" 2>/dev/null || true
      wait "$p" 2>/dev/null || true
    fi
    rm -f "$f"
  fi
}

stop_recorded() {
  stop_one_pidfile "$STATE_DIR/sim-desktop.pid"
  stop_one_pidfile "$STATE_DIR/service.pid"
  stop_one_pidfile "$STATE_DIR/wayne-sim.pid"
  stop_one_pidfile "$STATE_DIR/gilbarco-sim.pid"
  stop_one_pidfile "$STATE_DIR/socat.pid"
}

cleanup_dev() {
  stop_one_pidfile "$STATE_DIR/sim-desktop.pid"
  if [[ -n "${SERVICE_PID:-}" ]]; then
    kill "$SERVICE_PID" 2>/dev/null || true
    wait "$SERVICE_PID" 2>/dev/null || true
    rm -f "$STATE_DIR/service.pid"
  fi
  if [[ -n "${SIM_PID:-}" ]]; then
    kill "$SIM_PID" 2>/dev/null || true
    wait "$SIM_PID" 2>/dev/null || true
    rm -f "${SIM_PID_FILE:-$STATE_DIR/wayne-sim.pid}"
  fi
  if [[ -n "${SOCAT_PID:-}" ]]; then
    kill "$SOCAT_PID" 2>/dev/null || true
    wait "$SOCAT_PID" 2>/dev/null || true
    rm -f "$STATE_DIR/socat.pid"
  fi
}

start_socat() {
  local pty_real="${1:-$AZS_PTY_REAL}"
  local pty_sim="${2:-$AZS_PTY_SIM}"
  if ! command -v socat >/dev/null 2>&1; then
    echo "error: 'socat' not found. Install it (e.g. apt install socat / brew install socat)." >&2
    exit 1
  fi
  rm -f "$pty_real" "$pty_sim"
  socat -d -d \
    pty,raw,echo=0,link="$pty_real" \
    pty,raw,echo=0,link="$pty_sim" \
    >"$STATE_DIR/socat.log" 2>&1 &
  SOCAT_PID=$!
  echo "$SOCAT_PID" >"$STATE_DIR/socat.pid"
  echo "socat PID $SOCAT_PID (PTY: service=$pty_real  sim=$pty_sim, log: $STATE_DIR/socat.log)"
  sleep 0.8
}

start_sim_bg() {
  cargo run -p wayne-sim -- "$AZS_SIM_CONFIG" >"$STATE_DIR/wayne-sim.log" 2>&1 &
  SIM_PID=$!
  SIM_PID_FILE="$STATE_DIR/wayne-sim.pid"
  echo "$SIM_PID" >"$SIM_PID_FILE"
  echo "wayne-sim PID $SIM_PID (log: $STATE_DIR/wayne-sim.log)"
  sleep 0.8
}

start_gilbarco_sim_bg() {
  cargo run -p gilbarco-sim -- "$AZS_GBR_SIM_CONFIG" >"$STATE_DIR/gilbarco-sim.log" 2>&1 &
  SIM_PID=$!
  SIM_PID_FILE="$STATE_DIR/gilbarco-sim.pid"
  echo "$SIM_PID" >"$SIM_PID_FILE"
  echo "gilbarco-sim PID $SIM_PID (log: $STATE_DIR/gilbarco-sim.log)"
  sleep 0.8
}

start_service_bg() {
  local cfg="$1"
  cargo run -p dispenser-service -- run --config "$cfg" >"$STATE_DIR/service.log" 2>&1 &
  SERVICE_PID=$!
  echo "$SERVICE_PID" >"$STATE_DIR/service.pid"
  echo "dispenser-service PID $SERVICE_PID (config: $cfg, log: $STATE_DIR/service.log)"
  sleep 1.2
}

# Resolve the real-hardware config, optionally patching the serial port.
# If AZS_SERIAL_PORT differs from the value in site.real.json, write a temp
# copy with the port overridden so the operator doesn't have to hand-edit JSON.
resolve_real_config() {
  local base_cfg="${AZS_SERVICE_CONFIG:-$AZS_SERVICE_REAL}"
  local cfg_port
  cfg_port="$(python3 -c "import json,sys; print(json.load(open('$base_cfg'))['connection']['port'])" 2>/dev/null || echo "")"
  if [[ -n "$cfg_port" && "$cfg_port" != "$AZS_SERIAL_PORT" ]]; then
    local tmp_cfg="$STATE_DIR/site.real.tmp.json"
    python3 - "$base_cfg" "$AZS_SERIAL_PORT" "$tmp_cfg" <<'PYEOF'
import json, sys
cfg = json.load(open(sys.argv[1]))
cfg["connection"]["port"] = sys.argv[2]
json.dump(cfg, open(sys.argv[3], "w"), indent=2)
PYEOF
    echo "  (serial port overridden: $cfg_port → $AZS_SERIAL_PORT)"
    echo "$tmp_cfg"
  else
    echo "$base_cfg"
  fi
}

# Return the protocol field from connection.protocol in a site config, or "wayne" if absent/unreadable.
detect_protocol() {
  local cfg="${1:-}"
  [[ -z "$cfg" ]] && { echo "wayne"; return; }
  python3 -c "import json,sys; print(json.load(open('$cfg')).get('connection',{}).get('protocol','wayne'))" 2>/dev/null || echo "wayne"
}

# Write a temp copy of $1 with connection.port replaced by $2; print the tmp path.
patch_config_port() {
  local base_cfg="$1"
  local new_port="$2"
  local tmp_cfg="$STATE_DIR/site.pty.tmp.json"
  python3 - "$base_cfg" "$new_port" "$tmp_cfg" <<'PYEOF'
import json, sys
cfg = json.load(open(sys.argv[1]))
cfg["connection"]["port"] = sys.argv[2]
json.dump(cfg, open(sys.argv[3], "w"), indent=2)
PYEOF
  echo "$tmp_cfg"
}

start_sim_desktop_bg() {
  if [[ ! -d "$ROOT/apps/sim-desktop/node_modules" ]]; then
    echo "Installing sim-desktop npm deps (first run)…"
    (cd "$ROOT/apps/sim-desktop" && npm install)
  fi
  (
    cd "$ROOT/apps/sim-desktop"
    export AZS_SIM_URL="${AZS_SIM_URL:-http://127.0.0.1:3002}"
    export AZS_SERVICE_URL="${AZS_SERVICE_URL:-http://127.0.0.1:3001}"
    npm run tauri dev
  ) >"$STATE_DIR/sim-desktop.log" 2>&1 &
  local pid=$!
  echo "$pid" >"$STATE_DIR/sim-desktop.pid"
  echo "sim-desktop PID $pid (Vite :5174, log: $STATE_DIR/sim-desktop.log)"
  sleep 2
}

MODE="${1:-help}"

if [[ "$MODE" == "help" || "$MODE" == "-h" || "$MODE" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$MODE" == "stop" ]]; then
  stop_recorded
  echo "Stopped recorded PIDs under $STATE_DIR"
  exit 0
fi

case "$MODE" in
  # ── Real hardware modes ──────────────────────────────────────────────────
  dev-real)
    # Check serial port exists before starting
    real_cfg="$(resolve_real_config)"
    real_port="$(python3 -c "import json,sys; print(json.load(open('$real_cfg'))['connection']['port'])" 2>/dev/null || echo "$AZS_SERIAL_PORT")"
    if [[ ! -e "$real_port" ]]; then
      echo ""
      echo "  ⚠  Serial port '$real_port' not found."
      echo "  Available ports:"
      ls /dev/ttyUSB* /dev/ttyS* /dev/ttyACM* 2>/dev/null | sed 's/^/    /' || echo "    (none found)"
      echo ""
      echo "  Set the correct port with:"
      echo "    AZS_SERIAL_PORT=/dev/ttyS0 ./scripts/azs.sh dev-real"
      echo "  or edit: services/dispenser-service/site.real.json  →  connection.port"
      echo ""
      exit 1
    fi
    echo "Connecting to real hardware on $real_port …"
    # Kill any leftover service on port 3001
    fuser -k 3001/tcp 2>/dev/null || true
    sleep 0.2
    trap cleanup_dev EXIT INT TERM
    start_service_bg "$real_cfg"
    echo "Starting operator desktop (Ctrl+C stops service)…"
    cd apps/desktop
    npm run tauri dev
    ;;

  service-real-fg)
    real_cfg="$(resolve_real_config)"
    exec cargo run -p dispenser-service -- run --config "$real_cfg"
    ;;

  service-real-bg)
    real_cfg="$(resolve_real_config)"
    start_service_bg "$real_cfg"
    [[ -n "${SERVICE_PID:-}" ]] && disown "$SERVICE_PID" 2>/dev/null || true
    echo "Service running in background (real hardware). Stop with: $0 stop"
    ;;

  # ── Simulator modes ──────────────────────────────────────────────────────
  service-mock-fg)
    exec cargo run -p dispenser-service -- run --config "${AZS_SERVICE_CONFIG:-$AZS_SERVICE_MOCK}"
    ;;
  service-mock-bg)
    start_service_bg "${AZS_SERVICE_CONFIG:-$AZS_SERVICE_MOCK}"
    [[ -n "${SERVICE_PID:-}" ]] && disown "$SERVICE_PID" 2>/dev/null || true
    echo "Service running in background. Stop with: $0 stop"
    ;;
  service-pty-bg)
    start_service_bg "${AZS_SERVICE_CONFIG:-$AZS_SERVICE_PTY}"
    [[ -n "${SERVICE_PID:-}" ]] && disown "$SERVICE_PID" 2>/dev/null || true
    echo "Service running in background. Stop with: $0 stop"
    ;;
  sim-backend)
    start_socat
    start_sim_bg
    start_service_bg "${AZS_SERVICE_CONFIG:-$AZS_SERVICE_PTY}"
    [[ -n "${SOCAT_PID:-}" ]] && disown "$SOCAT_PID" 2>/dev/null || true
    [[ -n "${SIM_PID:-}" ]] && disown "$SIM_PID" 2>/dev/null || true
    [[ -n "${SERVICE_PID:-}" ]] && disown "$SERVICE_PID" 2>/dev/null || true
    echo "Sim stack running (no desktop). Logs: $STATE_DIR/*.log   Stop: $0 stop"
    ;;
  dev-mock)
    trap cleanup_dev EXIT INT TERM
    start_service_bg "${AZS_SERVICE_CONFIG:-$AZS_SERVICE_MOCK}"
    echo "Starting desktop (Ctrl+C stops desktop and background service)…"
    export AZS_SIM_URL="${AZS_SIM_URL:-http://127.0.0.1:3002}"
    cd apps/desktop
    npm run tauri dev
    ;;
  dev-sim)
    trap cleanup_dev EXIT INT TERM
    # Kill any stale processes from a previous run before starting fresh
    stop_recorded
    # Kill anything still listening on the service / sim ports
    fuser -k 3001/tcp 2>/dev/null || true
    fuser -k 3002/tcp 2>/dev/null || true
    fuser -k 3003/tcp 2>/dev/null || true
    sleep 0.3
    _svc_cfg="${AZS_SERVICE_CONFIG:-}"
    _protocol="$(detect_protocol "$_svc_cfg")"
    if [[ "$_protocol" == "gilbarco" ]]; then
      start_socat "$AZS_GBR_PTY_REAL" "$AZS_GBR_PTY_SIM"
      start_gilbarco_sim_bg
      _pty_cfg="$(patch_config_port "$_svc_cfg" "$AZS_GBR_PTY_REAL")"
      start_service_bg "$_pty_cfg"
      export AZS_SIM_URL="${AZS_SIM_URL:-http://127.0.0.1:3003}"
    else
      start_socat
      start_sim_bg
      start_service_bg "${_svc_cfg:-$AZS_SERVICE_PTY}"
      export AZS_SIM_URL="${AZS_SIM_URL:-http://127.0.0.1:3002}"
    fi
    export AZS_SERVICE_URL="${AZS_SERVICE_URL:-http://127.0.0.1:3001}"
    start_sim_desktop_bg
    echo "Starting operator desktop (Ctrl+C stops both desktops, service, sim, socat)…"
    cd apps/desktop
    npm run tauri dev
    ;;
  desktop)
    export AZS_SIM_URL="${AZS_SIM_URL:-http://127.0.0.1:3002}"
    export AZS_SERVICE_URL="${AZS_SERVICE_URL:-http://127.0.0.1:3001}"
    cd apps/desktop
    exec npm run tauri dev
    ;;
  sim-desktop)
    export AZS_SIM_URL="${AZS_SIM_URL:-http://127.0.0.1:3002}"
    export AZS_SERVICE_URL="${AZS_SERVICE_URL:-http://127.0.0.1:3001}"
    cd apps/sim-desktop
    exec npm run tauri dev
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    usage >&2
    exit 1
    ;;
esac
