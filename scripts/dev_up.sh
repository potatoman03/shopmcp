#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

cat <<EOF
ShopMCP MVP local startup (commands are printed only)

1) Start PostgreSQL + pgvector
   cd "$REPO_ROOT"
   ./scripts/start_pgvector.sh

2) Export database URL and apply migrations
   export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/shopmcp
   ./scripts/apply_migrations.sh

3) Start services in separate terminals
   # Frontend on http://localhost:3000
   cd "$REPO_ROOT/frontend" && npm install && npm run dev -- --port 3000

   # Indexer API on http://localhost:3001
   cd "$REPO_ROOT/indexer" && npm install && npm run dev

   # MCP server on http://localhost:8000
   cd "$REPO_ROOT/mcp-server"
   python3 -m venv .venv
   . .venv/bin/activate
   pip install -r requirements.txt
   uvicorn server:app --reload --host 0.0.0.0 --port 8000
EOF
