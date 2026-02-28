from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse
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
# Primary compatibility transport:
# - streamable HTTP at /mcp/sse (accepts GET + POST used by many clients)
mcp_streamable_app = mcp.http_app(path="/sse", transport="streamable-http")
# Legacy SSE transport retained for older clients.
mcp_legacy_sse_app = mcp.http_app(path="/sse", transport="sse")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # FastMCP streamable transport requires its own lifespan to initialize
    # the session manager task group. Run that lifespan alongside DB setup.
    async with mcp_streamable_app.lifespan(mcp_streamable_app):
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


class MCPAcceptHeaderMiddleware:
    """Loosen Accept header handling for MCP endpoint probes.

    Some MCP registries/probers send `Accept: */*` or omit `Accept` while
    validating URL reachability. Streamable HTTP expects explicit media types.
    """

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") == "http" and scope.get("path") == "/mcp/sse":
            headers = list(scope.get("headers", []))
            accept = ""
            for key, value in headers:
                if key == b"accept":
                    accept = value.decode("latin-1")
                    break
            if not accept or accept.strip() == "*/*":
                rewritten = [(k, v) for k, v in headers if k != b"accept"]
                rewritten.append((b"accept", b"application/json, text/event-stream"))
                scope = dict(scope)
                scope["headers"] = rewritten
        await self.app(scope, receive, send)


app.add_middleware(MCPAcceptHeaderMiddleware)


def _base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


def _mcp_descriptor(request: Request) -> dict[str, Any]:
    base = _base_url(request)
    return {
        "ok": True,
        "service": "shopmcp-mcp-core",
        "transport": "streamable-http",
        "sse_url": f"{base}/mcp/sse",
        "legacy_sse_url": f"{base}/mcp-legacy/sse",
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "shopmcp-mcp-core",
        "db_ready": bool(getattr(app.state, "db_ready", False)),
        "embedder_enabled": embedder.enabled,
        "mcp_v2_enabled": "search_products_v2" in tool_invokers,
        "db_error": getattr(app.state, "db_error", ""),
    }


@app.get("/")
async def root(request: Request) -> dict[str, Any]:
    return _mcp_descriptor(request)


@app.get("/mcp")
async def mcp_root(request: Request) -> dict[str, Any]:
    return _mcp_descriptor(request)


@app.get("/mcp/")
async def mcp_root_slash(request: Request) -> dict[str, Any]:
    return _mcp_descriptor(request)


@app.get("/.well-known/oauth-protected-resource")
@app.get("/.well-known/oauth-protected-resource/mcp/sse")
@app.get("/.well-known/oauth-protected-resource/sse")
async def oauth_protected_resource(request: Request) -> dict[str, Any]:
    # No OAuth required for hackathon MVP; advertise the MCP resource directly.
    return {
        "resource": f"{_base_url(request)}/mcp/sse",
        "authorization_servers": [],
    }


@app.get("/.well-known/oauth-authorization-server")
@app.get("/.well-known/openid-configuration")
async def oauth_disabled() -> dict[str, Any]:
    return {
        "oauth_supported": False,
    }


@app.post("/register")
async def oauth_dynamic_client_registration_disabled() -> dict[str, Any]:
    # Compatibility endpoint for OAuth discovery probes from MCP registries.
    return {
        "oauth_supported": False,
        "dynamic_client_registration": False,
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


app.mount("/mcp", mcp_streamable_app)
app.mount("/mcp-legacy", mcp_legacy_sse_app)


@app.api_route("/sse", methods=["GET", "HEAD", "POST", "DELETE"])
async def sse_alias() -> RedirectResponse:
    # Some MCP clients probe /sse directly; redirect while preserving method.
    return RedirectResponse(url="/mcp/sse", status_code=307)


__all__ = ["app", "mcp", "database", "embedder", "tool_invokers"]
