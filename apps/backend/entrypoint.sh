#!/bin/sh
set -e

# ── Wait for PostgreSQL ──────────────────────────────────────────────────
echo "Waiting for PostgreSQL..."
until pg_isready -h "${DB_HOST:-postgres}" -p "${DB_PORT:-5432}" -U "${POSTGRES_USER:-azs}" 2>/dev/null; do
    printf '.'
    sleep 1
done
echo " PostgreSQL is ready."

# ── Database schema migration ─────────────────────────────────────────────
echo "Applying database migrations..."
npx prisma migrate deploy

# ── Optional Timescale setup ──────────────────────────────────────────────
# Disabled by default because hypertable conversion must match the Prisma
# primary-key/index strategy. Enable only after validating prisma/timescale.sql
# against the target schema.
if [ "${ENABLE_TIMESCALE_SETUP:-false}" = "true" ]; then
    echo "Applying TimescaleDB setup..."
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/timescale.sql
fi

# ── Optional initial admin seed ───────────────────────────────────────────
if [ -n "${SEED_ADMIN_PASSWORD:-}" ]; then
    echo "Seeding initial admin user..."
    npm run db:seed
else
    echo "Skipping admin seed; SEED_ADMIN_PASSWORD is not set."
fi

echo "Starting AZS Manager backend..."
exec node dist/main
