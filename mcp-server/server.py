from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastmcp import FastMCP

from db import Database
from embedder import QueryEmbedder
from tools import register_tools
from tools.context import reset_store_slug, set_store_slug

load_dotenv()

mcp = FastMCP(name="shopmcp-mcp-core")
database = Database()
embedder = QueryEmbedder()

tool_invokers = register_tools(mcp, database, embedder)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db_ready = False
    db_error = ""
    try:
        await database.connect()
        db_ready = True
    except Exception as exc:
        db_error = str(exc)
    _app.state.db_ready = db_ready
    _app.state.db_error = db_error
    try:
        yield
    finally:
        if db_ready:
            await database.close()


app = FastAPI(title="ShopMCP MCP Server", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "shopmcp-mcp-core",
        "db_ready": bool(getattr(app.state, "db_ready", False)),
        "embedder_enabled": embedder.enabled,
        "db_error": getattr(app.state, "db_error", ""),
    }


@app.post("/mcp/{slug}/tool/{tool}")
async def invoke_tool(slug: str, tool: str, request: Request) -> dict[str, Any]:
    invoker = tool_invokers.get(tool)
    if not invoker:
        raise HTTPException(status_code=404, detail=f"Unknown tool: {tool}")

    payload = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    if not isinstance(payload, dict):
        payload = {}

    arguments = payload.get("arguments", payload)
    if not isinstance(arguments, dict):
        raise HTTPException(status_code=400, detail="Tool arguments must be a JSON object")
    if "slug" not in arguments:
        arguments["slug"] = slug

    token = set_store_slug(slug)
    try:
        result = await invoker(**arguments)
        if isinstance(result, dict):
            return result
        return {"results": result}
    except TypeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        reset_store_slug(token)


@app.post("/mcp/tool/{tool}")
async def invoke_tool_base(tool: str, request: Request) -> dict[str, Any]:
    invoker = tool_invokers.get(tool)
    if not invoker:
        raise HTTPException(status_code=404, detail=f"Unknown tool: {tool}")

    payload = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    if not isinstance(payload, dict):
        payload = {}

    arguments = payload.get("arguments", payload)
    if not isinstance(arguments, dict):
        raise HTTPException(status_code=400, detail="Tool arguments must be a JSON object")

    try:
        result = await invoker(**arguments)
        if isinstance(result, dict):
            return result
        return {"results": result}
    except TypeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# FastMCP SSE transport creates:
# - GET /sse (SSE stream)
# - POST /messages (MCP message endpoint)
# Mounting at /mcp yields /mcp/sse and /mcp/messages.
mcp_sse_app = mcp.http_app(path="/sse", transport="sse")
app.mount("/mcp", mcp_sse_app)


__all__ = ["app", "mcp", "database", "embedder", "tool_invokers"]
