-- Optional TimescaleDB setup.
--
-- IMPORTANT: validate this file before enabling ENABLE_TIMESCALE_SETUP=true.
-- Timescale hypertables require all unique indexes, including primary keys, to
-- include the partitioning time column. The current Prisma schema uses simple
-- primary keys such as "Transaction"."id", so create_hypertable may fail unless
-- the schema/index strategy is adjusted first.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Hypertables
SELECT create_hypertable('"Transaction"', 'startedAt',
    chunk_time_interval => INTERVAL '1 month',
    if_not_exists => TRUE);

SELECT create_hypertable('"ReservoirReading"', 'readingAt',
    chunk_time_interval => INTERVAL '1 week',
    if_not_exists => TRUE);

-- Continuous aggregate for fast daily reports
CREATE MATERIALIZED VIEW IF NOT EXISTS transactions_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', "startedAt")                              AS day,
    "companyId",
    "stationId",
    "productId",
    "productName",
    COUNT(*) FILTER (WHERE status IN ('COMPLETED','STOPPED'))      AS tx_count,
    SUM(volume) FILTER (WHERE status IN ('COMPLETED','STOPPED'))   AS total_volume,
    SUM(amount) FILTER (WHERE status IN ('COMPLETED','STOPPED'))   AS total_amount,
    COUNT(*) FILTER (WHERE status = 'ABORTED')                     AS aborted_count
FROM "Transaction"
WHERE "deletedAt" IS NULL
GROUP BY 1, 2, 3, 4, 5;

SELECT add_continuous_aggregate_policy('transactions_daily',
    start_offset      => INTERVAL '3 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- Compression
SELECT add_compression_policy('"Transaction"',       INTERVAL '3 months');
SELECT add_compression_policy('"ReservoirReading"',  INTERVAL '1 month');

-- Retention for raw reservoir readings (keep 90 days)
SELECT add_retention_policy('"ReservoirReading"', INTERVAL '90 days');
