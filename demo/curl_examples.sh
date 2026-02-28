#!/usr/bin/env bash
set -euo pipefail

INDEXER_BASE_URL="${INDEXER_BASE_URL:-http://localhost:3001}"
MCP_BASE_URL="${MCP_BASE_URL:-http://localhost:8000}"
STORE_SLUG="${STORE_SLUG:-allbirds}"

print_json() {
  if command -v jq >/dev/null 2>&1; then
    jq .
  else
    cat
  fi
}

call_tool() {
  local tool="$1"
  local args_json="$2"
  local merged_args

  if [ "$args_json" = "{}" ]; then
    merged_args="{\"slug\":\"${STORE_SLUG}\"}"
  else
    merged_args="{\"slug\":\"${STORE_SLUG}\",${args_json#\{}"
  fi

  curl -sS -X POST "${MCP_BASE_URL}/mcp/tool/${tool}" \
    -H "Content-Type: application/json" \
    -d "{\"arguments\":${merged_args}}" | print_json
}

echo "== Health checks =="
curl -sS "${INDEXER_BASE_URL}/health" | print_json
curl -sS "${MCP_BASE_URL}/health" | print_json

echo
echo "== Optional indexing bootstrap =="
curl -sS -X POST "${INDEXER_BASE_URL}/index" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.allbirds.com","store_name":"Allbirds","slug":"allbirds","force_reindex":true}' | print_json
curl -sS -X POST "${INDEXER_BASE_URL}/index" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://namimatcha.com","store_name":"Nami Matcha","slug":"namimatcha","force_reindex":true}' | print_json

echo
echo "== Status for STORE_SLUG=${STORE_SLUG} =="
curl -sS "${INDEXER_BASE_URL}/status/${STORE_SLUG}" | print_json

echo
echo "== MCP direct calls =="
echo "-- list_categories"
call_tool "list_categories" '{}'

echo "-- search_products"
call_tool "search_products" '{"query":"running gift","max_results":3,"available_only":true}'

echo "-- filter_products"
call_tool "filter_products" '{"available_only":true,"max_price":10000,"limit":3}'

echo "-- get_product (replace handle if not found)"
call_tool "get_product" '{"handle":"ceremonial-matcha"}'

echo "-- check_variant_availability (replace options from get_product output)"
call_tool "check_variant_availability" '{"handle":"ceremonial-matcha","options":{"size":"30g"}}'

echo "-- add_to_basket (replace handle/options for your store)"
call_tool "add_to_basket" '{"handle":"ceremonial-matcha","options":{"size":"30g"},"quantity":1}'

echo "-- get_basket (replace basket_id from add_to_basket response)"
call_tool "get_basket" '{"basket_id":"basket_replace_me"}'

echo "-- create_checkout_intent (replace basket_id from add_to_basket response)"
call_tool "create_checkout_intent" '{"basket_id":"basket_replace_me"}'

echo "-- checkout_items (single call add-to-basket + checkout link)"
call_tool "checkout_items" '{"items":[{"handle":"lip-glaze","variant_id":"46378215637237","quantity":1},{"handle":"ultralip","variant_id":"46255424012533","quantity":1}]}'
