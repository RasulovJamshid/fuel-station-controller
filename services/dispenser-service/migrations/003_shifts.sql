-- Shift management (SHIFT_MANAGEMENT.md)

CREATE TABLE IF NOT EXISTS operators (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    pin_hash   TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
    id                   TEXT PRIMARY KEY,
    operator_id          TEXT,
    operator_name        TEXT NOT NULL,
    shift_name           TEXT,
    scheduled_start      TEXT,
    scheduled_end        TEXT,
    started_at           INTEGER NOT NULL,
    ended_at             INTEGER,
    total_transactions   INTEGER NOT NULL DEFAULT 0,
    total_volume         REAL    NOT NULL DEFAULT 0.0,
    total_amount         INTEGER NOT NULL DEFAULT 0,
    status               TEXT    NOT NULL DEFAULT 'ACTIVE',
    notes                TEXT,
    FOREIGN KEY (operator_id) REFERENCES operators(id)
);

CREATE INDEX IF NOT EXISTS idx_shifts_status   ON shifts(status);
CREATE INDEX IF NOT EXISTS idx_shifts_started  ON shifts(started_at);
CREATE INDEX IF NOT EXISTS idx_shifts_operator ON shifts(operator_id);

ALTER TABLE transactions ADD COLUMN shift_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tx_shift_id ON transactions(shift_id);
