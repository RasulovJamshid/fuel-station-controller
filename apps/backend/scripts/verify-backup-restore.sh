#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
    echo "DATABASE_URL is required"
    exit 1
fi

if [ -z "${RESTORE_DATABASE_URL:-}" ]; then
    echo "RESTORE_DATABASE_URL is required"
    echo "Example: RESTORE_DATABASE_URL=postgresql://azs:pass@localhost:5432/azs_restore"
    exit 1
fi

BACKUP_FILE="${BACKUP_FILE:-/tmp/azs-backup-verify.dump}"

echo "Creating compressed backup: $BACKUP_FILE"
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --file="$BACKUP_FILE"

echo "Restoring backup into RESTORE_DATABASE_URL"
pg_restore "$BACKUP_FILE" --clean --if-exists --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL"

echo "Checking restored schema"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT COUNT(*) FROM "Company";' >/dev/null
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT COUNT(*) FROM "Transaction";' >/dev/null
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT COUNT(*) FROM "Station";' >/dev/null

echo "Backup restore verification passed"
