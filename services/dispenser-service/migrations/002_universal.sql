-- Migrate legacy schema (addr, nozzle) to universal (fp_id, address_byte, nozzle_index).
-- Safe if already migrated: only runs when legacy column `addr` exists on transactions.

PRAGMA foreign_keys=OFF;

ALTER TABLE transactions RENAME TO transactions_legacy;

CREATE TABLE transactions (
    id             TEXT PRIMARY KEY,
    fp_id          TEXT NOT NULL,
    label          TEXT NOT NULL,
    address_byte   INTEGER NOT NULL,
    started_at     INTEGER NOT NULL,
    completed_at   INTEGER,
    volume         REAL NOT NULL DEFAULT 0.0,
    amount         INTEGER NOT NULL DEFAULT 0,
    price          INTEGER NOT NULL DEFAULT 0,
    nozzle_index   INTEGER NOT NULL DEFAULT 1,
    product_id     INTEGER NOT NULL DEFAULT 0,
    product_name   TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'COMPLETED'
);

INSERT INTO transactions (
    id, fp_id, label, address_byte, started_at, completed_at,
    volume, amount, price, nozzle_index, product_id, product_name, status
)
SELECT
    id,
    addr AS fp_id,
    label,
    CASE addr
        WHEN 'P0' THEN 80
        WHEN 'P1' THEN 81
        WHEN 'P2' THEN 82
        WHEN 'P3' THEN 83
        ELSE 0
    END AS address_byte,
    started_at,
    completed_at,
    volume,
    amount,
    price,
    nozzle AS nozzle_index,
    product_id,
    product_name,
    status
FROM transactions_legacy;

DROP TABLE transactions_legacy;

CREATE INDEX IF NOT EXISTS idx_tx_fp_id     ON transactions(fp_id);
CREATE INDEX IF NOT EXISTS idx_tx_started   ON transactions(started_at);
CREATE INDEX IF NOT EXISTS idx_tx_status    ON transactions(status);

ALTER TABLE price_history RENAME TO price_history_legacy;

CREATE TABLE price_history (
    id         TEXT PRIMARY KEY,
    fp_id      TEXT NOT NULL,
    nozzle     INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    old_price  INTEGER NOT NULL,
    new_price  INTEGER NOT NULL,
    changed_at INTEGER NOT NULL
);

INSERT INTO price_history (id, fp_id, nozzle, product_id, old_price, new_price, changed_at)
SELECT id, addr AS fp_id, nozzle, product_id, old_price, new_price, changed_at
FROM price_history_legacy;

DROP TABLE price_history_legacy;

ALTER TABLE service_events RENAME TO service_events_legacy;

CREATE TABLE service_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT NOT NULL,
    fp_id       TEXT,
    detail      TEXT,
    occurred_at INTEGER NOT NULL
);

INSERT INTO service_events (id, event_type, fp_id, detail, occurred_at)
SELECT id, event_type, addr AS fp_id, detail, occurred_at
FROM service_events_legacy;

DROP TABLE service_events_legacy;

PRAGMA foreign_keys=ON;
