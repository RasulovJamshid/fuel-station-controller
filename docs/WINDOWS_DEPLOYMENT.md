# Windows production deployment

## At each station: run one installer

Use **AZS-Station-Setup-<version>-x64.exe** on Windows 10/11 x64. The installer
contains the compiled dispenser service, desktop app, NSSM and the full offline
WebView2 runtime. Station computers do not need Node.js, Rust, Chocolatey, Inno
Setup, or an internet connection for installation.

1. For a new station, create and download its `site.config.json` from the web
   configuration wizard. Set the serial connection to the station's Windows COM
   port (for example `COM3`). Use Windows paths or relative paths for database and
   serial log files. Relative paths are resolved from the station folder.
2. Copy the installer and configuration to the station computer.
3. Finish dispensing and close AZS Manager. Run the installer and approve the
   Windows Administrator prompt.
4. Choose the station folder, normally `C:\azs`. On a new station, select the
   downloaded configuration. On an existing NSSM installation, setup detects the
   installed folder and keeps the existing configuration automatically.
5. Confirm the station is ready for maintenance, then install. Setup validates
   the configuration, backs up an existing station, installs the applications,
   registers automatic service startup for a new station, starts the service,
   and checks its local `/health` response.
6. Open **AZS Manager** using the desktop shortcut. Its launcher reads the local
   service port from the existing configuration, including non-default ports.

The WebView2 runtime is installed for all users only when the machine does not
already have it. The desktop runs as the logged-in operator. Setup does not
launch the desktop elevated, open firewall ports, or change dispensing behavior.

Existing desktop administration, products, prices, nozzles, tanks, ATG setup,
PINs, shifts and transactions remain available. On an existing station, the
local database remains the source of truth for products/nozzles; selecting a
new configuration during an upgrade cannot silently replace these settings.
Use the existing administration tools to change them.

## Upgrading an existing station

Run the new installer during a maintenance window. It recognizes `AzsService`
installed using the previous NSSM guide, including a custom config filename or
working directory. It preserves the existing NSSM executable, service account,
startup mode, environment, arguments and logging configuration. It does not
unregister/recreate an existing service.

An unknown service wrapper, unrecognized startup arguments, missing existing
configuration/database, running desktop/manual service, occupied API port, or
invalid new binary/configuration causes setup to stop with an explanation.
Finish the reported correction before retrying. Do not change the installation
folder to work around such an error; doing so could point at another database.

Before replacing binaries, setup stops the service and creates:

```text
C:\azs\backups\<timestamp>-<id>\
  files.json                # original path -> backup filename
  service.reg               # existing Windows service registration
  <number>-<filename>        # config, binaries, database and SQLite sidecars
```

Backup access is restricted to Administrators and SYSTEM. The SQLite database
and any `-wal`, `-shm` and `-journal` files are copied together while the service
is stopped. Setup never deletes SQLite journals or resets a PIN/database.

If installation fails **before** trying to start the updated service, setup
restores replaced files and restarts a previously running service. If startup
was attempted, migrations and normal application startup may already have
written data. In that case setup stops the service, keeps the updated files and
backup, and reports the failure. It does **not** automatically restore an old
database or run old binaries against a potentially migrated database. Review
logs and resolve the failure before restarting. Any manual restore must use a
consistent backup and account for data received since startup.

The installer does not provide a data-deleting uninstaller. To remove only the
service registration, stop it during maintenance and use the existing NSSM
`remove AzsService confirm` command; keep the station folder and backups.

## Build the installer once, distribute it to many stations

### GitHub Actions

Run the **Windows station installer** workflow manually and choose a numeric
version such as `0.1.0`. Download its **AZS-Station-Setup-x64** artifact after it
passes. It contains the installer and a SHA-256 checksum file. The workflow
builds both applications, runs installer safety tests and a real Windows
install/upgrade test using mock pumps, and compiles the installer with Inno
Setup. It does not deploy to production or connect to physical dispensers.

### Windows build machine

Install these tools on the build machine only:

