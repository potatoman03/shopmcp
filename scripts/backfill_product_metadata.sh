#!/bin/sh
set -eu

CONTAINER_NAME="${PG_CONTAINER_NAME:-shopmcp-pg}"
PG_USER="${PGUSER:-postgres}"
PG_DB="${PGDATABASE:-shopmcp}"

SQL_FILE="$(mktemp -t shopmcp_backfill_XXXX.sql)"
cleanup() {
  rm -f "$SQL_FILE"
}
trap cleanup EXIT

cat >"$SQL_FILE" <<'SQL'
update products
set
  is_catalog_product = coalesce(
    is_catalog_product,
    (
      lower(url) like '%/products/%'
      or lower(url) like '%/product/%'
      or price_min is not null
      or price_max is not null
      or (
        jsonb_typeof(data->'variants') = 'array'
        and jsonb_array_length(data->'variants') > 0
      )
    )
  ),
  summary_short = coalesce(
    summary_short,
    nullif(data->>'summary_short', ''),
    title || ': ' || coalesce(nullif(product_type, ''), 'Product')
  ),
  summary_llm = coalesce(
    summary_llm,
    nullif(data->>'summary_llm', '')
  ),
  option_tokens = coalesce(
    nullif(option_tokens, '{}'::text[]),
    (
      select coalesce(array_agg(distinct lower(token)), '{}'::text[])
      from (
        select unnest(coalesce(tags, '{}'::text[])) as token
        union all
        select regexp_split_to_table(lower(coalesce(title, '')), '\s+')
        union all
        select regexp_split_to_table(lower(coalesce(product_type, '')), '\s+')
      ) tokens
      where token is not null and btrim(token) <> ''
    )
  ),
  content_hash = coalesce(
    content_hash,
    md5(
      coalesce(title, '') || '|'
      || coalesce(handle, '') || '|'
      || coalesce(url, '') || '|'
      || coalesce(data->>'description', '') || '|'
      || coalesce(array_to_string(tags, ','), '') || '|'
      || coalesce(price_min::text, '') || '|'
      || coalesce(price_max::text, '') || '|'
      || coalesce(available::text, '')
    )
  ),
  updated_at = now();
SQL

run_with_psql() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SQL_FILE"
}

run_with_docker_exec() {
  docker exec -i "$CONTAINER_NAME" \
    psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" < "$SQL_FILE"
}

if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
  run_with_psql
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker ps --format "{{.Names}}" | grep -qx "$CONTAINER_NAME"; then
  run_with_docker_exec
else
  echo "Error: set DATABASE_URL with local psql, or start docker container '$CONTAINER_NAME' for fallback." >&2
  exit 1
fi

echo "Backfill completed."
