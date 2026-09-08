-- Core forecourt operations: shift totalizer capture, wetstock, price scheduling.

-- Electronic totalizer readings captured at shift open and close, per nozzle.
-- Nullable volumes: protocols without a totalizer (Wayne Europump) capture nothing,
-- and a lane that is offline at shift boundary simply has no reading.
CREATE TABLE IF NOT EXISTS shift_nozzle_totals (
    shift_id          TEXT    NOT NULL,
    fp_id             TEXT    NOT NULL,
    label             TEXT    NOT NULL DEFAULT '',
    nozzle_index      INTEGER NOT NULL,
    product_id        INTEGER NOT NULL DEFAULT 0,
    product_name      TEXT    NOT NULL DEFAULT '',
    open_volume       REAL,
    close_volume      REAL,
    open_amount       INTEGER,
    close_amount      INTEGER,
    captured_open_at  INTEGER,
    captured_close_at INTEGER,
    PRIMARY KEY (shift_id, fp_id, nozzle_index),
    FOREIGN KEY (shift_id) REFERENCES shifts(id)
);

CREATE INDEX IF NOT EXISTS idx_snt_shift ON shift_nozzle_totals(shift_id);

-- Fuel deliveries (tanker drops). The "in" side of book stock.
CREATE TABLE IF NOT EXISTS fuel_deliveries (
    id             TEXT PRIMARY KEY,
    product_id     INTEGER NOT NULL,
    product_name   TEXT    NOT NULL DEFAULT '',
    tank_label     TEXT    NOT NULL DEFAULT '',
    delivered_at   INTEGER NOT NULL,
    document_ref   TEXT,
    supplier       TEXT,
    ordered_l      REAL    NOT NULL DEFAULT 0.0,
    delivered_l    REAL    NOT NULL,
    tank_before_l  REAL,
    tank_after_l   REAL,
    temperature_c  REAL,
    price_per_l    INTEGER NOT NULL DEFAULT 0,
    shift_id       TEXT,
    operator_name  TEXT,
    notes          TEXT,
    created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_product ON fuel_deliveries(product_id, delivered_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_at      ON fuel_deliveries(delivered_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_shift   ON fuel_deliveries(shift_id);

-- Wetstock reconciliation: book stock vs measured (ATG) stock, per tank per period.
CREATE TABLE IF NOT EXISTS wetstock_reconciliations (
    id                 TEXT PRIMARY KEY,
    product_id         INTEGER NOT NULL,
    product_name       TEXT    NOT NULL DEFAULT '',
    tank_label         TEXT    NOT NULL DEFAULT '',
    period_start       INTEGER NOT NULL,
    period_end         INTEGER NOT NULL,
    opening_l          REAL    NOT NULL,
    deliveries_l       REAL    NOT NULL,
    sales_l            REAL    NOT NULL,
    book_closing_l     REAL    NOT NULL,
    measured_l         REAL    NOT NULL,
    variance_l         REAL    NOT NULL,
    variance_pct       REAL    NOT NULL,
    status             TEXT    NOT NULL,
    shift_id           TEXT,
    measured_available INTEGER NOT NULL DEFAULT 1,
    notes              TEXT,
    created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recon_product ON wetstock_reconciliations(product_id, period_end);

-- Future-dated price changes applied by the scheduler task.
CREATE TABLE IF NOT EXISTS scheduled_prices (
    id           TEXT PRIMARY KEY,
    product_id   INTEGER NOT NULL,
    product_name TEXT    NOT NULL DEFAULT '',
    new_price    INTEGER NOT NULL,
    effective_at INTEGER NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'PENDING',
    created_by   TEXT    NOT NULL DEFAULT 'admin',
    created_at   INTEGER NOT NULL,
    applied_at   INTEGER,
    error        TEXT,
    notes        TEXT
);

CREATE INDEX IF NOT EXISTS idx_sched_prices_due ON scheduled_prices(status, effective_at);
