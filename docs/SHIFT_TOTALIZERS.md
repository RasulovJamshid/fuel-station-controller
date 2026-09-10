# Shift totalizer readings

Open the desktop **Shift** workspace to see each nozzle's opening totalizer, latest reported totalizer, and volume change during the active shift. The report refreshes every five seconds. Pump readings follow the protocol's normal refresh cycle; some pumps update their totalizer only after a delivery. The reported change is measured volume, not a sum estimated from transactions.

Ending or handing over a shift saves the closing readings in the existing local `shift_nozzle_totals` table. Expand an ended shift to load its saved readings and volume change. Printing also loads the full report, even from a collapsed history row. Later pump readings and service restarts do not change an ended shift's saved meter boundary.

A dash means a necessary reading is unavailable or the counter went backwards, for example after a pump reset. Offline pumps are not treated as having a fresh reading. No opening reading is invented for an older shift that lacks one. Backdated shifts use the meter reading captured when the shift was actually opened, not at the backdated time.

Update both the dispenser service and desktop app to use active readings. No database migration is required. Transaction accounting and pump control are unchanged.

Checks: `cargo test -p dispenser-service --offline` and `npm run build --workspace=apps/desktop`.
