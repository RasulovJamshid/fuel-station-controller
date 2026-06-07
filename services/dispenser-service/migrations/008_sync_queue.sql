-- Outbound sync queue: one row per entity that needs to reach the backend.
-- Uses a deterministic UUID so the same entity can be re-enqueued (upsert)
-- when its payload changes (e.g. STOPPED → COMPLETED transition).
CREATE TABLE IF NOT EXISTS sync_queue (
    id           TEXT PRIMARY KEY,        -- UUID v5(entity_type:entity_id)
    entity_type  TEXT NOT NULL,           -- transaction | shift | price_change | health_event
    entity_id    TEXT NOT NULL,           -- the entity's own ID
    payload_json TEXT NOT NULL,           -- JSON matching the backend SyncBatchDto payload field
    created_at   INTEGER NOT NULL,        -- unix ms — ordering for ordered delivery
    synced_at    INTEGER,                 -- NULL = pending
    retries      INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_pending ON sync_queue(created_at)
    WHERE synced_at IS NULL;
