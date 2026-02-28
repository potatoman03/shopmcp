#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
MIGRATIONS_DIR="$REPO_ROOT/indexer/migrations"

CONTAINER_NAME="${PG_CONTAINER_NAME:-shopmcp-pg}"
PG_USER="${PGUSER:-postgres}"
PG_DB="${PGDATABASE:-shopmcp}"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "Error: migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

set -- "$MIGRATIONS_DIR"/*.sql
if [ ! -e "$1" ]; then
  echo "No migration files found in $MIGRATIONS_DIR"
  exit 0
fi

run_with_psql() {
  migration_file="$1"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration_file"
}

run_with_docker_exec() {
  migration_file="$1"
  docker exec -i "$CONTAINER_NAME" \
    psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" < "$migration_file"
}

use_mode=""
if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
  use_mode="psql"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  use_mode="docker"
elif [ -n "${DATABASE_URL:-}" ]; then
  echo "Error: DATABASE_URL is set but local 'psql' is not available; docker fallback container '$CONTAINER_NAME' is not running." >&2
  exit 1
else
  echo "Error: set DATABASE_URL with local psql, or start docker container '$CONTAINER_NAME' for fallback." >&2
  exit 1
fi

for migration_file in "$MIGRATIONS_DIR"/*.sql; do
  echo "Applying migration: $migration_file"
  if [ "$use_mode" = "psql" ]; then
    run_with_psql "$migration_file"
  else
    run_with_docker_exec "$migration_file"
  fi
done

echo "Migrations applied successfully."
