# ShopMCP MVP

Sitemap-first catalog indexing + store-scoped MCP tools for agent shopping.

## Full Flow Example (What ShopMCP Does)
This is the full path from a store URL to a checkout link generated through MCP tools:

1. Merchant URL is submitted (frontend -> indexer):
```sh
curl -sS -X POST http://localhost:3001/index \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.allbirds.com","store_name":"Allbirds"}'
```

2. Indexer crawls and normalizes products into Postgres + pgvector (`stores`, `products`, `crawl_runs`, `crawl_urls`).

3. Status is polled until indexing is complete:
```sh
curl -sS "http://localhost:3001/status/allbirds?include_products=true&products_limit=3"
```

4. Agent calls MCP search tool against that indexed catalog:
```sh
curl -sS -X POST http://localhost:8000/mcp/allbirds/tool/search_products_v2 \
  -H 'Content-Type: application/json' \
  -d '{"arguments":{"query":"lightweight running shoes","limit":5,"available_only":true}}'
```

5. Agent adds an item to basket, then creates checkout intent:
```sh
curl -sS -X POST http://localhost:8000/mcp/allbirds/tool/add_to_basket \
  -H 'Content-Type: application/json' \
  -d '{"arguments":{"handle":"tree-runner-go","quantity":1,"options":{"Size":"10","Color":"Natural Black"}}}'

curl -sS -X POST http://localhost:8000/mcp/allbirds/tool/create_checkout_intent \
  -H 'Content-Type: application/json' \
  -d '{"arguments":{"basket_id":"<basket_id_from_previous_step>","mark_checked_out":false}}'
```

Result: ShopMCP turns raw ecommerce sites into structured, queryable store catalogs and checkout-ready workflows for agents.

## Architecture
- `indexer/` (Node + TypeScript, port `3001`): crawl, normalize, embed, and upsert products.
- `mcp-server/` (FastAPI + FastMCP, port `8000`): serves MCP SSE endpoint and tool invocation.
- `frontend/` (Next.js, port `3000`): ops dashboard for indexing and tool testing.
- Postgres + pgvector: shared data store (`stores`, `products`, `crawl_runs`, `crawl_urls`, `baskets`, `basket_items`).

## Local Prerequisites
- Docker
- Node.js 20+
- Python 3.11+

## Quick Start
1. Start pgvector Postgres:
```sh
./scripts/start_pgvector.sh
```

2. Export DB URL and run migrations:
```sh
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/shopmcp
./scripts/apply_migrations.sh
```

