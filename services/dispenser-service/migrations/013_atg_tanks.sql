-- Durable external delivery, independent of sensor polling and cloud sync.
CREATE TABLE IF NOT EXISTS atg_outbox (
    id TEXT PRIMARY KEY,
    target_url TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_atg_outbox_due ON atg_outbox(target_url, next_attempt_at, created_at);
ALTER TABLE fuel_deliveries ADD COLUMN tank_id TEXT;
ALTER TABLE wetstock_reconciliations ADD COLUMN tank_id TEXT;
CREATE INDEX IF NOT EXISTS idx_deliveries_tank ON fuel_deliveries(tank_id, delivered_at);
CREATE INDEX IF NOT EXISTS idx_recon_tank ON wetstock_reconciliations(tank_id, period_end);
