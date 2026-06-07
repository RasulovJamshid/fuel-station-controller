# Windows production deployment

This guide covers building release binaries and installing them as auto-starting Windows services.

---

## Prerequisites (do once on the Windows build machine)

| Tool | Where to get it |
|------|----------------|
| Rust stable toolchain | https://rustup.rs — pick the `x86_64-pc-windows-msvc` default |
| Visual Studio C++ Build Tools | https://aka.ms/vs/17/release/vs_BuildTools.exe — install "Desktop development with C++" |
| Node.js 20+ | https://nodejs.org |
| WebView2 Runtime | Already present on Windows 10/11; if missing: https://developer.microsoft.com/microsoft-edge/webview2/ |
| NSSM | https://nssm.cc/download — extract `nssm.exe` to a folder in `PATH` (e.g. `C:\tools\`) |

Verify:
```powershell
rustc --version
cargo --version
node --version
nssm version
```

---

## 1 — Build `dispenser-service.exe`

Run from the **repository root** on Windows:

```powershell
cargo build -p dispenser-service --release
```

Output: `target\release\dispenser-service.exe`

---

## 2 — Build the desktop app (`AZS Manager`)

```powershell
cd apps\desktop
npm install
npm run tauri build
```

> **Note:** `tauri.conf.json` currently has `"bundle": { "active": false }`.
> This produces a raw `.exe` but no installer.
> To also generate an NSIS installer or MSI, change it to `"active": true` before building.

Output: `apps\desktop\src-tauri\target\release\azs-desktop.exe`

---

## 3 — Prepare the deployment folder

Create a folder, e.g. `C:\azs\`, and copy into it:

```
C:\azs\
  dispenser-service.exe      ← from target\release\
  site.config.json           ← your production site config (see below)
  azs-desktop.exe            ← optional, only if running desktop on the same machine
  logs\                      ← empty folder; NSSM writes logs here
```

### Production `site.config.json` adjustments

| Field | Linux dev value | Windows value |
|-------|----------------|---------------|
| `connection.port` | `/tmp/wayne-real` | `COM3` (check Device Manager for your RS-485 adapter) |
| `service.db_path` | `transactions.db` | `C:\azs\transactions.db` (absolute path recommended) |
| `service.log_file` | `service.log` | `C:\azs\logs\service.log` |

Everything else (baud rate, parity, polling, products) stays the same.

---

## 4 — Register the service with NSSM

Open an **Administrator** PowerShell and run once:

```powershell
nssm install AzsService "C:\azs\dispenser-service.exe"
nssm set AzsService AppParameters "run --config C:\azs\site.config.json"
nssm set AzsService AppDirectory "C:\azs"
nssm set AzsService DisplayName "AZS Dispenser Service"
nssm set AzsService Description "Wayne Europump poll loop and HTTP API"
nssm set AzsService Start SERVICE_AUTO_START
nssm set AzsService AppStdout "C:\azs\logs\service.log"
nssm set AzsService AppStderr "C:\azs\logs\service.err"
nssm set AzsService AppRotateFiles 1
nssm set AzsService AppRotateBytes 10485760
nssm start AzsService
```

`AppRotateFiles` + `AppRotateBytes` rotates the log when it reaches ~10 MB.

### Verify it started

```powershell
nssm status AzsService          # should print SERVICE_RUNNING
curl http://127.0.0.1:3001/health
```

Or open `services.msc` and find **AZS Dispenser Service** — status should be **Running**.

---

## 5 — Day-to-day management

| Task | Command (Admin PowerShell) |
|------|---------------------------|
| Stop service | `nssm stop AzsService` |
| Start service | `nssm start AzsService` |
| Restart service | `nssm restart AzsService` |
| Remove service | `nssm stop AzsService && nssm remove AzsService confirm` |
| View live logs | `Get-Content C:\azs\logs\service.log -Wait` |
| Edit NSSM settings | `nssm edit AzsService` (opens GUI) |

After updating `site.config.json` you must restart the service for changes to take effect:
```powershell
nssm restart AzsService
```

After replacing `dispenser-service.exe` with a new build:
```powershell
nssm stop AzsService
# copy new exe into C:\azs\
nssm start AzsService
```

---

## 6 — Desktop app

`azs-desktop.exe` is a standalone executable — just double-click or create a desktop shortcut. It connects to the service on `http://127.0.0.1:3001` by default.

To override the service URL set the environment variable before launching:
```powershell
$env:AZS_SERVICE_URL = "http://127.0.0.1:3001"
.\azs-desktop.exe
```

To auto-start the desktop on login, place a shortcut to `azs-desktop.exe` in:
```
C:\Users\<username>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\
```

---

## Troubleshooting

**Service fails to start — serial port error**
Check `C:\azs\logs\service.err`. The most common cause is the wrong COM port name. Open Device Manager → Ports (COM & LPT) and match the port string exactly (e.g. `COM3`).

**Service starts but desktop shows no data**
Run `curl http://127.0.0.1:3001/health` in PowerShell. If it returns JSON the service is up; check that the desktop is not blocked by Windows Firewall on loopback (rare but possible).

**SQLite locked error in logs**
This means a previous instance did not shut down cleanly. Stop the service, delete any `.db-shm` and `.db-wal` files alongside `transactions.db`, and start again. SQLite WAL mode recovers safely this way.
