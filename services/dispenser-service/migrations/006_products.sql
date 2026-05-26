CREATE TABLE IF NOT EXISTS products (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    color      TEXT    NOT NULL DEFAULT '#888888',
    unit       TEXT    NOT NULL DEFAULT 'litre',
    updated_at INTEGER NOT NULL,
    updated_by TEXT    NOT NULL DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS fp_nozzles (
    fp_id              TEXT    NOT NULL,
    nozzle_index       INTEGER NOT NULL,
    product_id         INTEGER NOT NULL,
    price              INTEGER NOT NULL,
    active             INTEGER NOT NULL DEFAULT 1,
    wayne_code         INTEGER NOT NULL DEFAULT 0,
    wayne_product_code INTEGER NOT NULL DEFAULT 0,
    updated_at         INTEGER NOT NULL,
    updated_by         TEXT    NOT NULL DEFAULT 'system',
    PRIMARY KEY (fp_id, nozzle_index)
);