- Rust stable with the `x86_64-pc-windows-msvc` toolchain.
- Visual Studio C++ Build Tools, including **Desktop development with C++**.
- Node.js 22 or later.
- [Inno Setup 6](https://jrsoftware.org/isinfo.php), at its default location or
  supplied using `-IsccPath`.

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\windows\Build-Installer.ps1 -BuildVersion 0.1.0
```

The script builds the service and Tauri desktop, fetches the offline dependencies
on the build machine, and writes:

```text
dist\windows-installer\AZS-Station-Setup-0.1.0-x64.exe
dist\windows-installer\AZS-Station-Setup-0.1.0-x64.exe.sha256
```

The Rust workspace puts **both** binaries under `target\release`. The existing
Tauri `bundle.active = false` setting stays unchanged; Inno Setup packages both
applications together. No station-specific configuration, database or API token
is bundled into the installer.

Dependencies are cached under `dist\windows-installer\dependencies`:

- NSSM **2.24-101-g897c7ad win64** from the [official download](https://nssm.cc/download),
  kept under `tools/windows/vendor` with its provenance and pinned SHA-256.
  No NSSM download is needed during a build. This is the official Windows 10+
  compatibility build. Existing installations retain their current NSSM.
- Microsoft's signed **WebView2 Evergreen standalone x64 installer**, not the
  small online bootstrapper. See [offline distribution](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution).

For a build using cached dependencies and already compiled release binaries:

```powershell
.\tools\windows\Build-Installer.ps1 -SkipBuild -Offline -BuildVersion 0.1.0
```

`-Offline` prevents dependency downloads; use `-SkipBuild` as well to avoid Cargo
and npm downloads. A custom cache can be passed with `-DependencyDir`. Build
inputs are verified, and the packaged payload gets its own SHA-256 manifest.
Sign the final installer through your normal release signing process if your
organization requires signed executables; no signing key is stored in the repo.

### Verification

```powershell
powershell -NoProfile -File tools\windows\tests\StationSetup.Tests.ps1
cargo build -p dispenser-service
python tools\checks\validate_config.py target\debug\dispenser-service.exe
```

The safety suite substitutes Windows service/process calls and uses temporary
files. The separate `WindowsIntegration.Tests.ps1` requires an Administrator
session on a disposable Windows machine with no `AzsService`. It installs a real
NSSM service with mock pumps, checks custom paths and database preservation, and
runs the compiled installer for upgrade and fresh-install scenarios. CI runs
this test before publishing the installer artifact.

## Day-to-day management

Use Administrator PowerShell or Windows Services (`services.msc`):

| Task | Command |
|---|---|
| Status | `Get-Service AzsService` |
| Stop | `Stop-Service AzsService` |
| Start | `Start-Service AzsService` |
| Restart after a config change | `Restart-Service AzsService` |
| Live logs (new installations) | `Get-Content C:\azs\logs\service.log -Wait` |
| Local health (default port) | `Invoke-RestMethod http://127.0.0.1:3001/health` |

The service restarts automatically with Windows on new installations. Existing
startup settings are preserved. The desktop can be opened from its shortcut;
put a shortcut in the operator's Startup folder if it should open at login.
The original `azs-desktop.exe` remains usable directly with `AZS_SERVICE_URL`.

The `dispenser-service install/start/stop/uninstall` subcommands are still
placeholders. Use this installer and Windows service management instead. The
new `validate-config` command is read-only and does not open a serial port,
start synchronization, change the configuration, or create a database:

```powershell
C:\azs\dispenser-service.exe validate-config --config C:\azs\site.config.json
```

## Troubleshooting

**Setup reports validation failure:** correct the reported configuration error
before retrying. New sites need the actual COM port from Device Manager, not a
Linux `/dev/...` path. The installer preserves an existing configuration; make
intentional site changes separately through the existing admin tools.

**Setup reports failed startup:** read the installer error and
`C:\azs\logs\service.err` / `service.log`. Existing NSSM installations retain
their configured log paths. The local health check confirms the service, site
ID and configuration path, but does not certify physical pump/ATG connectivity.
Check those devices in the desktop after installation.

**SQLite is locked:** stop all service/manual instances and any database tools,
then investigate the lock. Do not delete `.db-wal`, `.db-shm` or `.db-journal`
files: the WAL can contain committed transactions not yet checkpointed into the
main database. Preserve the database and sidecars together for recovery.

**Logging:** `service.log_level` accepts `off`, `error`, `warn`, `info`, `debug`,
`trace`, or module filters. `RUST_LOG` overrides it. Raw serial logs are controlled
by `service.serial_log_file` or `AZS_SERIAL_LOG`. Restart after configuration
changes, once dispensing is finished.

**Manual/legacy deployments:** existing NSSM commands still work. For new
installer deployments NSSM is at `C:\azs\tools\nssm.exe`. The wrapper invokes
exactly `dispenser-service.exe run --config <existing-config-path>` with the
station working directory; no protocol or transaction logic is replaced.
