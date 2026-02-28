#!/bin/sh
set -eu

CONTAINER_NAME="${PG_CONTAINER_NAME:-shopmcp-pg}"
IMAGE="${PGVECTOR_IMAGE:-pgvector/pgvector:pg16}"
PG_USER="${PGUSER:-postgres}"
PG_PASSWORD="${PGPASSWORD:-postgres}"
PG_DB="${PGDATABASE:-shopmcp}"
PG_PORT="${PGPORT:-5432}"
PG_VOLUME="${PGVOLUME:-shopmcp_pgdata}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is required but not found in PATH." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Error: docker daemon is not reachable. Start Docker and retry." >&2
  exit 1
fi

if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "pgvector container '$CONTAINER_NAME' is already running."
elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Starting existing container '$CONTAINER_NAME'..."
  docker start "$CONTAINER_NAME" >/dev/null
  echo "Container '$CONTAINER_NAME' started."
else
  echo "Creating and starting container '$CONTAINER_NAME' from '$IMAGE'..."
  docker run -d \
    --name "$CONTAINER_NAME" \
    -e POSTGRES_USER="$PG_USER" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    -e POSTGRES_DB="$PG_DB" \
    -p "$PG_PORT:5432" \
    -v "$PG_VOLUME:/var/lib/postgresql/data" \
    "$IMAGE" >/dev/null
  echo "Container '$CONTAINER_NAME' created and started."
fi

echo "DATABASE_URL=postgresql://$PG_USER:$PG_PASSWORD@localhost:$PG_PORT/$PG_DB"
