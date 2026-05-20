CREATE TABLE IF NOT EXISTS admin_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL
);

-- Extend price_history for admin audit (safe if columns already exist on fresh DBs from 001)
-- 002 recreated price_history without product_name/changed_by; add them here.
ALTER TABLE price_history ADD COLUMN product_name TEXT NOT NULL DEFAULT '';
ALTER TABLE price_history ADD COLUMN changed_by TEXT NOT NULL DEFAULT 'system';
