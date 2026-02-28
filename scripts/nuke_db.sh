#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_NAME="${PG_CONTAINER_NAME:-shopmcp-pg}"
PG_USER="${PG_USER:-postgres}"
PG_DB="${PG_DB:-shopmcp}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is required for nuke_db.sh" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Error: container '$CONTAINER_NAME' is not running." >&2
  echo "Hint: run ./scripts/start_pgvector.sh first." >&2
  exit 1
fi

echo "Dropping and recreating schema 'public' in '$PG_DB' on container '$CONTAINER_NAME'..."
docker exec -i "$CONTAINER_NAME" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -c \
  "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"

echo "Reapplying migrations..."
env -u DATABASE_URL "$REPO_ROOT/scripts/apply_migrations.sh"

echo "Database reset complete."
