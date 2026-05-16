#!/bin/sh
# Postgres backup script intended to run inside the postgres container.
# Mount this into /usr/local/bin/backup.sh and call it from cron on the host
# or via `docker compose exec postgres backup.sh`.
set -eu

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR=${BACKUP_DIR:-/backups}
mkdir -p "$BACKUP_DIR"

OUT="$BACKUP_DIR/codegraph-${TIMESTAMP}.sql.gz"
echo "[backup] writing $OUT"
pg_dump -U "${POSTGRES_USER:-codegraph}" "${POSTGRES_DB:-codegraph}" | gzip > "$OUT"

# Keep the 14 most recent backups.
ls -1t "$BACKUP_DIR"/codegraph-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm --
echo "[backup] done"
