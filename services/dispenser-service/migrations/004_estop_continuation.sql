-- E-stop continuation: segment chains and combined totals for reporting.

ALTER TABLE transactions ADD COLUMN parent_tx_id TEXT REFERENCES transactions(id);
ALTER TABLE transactions ADD COLUMN combined_volume REAL NOT NULL DEFAULT 0.0;
ALTER TABLE transactions ADD COLUMN combined_amount INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tx_parent_id ON transactions(parent_tx_id);
