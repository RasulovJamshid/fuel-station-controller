# Admin PIN reset (field recovery)

Use this when an admin has forgotten their PIN and you need to recover access without knowing the current PIN.

## Steps

**Stop the service first** — the command writes directly to SQLite and cannot run while the service is open on the same DB file.

### Windows (NSSM)

```powershell
nssm stop AzsService
C:\azs\dispenser-service.exe reinit-auth --config C:\azs\site.config.json
nssm start AzsService
```

### Linux

```bash
cargo run -p dispenser-service -- reinit-auth --config services/dispenser-service/site.config.json
```

## What happens

- Admin PIN is reset to `0000`
- Must-change flag is set — the admin is forced to choose a new PIN on their next login
- The command does not appear in `--help` output

## After reset

Tell the admin their temporary PIN is `0000` and that they will be prompted to set a new one immediately on login.
