CREATE TABLE IF NOT EXISTS transactions (
    id           TEXT PRIMARY KEY,
    addr         TEXT NOT NULL,
    label        TEXT NOT NULL,
    started_at   INTEGER NOT NULL,
    completed_at INTEGER,
    volume       REAL NOT NULL DEFAULT 0.0,
    amount       INTEGER NOT NULL DEFAULT 0,
    price        INTEGER NOT NULL DEFAULT 0,
    product_id   INTEGER NOT NULL DEFAULT 0,
    product_name TEXT NOT NULL DEFAULT '',
    nozzle       INTEGER NOT NULL DEFAULT 1,
    status       TEXT NOT NULL DEFAULT 'COMPLETED'
);

CREATE INDEX IF NOT EXISTS idx_tx_addr       ON transactions(addr);
CREATE INDEX IF NOT EXISTS idx_tx_started    ON transactions(started_at);
CREATE INDEX IF NOT EXISTS idx_tx_status     ON transactions(status);

CREATE TABLE IF NOT EXISTS price_history (
    id         TEXT PRIMARY KEY,
    addr       TEXT NOT NULL,
    nozzle     INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    old_price  INTEGER NOT NULL,
    new_price  INTEGER NOT NULL,
    changed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    addr       TEXT,
    detail     TEXT,
    occurred_at INTEGER NOT NULL
);