3. Start services (separate terminals):
```sh
# terminal 1
cd frontend
npm install
npm run dev -- --port 3000

# terminal 2
cd indexer
npm install
npm run dev

# terminal 3
cd mcp-server
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

## Environment Variables
### `indexer/.env`
```env
PORT=3001
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/shopmcp
OPENAI_API_KEY=sk-...
OPENAI_EMBED_MODEL=text-embedding-3-small
EXA_API_KEY=
EXA_BASE_URL=https://api.exa.ai
EXA_MAX_RESULTS=25
EXA_TIMEOUT_MS=12000
READER_PROXY_ENABLED=true
READER_PROXY_BASE_URL=https://r.jina.ai/http://
CRAWL_CONCURRENCY=6
CRAWL_MAX_URLS=500
REQUEST_TIMEOUT_MS=15000
USER_AGENT=ShopMCPIndexer/0.1 (+https://shopmcp.local)
LOG_LEVEL=info
```

### `mcp-server/.env`
```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/shopmcp
OPENAI_API_KEY=sk-...
PORT=8000
```

### `frontend/.env.local`
```env
INDEXER_BASE_URL=http://localhost:3001
MCP_BASE_URL=http://localhost:8000
```

## Indexer API (`localhost:3001`)
- `POST /index`
  - body: `{ "url": "https://www.allbirds.com", "store_name": "Allbirds" }`
- `GET /status/:slug`
  - optional: `?include_products=true&products_limit=20`
- `POST /refresh/:slug`
- `GET /products/:slug?limit=100&offset=0`
  - optional: `?view=manifest` for full table payload with category, availability, variants, source, and Exa cross-reference summary
- `GET /health`

`GET /products/:slug` returns:
- `title`
- `price` (integer cents, when available)
- `description` (plain text, when available)
- `url`

## MCP Endpoints (`localhost:8000`)
- SSE: `GET /mcp/sse`
- MCP messages: `POST /mcp/messages`
- Tool HTTP wrapper: `POST /mcp/tool/{tool}` (pass `slug` in tool arguments)
- Legacy tool wrapper: `POST /mcp/{slug}/tool/{tool}` (auto-injects `slug`)
- Health: `GET /health`

## MCP Tools
- `list_stores(limit=25)`
- `search_products(query, max_results=10, available_only=true, slug?)`
- `search_products_v2(query, slug?, limit=5, available_only=true, budget_max_cents?, budget_min_cents?, skin_tone?, sort=best_match)` (compact, ranked, payload-capped)
- `filter_products(product_type?, tags?, min_price?, max_price?, available_only=true, options?, limit=20, slug?)`
- `get_product(handle, slug?)`
- `get_product_brief_v2(handle, slug?)` (compact detail without full variants array)
- `check_variant_availability(handle, options, slug?)`
- `add_to_basket(handle, quantity=1, options?, variant_id?, basket_id?, slug?)`
- `get_basket(basket_id, slug?)`
- `update_basket_item(basket_id, variant_id, quantity, slug?)`
- `remove_from_basket(basket_id, variant_id, slug?)`
- `clear_basket(basket_id, slug?)`
- `create_checkout_intent(basket_id, slug?, mark_checked_out=false)` (returns manual checkout link)
- `get_checkout_link(basket_id, slug?)` (alias)
- `checkout_items(items, slug?, basket_id?, mark_checked_out=false)` (single call add+checkout)
- `list_categories(slug?)`

If `slug` is omitted, MCP will auto-route to a best-fit indexed store when possible.

Response invariants:
- prices are integer cents
- availability fields are booleans
- optional null fields are omitted
- lists are arrays, not null

V2 controls:
- `MCP_V2_ENABLED=true|false`
- `MCP_SEARCH_CACHE_SIZE` / `MCP_SEARCH_CACHE_TTL_SEC`
- `MCP_EMBED_QUERY_CACHE_SIZE` / `MCP_EMBED_QUERY_CACHE_TTL_SEC`

Indexer v2 schema + throughput controls:
- apply `indexer/migrations/002_context_safe_v2.sql`
- basket + checkout persistence: `indexer/migrations/003_basket_checkout.sql`
- optional one-time metadata backfill for existing rows: `./scripts/backfill_product_metadata.sh`
- `UPSERT_BATCH_SIZE`
- `CRAWL_URL_UPSERT_BATCH_SIZE`
- optional summary precompute: `SUMMARY_LLM_ENABLED=true`, `SUMMARY_LLM_MODEL`, `SUMMARY_LLM_MAX_CHARS`

## Demo Assets
- [demo/claude_desktop_config.local.json](/Users/aevo/Documents/shopmcp/demo/claude_desktop_config.local.json)
- [demo/demo_script.md](/Users/aevo/Documents/shopmcp/demo/demo_script.md)
- [demo/curl_examples.sh](/Users/aevo/Documents/shopmcp/demo/curl_examples.sh)
- [demo/test_plan.md](/Users/aevo/Documents/shopmcp/demo/test_plan.md)


## Currently Indexed Stores (Snapshot: 2026-02-28 16:54:23 +08 / 2026-02-28 08:54:23 UTC)
| Slug | Store | URL | Products | Status | Indexed At (UTC) |
| --- | --- | --- | ---: | --- | --- |
| `simplylifebaby` | Simplylifebaby | `https://simplylifebaby.com` | 250 | `completed` | `2026-02-28T07:48:42Z` |
| `fashionnova` | Fashion Nova | `https://fashionnova.com` | 250 | `completed` | `2026-02-28T07:47:31Z` |
| `glossier` | Glossier | `https://glossier.com` | 127 | `completed` | `2026-02-28T07:47:21Z` |
| `kylie` | Kylie Cosmetics | `https://kyliecosmetics.com` | 250 | `completed` | `2026-02-28T07:46:05Z` |
| `gymshark` | Gymshark | `https://gymshark.com` | 250 | `completed` | `2026-02-28T07:45:43Z` |
| `rhode` | Rhode | `https://rhodeskin.com` | 86 | `completed` | `2026-02-28T07:45:41Z` |
| `rarebeauty` | Rare Beauty | `https://rarebeauty.com` | 170 | `completed` | `2026-02-28T07:45:34Z` |
| `prime` | PRIME | `https://drinkprime.com` | 49 | `completed` | `2026-02-28T07:45:20Z` |
| `feastables` | Feastables | `https://feastables.com` | 46 | `completed` | `2026-02-28T07:45:12Z` |
