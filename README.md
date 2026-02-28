# ShopMCP MVP

Sitemap-first catalog indexing + store-scoped MCP tools for agent shopping.

## Architecture
- `indexer/` (Node + TypeScript, port `3001`): crawl, normalize, embed, and upsert products.
- `mcp-server/` (FastAPI + FastMCP, port `8000`): serves MCP SSE endpoint and tool invocation.
- `frontend/` (Next.js, port `3000`): ops dashboard for indexing and tool testing.
- Postgres + pgvector: shared data store (`stores`, `products`, `crawl_runs`, `crawl_urls`).

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
- `filter_products(product_type?, tags?, min_price?, max_price?, available_only=true, options?, limit=20, slug?)`
- `get_product(handle, slug?)`
- `check_variant_availability(handle, options, slug?)`
- `list_categories(slug?)`

If `slug` is omitted, MCP will auto-route to a best-fit indexed store when possible.

Response invariants:
- prices are integer cents
- availability fields are booleans
- optional null fields are omitted
- lists are arrays, not null

## Demo Assets
- [demo/claude_desktop_config.local.json](/Users/aevo/Documents/shopmcp/demo/claude_desktop_config.local.json)
- [demo/demo_script.md](/Users/aevo/Documents/shopmcp/demo/demo_script.md)
- [demo/curl_examples.sh](/Users/aevo/Documents/shopmcp/demo/curl_examples.sh)
- [demo/test_plan.md](/Users/aevo/Documents/shopmcp/demo/test_plan.md)

Recommended demo stores (validated 2026-02-28):
- `https://www.allbirds.com`
- `https://namimatcha.com`
- backup: `https://www.tentree.com`
