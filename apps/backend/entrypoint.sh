#!/bin/sh
set -e

# ── Wait for PostgreSQL ──────────────────────────────────────────────────
echo "Waiting for PostgreSQL..."
until pg_isready -h "${DB_HOST:-postgres}" -p "${DB_PORT:-5432}" -U "${POSTGRES_USER:-azs}" 2>/dev/null; do
    printf '.'
    sleep 1
done
echo " PostgreSQL is ready."

# ── Database schema sync ─────────────────────────────────────────────────
# prisma db push synchronises the schema without migration history.
# It never drops existing data — it only adds missing tables/columns.
# Use 'prisma migrate deploy' instead if you switch to migration-based workflow.
echo "Syncing database schema..."
npx prisma db push

echo "Starting AZS Manager backend..."
exec node dist/main
