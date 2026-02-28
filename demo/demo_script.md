# ShopMCP 90-Second Demo Script

## Preconditions
- Frontend running at `http://localhost:3000`
- Indexer running at `http://localhost:3001`
- MCP server running at `http://localhost:8000`
- Claude Desktop loaded with `demo/claude_desktop_config.local.json`
- At least one slug indexed: `allbirds` or `namimatcha`

## Primary Path (90 seconds)
1. `0:00-0:10` Health check in terminal:
   - `curl -sS http://localhost:3001/health`
   - `curl -sS http://localhost:8000/health`
2. `0:10-0:20` In Claude Desktop, select server `shopmcp-local`.
3. `0:20-0:30` Prompt: `Run list_stores and pick the best slug for matcha shopping.`
4. `0:30-0:45` Prompt: `Run list_categories with that slug and summarize the top tags.`
5. `0:45-1:00` Prompt: `Run search_products for query "matcha", max_results 3, available_only true, using that slug.`
6. `1:00-1:15` Prompt: `Run get_product for one returned handle using that slug.`
7. `1:15-1:30` Prompt: `Run check_variant_availability for that handle with one option combination from get_product, then report availability and price.`

## Fallback Path (if one site blocks)
1. If the selected slug has empty data, rerun `list_stores` and switch slug.
2. Re-run the same prompt sequence with the new slug.
3. If all stores are empty, trigger indexing and continue when one reaches indexed state:
   - `curl -sS -X POST http://localhost:3001/index -H 'Content-Type: application/json' -d '{"url":"https://www.allbirds.com","store_name":"Allbirds","slug":"allbirds","force_reindex":true}'`
   - `curl -sS -X POST http://localhost:3001/index -H 'Content-Type: application/json' -d '{"url":"https://namimatcha.com","store_name":"Nami Matcha","slug":"namimatcha","force_reindex":true}'`
