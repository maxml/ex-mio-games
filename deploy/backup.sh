#!/bin/sh
# Deckhand pre-migration backup for MIO: one pg_dump per service database (identity,
# engagement, payments). The stock Deckhand template dumps a single $POSTGRES_DB, which MIO
# does not define, so it would back up the wrong thing.
#
# Install as $DATA_DIR/<slug>/backup.sh on the server and wire it into the deploy with
#   deckhand deploy ... --backup-cmd "sh $DATA_DIR/<slug>/backup.sh"
# It runs when migrations.backup_before is true, BEFORE the migrations, inside the Deckhand
# runtime container (docker socket mounted, $DATA_DIR mounted at the same path). The script
# takes no arguments: the slug and the paths come from its own location.
#
# Output: $DATA_DIR/<slug>/backups/<snapshot>-<database>.sql, one file per database. The
# snapshot name is DECKHAND_BACKUP_REF (set by the engine), default `predeploy`.
# Fails (non-zero) when any dump fails or comes out empty, so a deploy never proceeds on a
# backup that is not there.
set -eu

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SLUG="$(basename "$PROJECT_DIR")"
DB_CONTAINER="${DB_CONTAINER:-${SLUG}-stateful-db-1}"
DATABASES="${MIO_DATABASES:-identity engagement payments}"
BACKUP_DIR="$PROJECT_DIR/backups"
SNAPSHOT="${DECKHAND_BACKUP_REF:-predeploy}"

mkdir -p "$BACKUP_DIR"
for db in $DATABASES; do
  out="$BACKUP_DIR/$SNAPSHOT-$db.sql"
  # DB name passed as $1 so it never touches the shell inside the container; the superuser
  # name comes from the container's own environment.
  if ! docker exec "$DB_CONTAINER" sh -c 'pg_dump --clean --if-exists -U "$POSTGRES_USER" -d "$1"' sh "$db" >"$out"; then
    rm -f "$out"
    echo "mio backup: pg_dump of $db failed" >&2
    exit 1
  fi
  if [ ! -s "$out" ]; then
    rm -f "$out"
    echo "mio backup: dump of $db is empty" >&2
    exit 1
  fi
  echo "mio backup: wrote $SNAPSHOT-$db.sql ($(wc -c <"$out") bytes)"
done
