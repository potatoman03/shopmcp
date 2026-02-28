# ShopMCP MVP Demo Test Plan

## Scope
Acceptance covers these 5 MCP tools only:
- `search_products`
- `filter_products`
- `get_product`
- `check_variant_availability`
- `list_categories`

## Environment Assumptions
- Frontend: `http://localhost:3000`
- Indexer: `http://localhost:3001`
- MCP server: `http://localhost:8000`
- One demo slug is indexed (`allbirds` or `namimatcha`)

## Unit Checklist
- [ ] `search_products`: rejects/handles empty query and respects `max_results` bounds.
- [ ] `filter_products`: handles optional filters (`product_type`, `tags`, price range, `options`, `available_only`) without schema errors.
- [ ] `get_product`: returns `{ found: false }` for unknown handle and `{ found: true, product: ... }` for known handle.
- [ ] `check_variant_availability`: exact option match behavior is deterministic (`matched` true/false) and always returns `availability`, `variant_id`, `price`.
- [ ] `list_categories`: returns stable keys `total_products`, `product_types`, `top_tags`.

## Integration Checklist (HTTP)
- [ ] `POST /mcp/tool/list_stores` returns HTTP 200 with `stores` array.
- [ ] `POST /mcp/tool/search_products` returns HTTP 200 with `results` array (with explicit `slug` or auto-routing).
- [ ] `POST /mcp/tool/filter_products` returns HTTP 200 with `results` array.
- [ ] `POST /mcp/tool/get_product` returns HTTP 200 with `found` boolean.
- [ ] `POST /mcp/tool/check_variant_availability` returns HTTP 200 with `matched` + `availability`.
- [ ] `POST /mcp/tool/list_categories` returns HTTP 200 with `product_types` + `top_tags`.
- [ ] Legacy wrapper `POST /mcp/{slug}/tool/{tool}` still works.

## E2E Checklist (Claude Desktop Demo)
- [ ] Claude connects to `shopmcp-local` via SSE (`/mcp/sse`).
- [ ] `list_stores` returns slugs and at least one selectable store.
- [ ] All 5 catalog tools can be invoked in sequence with `slug` argument and return non-error payloads for at least one store.
- [ ] If primary slug is blocked/empty, switch slug and complete the same tool sequence.
- [ ] Demo narration matches `demo/demo_script.md` timing and fallback flow.

## Exit Criteria
- [ ] 5/5 tools pass integration checks for at least one store slug.
- [ ] Fallback path is verified once (manual switch between store slugs).
