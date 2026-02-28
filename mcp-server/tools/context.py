from __future__ import annotations

from contextvars import ContextVar, Token

_store_slug_var: ContextVar[str | None] = ContextVar("store_slug", default=None)


def set_store_slug(slug: str | None) -> Token:
    return _store_slug_var.set(slug)


def reset_store_slug(token: Token) -> None:
    _store_slug_var.reset(token)


def get_store_slug() -> str | None:
    return _store_slug_var.get()


def require_store_slug() -> str:
    slug = get_store_slug()
    if not slug:
        raise RuntimeError("Missing store slug in MCP request path")
    return slug


__all__ = ["set_store_slug", "reset_store_slug", "get_store_slug", "require_store_slug"]
