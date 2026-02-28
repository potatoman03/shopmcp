from __future__ import annotations

from collections import OrderedDict, defaultdict
from decimal import Decimal, ROUND_HALF_UP
import json
import logging
import os
import random
import time
from urllib.parse import quote
from typing import Any, Awaitable, Callable, Mapping, Sequence
from uuid import uuid4

from fastmcp import FastMCP

from db import Database
from embedder import QueryEmbedder
from formatters import format_payload
from tools.context import get_store_slug

ToolInvoker = Callable[..., Awaitable[dict[str, Any] | list[dict[str, Any]]]]
_RRF_K = 60
_MAX_V2_RESULTS = 8
_DEFAULT_V2_RESULTS = 5
_V2_PAYLOAD_LIMIT_BYTES = 12 * 1024
_PRODUCT_ONLY_SQL = "coalesce(is_catalog_product, true) = true"
_BASKET_MAX_QUANTITY = 99

_LOGGER = logging.getLogger("shopmcp.mcp.tools")


class _TTLCache:
    def __init__(self, max_size: int, ttl_seconds: int) -> None:
        self._max_size = max(1, max_size)
        self._ttl_seconds = max(1, ttl_seconds)
        self._store: OrderedDict[str, tuple[float, Any]] = OrderedDict()

    def get(self, key: str) -> Any | None:
        now = time.time()
        item = self._store.get(key)
        if item is None:
            return None
        expires_at, value = item
        if expires_at <= now:
            self._store.pop(key, None)
            return None
        self._store.move_to_end(key)
        return value

    def set(self, key: str, value: Any) -> None:
        expires_at = time.time() + self._ttl_seconds
        self._store[key] = (expires_at, value)
        self._store.move_to_end(key)
        while len(self._store) > self._max_size:
            self._store.popitem(last=False)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except Exception:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except Exception:
        return default


_V2_ENABLED = _env_bool("MCP_V2_ENABLED", True)
_SHADOW_SAMPLE_RATE = max(0.0, min(1.0, _env_float("MCP_V2_SHADOW_SAMPLE_RATE", 0.0)))
_SEARCH_CACHE = _TTLCache(
    max_size=max(50, _env_int("MCP_SEARCH_CACHE_SIZE", 2000)),
    ttl_seconds=max(5, _env_int("MCP_SEARCH_CACHE_TTL_SEC", 45)),
)
_EMBED_CACHE = _TTLCache(
    max_size=max(100, _env_int("MCP_EMBED_QUERY_CACHE_SIZE", 5000)),
    ttl_seconds=max(60, _env_int("MCP_EMBED_QUERY_CACHE_TTL_SEC", 900)),
)


def _as_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    return {}


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple | set):
        return list(value)
    return [value]


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, Decimal)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "t", "1", "yes", "y", "in stock", "available", "instock"}:
            return True
        if normalized in {"false", "f", "0", "no", "n", "out of stock", "unavailable", "outofstock"}:
            return False
    return default


def _to_cents(value: Any, assume_cents_for_int: bool = True) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value if assume_cents_for_int else value * 100
    if isinstance(value, float):
        return int(round(value * 100))
    if isinstance(value, Decimal):
        return int((value * Decimal("100")).to_integral_value(rounding=ROUND_HALF_UP))
    if isinstance(value, str):
        stripped = value.strip().replace(",", "")
        if not stripped:
            return None
        try:
            parsed = Decimal(stripped)
        except Exception:
            return None
        if "." in stripped:
            return int((parsed * Decimal("100")).to_integral_value(rounding=ROUND_HALF_UP))
        return int(parsed)
    return None


def _normalize_options(options: Mapping[str, Any] | None) -> dict[str, str]:
    if not options:
        return {}
    normalized: dict[str, str] = {}
    for key, value in options.items():
        key_text = str(key).strip().lower()
        value_text = str(value).strip().lower()
        if key_text and value_text:
            normalized[key_text] = value_text
    return normalized


def _variant_options(variant: Mapping[str, Any]) -> dict[str, str]:
    options = _as_mapping(variant.get("options"))
    if options:
        return {str(k).strip(): str(v).strip() for k, v in options.items() if str(k).strip() and str(v).strip()}

    result: dict[str, str] = {}
    for idx, key in enumerate(("option1", "option2", "option3"), start=1):
        raw = variant.get(key)
        if raw is None:
            continue
        value = str(raw).strip()
        if value:
            result[f"Option {idx}"] = value
    return result


def _variant_available(variant: Mapping[str, Any]) -> bool:
    if "available" in variant:
        return _to_bool(variant.get("available"))
    if "availability" in variant:
        return _to_bool(variant.get("availability"))
    return False


def _variant_price(variant: Mapping[str, Any]) -> int | None:
    if "price_cents" in variant:
        return _to_cents(variant.get("price_cents"), assume_cents_for_int=True)
    if "price" in variant:
        return _to_cents(variant.get("price"), assume_cents_for_int=False)
    return None


def _variant_id(variant: Mapping[str, Any]) -> str:
    return str(variant.get("id") or variant.get("variant_id") or "")


def _new_basket_id() -> str:
    return f"basket_{uuid4().hex[:24]}"


def _normalize_basket_id(raw: Any) -> str:
    text = str(raw or "").strip()
    return text


def _bounded_quantity(value: Any, default: int = 1) -> int:
    try:
        parsed = int(value)
    except Exception:
        parsed = default
    return max(1, min(_BASKET_MAX_QUANTITY, parsed))


def _line_total(unit_price: int, quantity: int) -> int:
    return max(0, int(unit_price)) * max(0, int(quantity))


def _available_option_values(variants: Sequence[Mapping[str, Any]]) -> dict[str, list[str]]:
    option_values: dict[str, set[str]] = defaultdict(set)
    for variant in variants:
        if not _variant_available(variant):
            continue
        for key, value in _variant_options(variant).items():
            key_text = str(key).strip()
            value_text = str(value).strip()
            if key_text and value_text:
                option_values[key_text].add(value_text)
    return {key: sorted(values) for key, values in option_values.items()}


def _option_preview(available_options: Mapping[str, Sequence[str]], max_values_per_option: int = 6) -> dict[str, list[str]]:
    preview: dict[str, list[str]] = {}
    preferred = ["Shade", "Color"]

    def _clip_values(values: Sequence[str]) -> list[str]:
        normalized = [str(value) for value in values]
        if len(normalized) <= max_values_per_option:
            return normalized
        if max_values_per_option <= 1:
            return [f"+{len(normalized)} options"]
        head = normalized[: max_values_per_option - 1]
        head.append(f"+{len(normalized) - (max_values_per_option - 1)} more")
        return head

    for name in preferred:
        values = available_options.get(name)
        if values:
            preview[name] = _clip_values(values)

    if preview:
        return preview

    for key, values in available_options.items():
        preview[str(key)] = _clip_values(values)
        break
    return preview


def _recommended_option(
    available_options: Mapping[str, Sequence[str]],
    skin_tone: str | None
) -> dict[str, str] | None:
    if not skin_tone:
        return None
    tone_tokens = _skin_tone_tokens(skin_tone)
    if not tone_tokens:
        return None

    option_priority = ["Shade", "Color"]
    for option_name in option_priority:
        values = available_options.get(option_name)
        if not values:
            continue
        for value in values:
            value_tokens = {token.strip().lower() for token in str(value).replace("-", " ").split() if token.strip()}
            if value_tokens.intersection(tone_tokens):
                return {"name": option_name, "value": str(value)}
            lower_value = str(value).strip().lower()
            if any(token in lower_value for token in tone_tokens):
                return {"name": option_name, "value": str(value)}
    return None


def _matched_options_for_skin_tone(
    available_options: Mapping[str, Sequence[str]],
    skin_tone: str | None,
    max_matches: int = 3,
) -> list[str]:
    tone_tokens = _skin_tone_tokens(skin_tone)
    if not tone_tokens:
        return []

    matches: list[str] = []
    for option_name in ("Shade", "Color"):
        values = available_options.get(option_name)
        if not values:
            continue
        for value in values:
            value_text = str(value).strip()
            value_tokens = {token.strip().lower() for token in value_text.replace("-", " ").split() if token.strip()}
            lowered = value_text.lower()
            if value_tokens.intersection(tone_tokens) or any(token in lowered for token in tone_tokens):
                matches.append(f"{option_name}: {value_text}")
            if len(matches) >= max_matches:
                return matches
    return matches


def _infer_skin_tone_from_query(query: str) -> str | None:
    lowered = query.strip().lower()
    if not lowered:
        return None

    if any(token in lowered for token in ("deep", "dark", "darker", "deeper", "rich")):
        return "dark"
    if any(token in lowered for token in ("tan", "medium", "olive")):
        return "medium"
    if any(token in lowered for token in ("light", "fair", "pale")):
        return "light"
    return None


def _canonical_product_url(raw_url: Any, store_url: str | None = None) -> str:
    if raw_url is None:
        return ""

    text = str(raw_url).strip()
    if not text:
        return ""

    lowered = text.lower()
    if lowered.startswith("http://") or lowered.startswith("https://"):
        return text
    if text.startswith("//"):
        return f"https:{text}"

    if store_url:
        base = str(store_url).strip().rstrip("/")
        if base:
            suffix = text if text.startswith("/") else f"/{text}"
            return f"{base}{suffix}"

    return text


def _summary_fallback(product: Mapping[str, Any]) -> str:
    title = str(product.get("title") or "Product").strip()
    product_type = str(product.get("product_type") or "Product").strip()
    price_min = _to_cents(product.get("price_min"), assume_cents_for_int=True)
    price_max = _to_cents(product.get("price_max"), assume_cents_for_int=True)
    available = _to_bool(product.get("available"), default=False)

    price_part = ""
    if price_min is not None and price_max is not None:
        if price_min == price_max:
            price_part = f" at ${price_min / 100:.2f}"
        else:
            price_part = f" from ${price_min / 100:.2f} to ${price_max / 100:.2f}"
    elif price_min is not None:
        price_part = f" from ${price_min / 100:.2f}"
    elif price_max is not None:
        price_part = f" up to ${price_max / 100:.2f}"

    availability = "in stock" if available else "currently unavailable"
    return f"{title}: {product_type} {availability}{price_part}.".strip()


def _product_from_row(row: Any) -> dict[str, Any]:
    base = {
        "id": str(row["product_id"]),
        "handle": row["handle"],
        "title": row["title"],
        "product_type": row["product_type"],
        "vendor": row["vendor"],
        "tags": row["tags"] if isinstance(row["tags"], list) else [],
        "price_min": row["price_min"],
        "price_max": row["price_max"],
        "available": _to_bool(row["available"]),
        "url": row["url"],
        "summary_short": row.get("summary_short"),
        "summary_llm": row.get("summary_llm"),
        "option_tokens": row.get("option_tokens") if isinstance(row.get("option_tokens"), list) else [],
        "is_catalog_product": _to_bool(row.get("is_catalog_product"), default=True),
    }
    data = _as_mapping(row["data"])
    merged = {**data, **{k: v for k, v in base.items() if v is not None}}
    if "variants" not in merged:
        merged["variants"] = _as_list(data.get("variants"))
    if "summary_short" not in merged:
        merged["summary_short"] = _summary_fallback(merged)
    return merged


def _product_summary(product: Mapping[str, Any], score: float | None = None, store_url: str | None = None) -> dict[str, Any]:
    variants = [_as_mapping(v) for v in _as_list(product.get("variants"))]
    prices = [_variant_price(v) for v in variants]
    prices = [p for p in prices if p is not None]

    price_min = _to_cents(product.get("price_min"), assume_cents_for_int=True)
    price_max = _to_cents(product.get("price_max"), assume_cents_for_int=True)
    if prices:
        price_min = min(prices) if price_min is None else min(price_min, min(prices))
        price_max = max(prices) if price_max is None else max(price_max, max(prices))

    available = _to_bool(product.get("available"), default=False)
    if variants:
        available = any(_variant_available(v) for v in variants)

    product_url = _canonical_product_url(product.get("url"), store_url)
    payload: dict[str, Any] = {
        "title": product.get("title"),
        "handle": product.get("handle"),
        "price_min": price_min,
        "price_max": price_max,
        "available": available,
        "variant_count": len(variants),
        "url": product_url,
        "product_url": product_url,
        "link": product_url,
        "summary_short": str(product.get("summary_llm") or product.get("summary_short") or _summary_fallback(product)).strip(),
    }
    if score is not None:
        payload["score"] = round(score, 6)
    return payload


def _rrf_fuse(rankings: Sequence[Sequence[tuple[str, int]]], limit: int) -> list[tuple[str, float]]:
    scores: dict[str, float] = defaultdict(float)
    for ranking in rankings:
        for product_id, rank in ranking:
            scores[product_id] += 1.0 / (_RRF_K + rank)
    ordered = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    return ordered[:limit]


def _embedding_literal(embedding: Sequence[float]) -> str:
    return "[" + ",".join(f"{item:.8f}" for item in embedding) + "]"


def _cache_key(parts: Sequence[Any]) -> str:
    return "|".join(str(part) for part in parts)


def _skin_tone_tokens(skin_tone: str | None) -> set[str]:
    tone = (skin_tone or "").strip().lower()
    if not tone:
        return set()
    if tone in {"deep", "dark", "darker"}:
        return {
            "deep",
            "rich",
            "dark",
            "berry",
            "plum",
            "cocoa",
            "espresso",
            "mahogany",
            "fig",
            "ember",
            "vesper",
            "brown",
        }
    if tone in {"tan", "medium"}:
        return {"tan", "medium", "rose", "mauve", "caramel", "spice", "warm", "neutral"}
    if tone in {"light", "fair"}:
        return {"light", "fair", "pink", "peach", "nude", "cool", "soft"}
    return {tone}


def _extract_product_tokens(product: Mapping[str, Any]) -> set[str]:
    tokens: list[str] = []
    title = str(product.get("title") or "")
    product_type = str(product.get("product_type") or "")
    handle = str(product.get("handle") or "")
    tokens.extend(title.replace("/", " ").replace("-", " ").split())
    tokens.extend(product_type.replace("/", " ").replace("-", " ").split())
    tokens.extend(handle.replace("/", " ").replace("-", " ").split())
    tags = product.get("tags")
    if isinstance(tags, list):
        for tag in tags:
            tokens.extend(str(tag).replace("/", " ").replace("-", " ").split())
    option_tokens = product.get("option_tokens")
    if isinstance(option_tokens, list):
        for value in option_tokens:
            tokens.extend(str(value).replace("/", " ").replace("-", " ").split())
    variants = _as_list(product.get("variants"))
    for variant_raw in variants:
        variant = _as_mapping(variant_raw)
        variant_title = str(variant.get("title") or "")
        tokens.extend(variant_title.replace("/", " ").replace("-", " ").split())
        for option_value in _variant_options(variant).values():
            tokens.extend(str(option_value).replace("/", " ").replace("-", " ").split())

    return {token.strip().lower() for token in tokens if token and token.strip()}


def _budget_fit_score(price_min: int | None, price_max: int | None, budget_min: int | None, budget_max: int | None) -> float:
    if budget_min is None and budget_max is None:
        return 1.0
    floor = price_min if price_min is not None else price_max
    ceiling = price_max if price_max is not None else price_min

    if floor is None and ceiling is None:
        return 0.5

    if budget_max is not None and floor is not None and floor > budget_max:
        return 0.0
    if budget_min is not None and ceiling is not None and ceiling < budget_min:
        return 0.0

    score = 1.0
    if budget_max is not None and floor is not None:
        score = min(score, max(0.1, 1.0 - (floor / max(1, budget_max)) * 0.5))
    return score


def _availability_score(available: bool) -> float:
    return 1.0 if available else 0.0


def _fit_score(product_tokens: set[str], skin_tone: str | None) -> tuple[float, bool]:
    if not skin_tone:
        return 0.5, False
    tone_tokens = _skin_tone_tokens(skin_tone)
    if not tone_tokens:
        return 0.5, False
    intersects = product_tokens.intersection(tone_tokens)
    if intersects:
        return 1.0, True
    return 0.2, False


def _serialize_bytes(payload: Any) -> int:
    return len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _enforce_payload_cap(payload: dict[str, Any], max_bytes: int = _V2_PAYLOAD_LIMIT_BYTES) -> dict[str, Any]:
    if _serialize_bytes(payload) <= max_bytes:
        payload["truncated"] = bool(payload.get("truncated", False))
        return payload

    results = list(payload.get("results") or [])
    while results:
        results.pop()
        reduced = {**payload, "results": results, "truncated": True}
        if _serialize_bytes(reduced) <= max_bytes:
            return reduced

    return {**payload, "results": [], "truncated": True}


def _safe_copy(value: Any) -> Any:
    return json.loads(json.dumps(value))


async def _auto_select_store_slug(pool: Any, query_hint: str | None = None) -> str:
    hint = (query_hint or "").strip()

    if hint:
        try:
            fts_row = await pool.fetchrow(
                """
                select store_slug, count(*)::int as matches
                from products
                where search_tsv @@ websearch_to_tsquery('simple', $1)
                  and
                """
                + _PRODUCT_ONLY_SQL
                + """
                group by store_slug
                order by matches desc, store_slug asc
                limit 1
                """,
                hint,
            )
            if fts_row and fts_row["store_slug"]:
                return str(fts_row["store_slug"])
        except Exception:
            pass

        try:
            fuzzy_row = await pool.fetchrow(
                """
                select store_slug, count(*)::int as matches
                from products
                where (
                    title ilike '%' || $1 || '%'
                    or handle ilike '%' || $1 || '%'
                    or coalesce(product_type, '') ilike '%' || $1 || '%'
                    or exists (
                      select 1
                      from unnest(tags) as t(tag)
                      where t.tag ilike '%' || $1 || '%'
                    )
                )
                  and
                """
                + _PRODUCT_ONLY_SQL
                + """
                group by store_slug
                order by matches desc, store_slug asc
                limit 1
                """,
                hint,
            )
            if fuzzy_row and fuzzy_row["store_slug"]:
                return str(fuzzy_row["store_slug"])
        except Exception:
            pass

    preferred_row = await pool.fetchrow(
        """
        select slug
        from stores
        where product_count > 0
        order by product_count desc, indexed_at desc nulls last, slug asc
        limit 1
        """
    )
    if preferred_row and preferred_row["slug"]:
        return str(preferred_row["slug"])

    fallback_row = await pool.fetchrow(
        """
        select slug
        from stores
        order by indexed_at desc nulls last, slug asc
        limit 1
        """
    )
    if fallback_row and fallback_row["slug"]:
        return str(fallback_row["slug"])

    raise RuntimeError("No indexed stores available. Index a store first or provide slug explicitly.")


async def _resolve_store_slug(pool: Any, slug: str | None = None, query_hint: str | None = None) -> str:
    explicit = (slug or "").strip()
    if explicit:
        return explicit

    scoped = (get_store_slug() or "").strip()
    if scoped:
        return scoped

    return await _auto_select_store_slug(pool, query_hint)


async def _store_url_for_slug(pool: Any, store_slug: str) -> str | None:
    row = await pool.fetchrow(
        """
        select url
        from stores
        where slug = $1
        limit 1
        """,
        store_slug,
    )
    if not row:
        return None
    value = row.get("url")
    return str(value).strip() if value else None


async def _store_meta_for_slug(pool: Any, store_slug: str) -> dict[str, str]:
    row = await pool.fetchrow(
        """
        select slug, url, platform
        from stores
        where slug = $1
        limit 1
        """,
        store_slug,
    )
    if not row:
        raise RuntimeError(f"Unknown store slug: {store_slug}")
    return {
        "slug": str(row.get("slug") or store_slug),
        "url": str(row.get("url") or "").strip(),
        "platform": str(row.get("platform") or "unknown").strip().lower() or "unknown",
    }


async def _ensure_basket(
    pool: Any,
    store_slug: str,
    basket_id: str | None = None,
) -> str:
    normalized = _normalize_basket_id(basket_id)
    if normalized:
        row = await pool.fetchrow(
            """
            select basket_id, store_slug, status
            from baskets
            where basket_id = $1
            limit 1
            """,
            normalized,
        )
        if not row:
            raise RuntimeError(f"Unknown basket_id: {normalized}")
        row_store_slug = str(row.get("store_slug") or "").strip()
        if row_store_slug and row_store_slug != store_slug:
            raise RuntimeError(
                f"basket_id {normalized} belongs to store '{row_store_slug}', expected '{store_slug}'"
            )
        status = str(row.get("status") or "active").strip().lower()
        if status != "active":
            raise RuntimeError(f"Basket '{normalized}' is not active (status={status})")
        return normalized

    new_id = _new_basket_id()
    await pool.execute(
        """
        insert into baskets (basket_id, store_slug, status, metadata, created_at, updated_at)
        values ($1, $2, 'active', '{}'::jsonb, now(), now())
        """,
        new_id,
        store_slug,
    )
    return new_id


async def _touch_basket(pool: Any, basket_id: str) -> None:
    await pool.execute(
        """
        update baskets
        set updated_at = now()
        where basket_id = $1
        """,
        basket_id,
    )


async def _set_basket_checkout(
    pool: Any,
    basket_id: str,
    checkout_url: str,
    mark_checked_out: bool,
) -> None:
    if mark_checked_out:
        await pool.execute(
            """
            update baskets
            set
              status = 'checked_out',
              checkout_url = $2,
              checked_out_at = now(),
              updated_at = now()
            where basket_id = $1
            """,
            basket_id,
            checkout_url,
        )
        return

    await pool.execute(
        """
        update baskets
        set checkout_url = $2, updated_at = now()
        where basket_id = $1
        """,
        basket_id,
        checkout_url,
    )


async def _fetch_basket(
    pool: Any,
    basket_id: str,
    expected_store_slug: str | None = None,
) -> dict[str, Any] | None:
    row = await pool.fetchrow(
        """
        select
          basket_id,
          store_slug,
          status,
          checkout_url,
          checked_out_at,
          created_at,
          updated_at
        from baskets
        where basket_id = $1
        limit 1
        """,
        basket_id,
    )
    if not row:
        return None

    store_slug = str(row.get("store_slug") or "").strip()
    if expected_store_slug and store_slug and store_slug != expected_store_slug:
        return None

    item_rows = await pool.fetch(
        """
        select
          variant_id,
          product_handle,
          product_title,
          product_url,
          options,
          unit_price,
          quantity,
          available,
          added_at,
          updated_at
        from basket_items
        where basket_id = $1
        order by added_at asc, variant_id asc
        """,
        basket_id,
    )

    items: list[dict[str, Any]] = []
    subtotal_cents = 0
    total_quantity = 0
    for item_row in item_rows:
        unit_price = _to_cents(item_row.get("unit_price"), assume_cents_for_int=True) or 0
        quantity = max(1, int(item_row.get("quantity") or 1))
        line_total = _line_total(unit_price, quantity)
        subtotal_cents += line_total
        total_quantity += quantity

        item_payload = {
            "variant_id": str(item_row.get("variant_id") or ""),
            "handle": str(item_row.get("product_handle") or ""),
            "title": str(item_row.get("product_title") or ""),
            "url": str(item_row.get("product_url") or ""),
            "product_url": str(item_row.get("product_url") or ""),
            "link": str(item_row.get("product_url") or ""),
            "options": _as_mapping(item_row.get("options")),
            "unit_price": unit_price,
            "quantity": quantity,
            "line_total": line_total,
            "available": _to_bool(item_row.get("available"), default=False),
            "added_at": item_row.get("added_at").isoformat() if item_row.get("added_at") else None,
            "updated_at": item_row.get("updated_at").isoformat() if item_row.get("updated_at") else None,
        }
        items.append(item_payload)

    basket_payload: dict[str, Any] = {
        "basket_id": str(row.get("basket_id") or basket_id),
        "store_slug": store_slug,
        "status": str(row.get("status") or "active"),
        "checkout_url": str(row.get("checkout_url") or "").strip(),
        "checked_out_at": row.get("checked_out_at").isoformat() if row.get("checked_out_at") else None,
        "created_at": row.get("created_at").isoformat() if row.get("created_at") else None,
        "updated_at": row.get("updated_at").isoformat() if row.get("updated_at") else None,
        "currency": "USD",
        "item_count": len(items),
        "quantity_total": total_quantity,
        "subtotal": subtotal_cents,
        "items": items,
    }
    return basket_payload


async def _fetch_basket_header(pool: Any, basket_id: str) -> dict[str, str] | None:
    row = await pool.fetchrow(
        """
        select basket_id, store_slug, status
        from baskets
        where basket_id = $1
        limit 1
        """,
        basket_id,
    )
    if not row:
        return None
    return {
        "basket_id": str(row.get("basket_id") or basket_id),
        "store_slug": str(row.get("store_slug") or "").strip(),
        "status": str(row.get("status") or "active").strip().lower(),
    }


def _shopify_checkout_url(store_url: str, items: Sequence[Mapping[str, Any]]) -> str:
    base = str(store_url or "").strip().rstrip("/")
    if not base:
        return ""

    encoded_lines: list[str] = []
    for item in items:
        variant_id = str(item.get("variant_id") or "").strip()
        quantity = _bounded_quantity(item.get("quantity"), default=1)
        if not variant_id:
            continue
        encoded_lines.append(f"{quote(variant_id, safe='')}:{quantity}")

    if not encoded_lines:
        return ""
    return f"{base}/cart/{','.join(encoded_lines)}"


async def _fetch_products(pool: Any, store_slug: str, product_ids: Sequence[str]) -> dict[str, dict[str, Any]]:
    if not product_ids:
        return {}
    rows = await pool.fetch(
        """
        select
          product_id::text as product_id,
          handle,
          title,
          product_type,
          vendor,
          tags,
          price_min,
          price_max,
          available,
          url,
          summary_short,
          summary_llm,
          option_tokens,
          is_catalog_product,
          data
        from products
        where store_slug = $1
          and product_id::text = any($2::text[])
          and
        """
        + _PRODUCT_ONLY_SQL
        + """
        """,
        store_slug,
        list(product_ids),
    )
    return {str(row["product_id"]): _product_from_row(row) for row in rows}


async def _find_by_handle(pool: Any, store_slug: str, handle: str) -> dict[str, Any] | None:
    row = await pool.fetchrow(
        """
        select
          product_id::text as product_id,
          handle,
          title,
          product_type,
          vendor,
          tags,
          price_min,
          price_max,
          available,
          url,
          summary_short,
          summary_llm,
          option_tokens,
          is_catalog_product,
          data
        from products
        where store_slug = $1 and handle = $2
          and
        """
        + _PRODUCT_ONLY_SQL
        + """
        limit 1
        """,
        store_slug,
        handle,
    )
    if not row:
        return None
    return _product_from_row(row)


def _resolve_variant_for_cart(
    product: Mapping[str, Any],
    variant_id: str | None = None,
    options: Mapping[str, Any] | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    variants = [_as_mapping(item) for item in _as_list(product.get("variants"))]
    if not variants:
        return None, "no_variants"

    requested_variant_id = str(variant_id or "").strip()
    if requested_variant_id:
        for candidate in variants:
            if _variant_id(candidate) == requested_variant_id:
                return candidate, None
        return None, "variant_not_found"

    requested_options = _normalize_options(options or {})
    if requested_options:
        for candidate in variants:
            candidate_options = _normalize_options(_variant_options(candidate))
            if all(candidate_options.get(key) == value for key, value in requested_options.items()):
                return candidate, None
        return None, "options_not_found"

    available_variants = [candidate for candidate in variants if _variant_available(candidate)]
    if len(available_variants) == 1:
        return available_variants[0], None
    if len(variants) == 1:
        return variants[0], None
    return None, "variant_selection_required"


def register_tools(mcp: FastMCP, db: Database, embedder: QueryEmbedder) -> dict[str, ToolInvoker]:
    async def _embed_query_cached(query_text: str) -> list[float] | None:
        if not embedder.enabled:
            return None
        key = f"embed:{query_text.strip().lower()}"
        cached = _EMBED_CACHE.get(key)
        if cached is not None:
            return list(cached)
        vector = await embedder.embed_query(query_text)
        _EMBED_CACHE.set(key, vector)
        return vector

    async def _list_stores(limit: int = 25) -> dict[str, Any]:
        pool = db.pool
        bounded_limit = max(1, min(limit, 200))
        rows = await pool.fetch(
            """
            select
              slug,
              store_name,
              url,
              platform,
              product_count,
              indexed_at,
              last_error
            from stores
            order by product_count desc, indexed_at desc nulls last, slug asc
            limit $1
            """,
            bounded_limit,
        )

        stores = [
            {
                "slug": str(row["slug"]),
                "store_name": row["store_name"],
                "url": row["url"],
                "platform": row["platform"],
                "product_count": int(row["product_count"] or 0),
                "indexed_at": row["indexed_at"].isoformat() if row["indexed_at"] else None,
                "last_error": row["last_error"],
            }
            for row in rows
        ]
        return format_payload({"stores": stores, "count": len(stores)}, array_keys={"stores"})

    async def _search_products(
        query: str,
        max_results: int = 10,
        available_only: bool = True,
        slug: str | None = None,
    ) -> list[dict[str, Any]]:
        pool = db.pool

        query_text = query.strip()
        if not query_text:
            return []
        store_slug = await _resolve_store_slug(pool, slug, query_hint=query_text)
        store_url = await _store_url_for_slug(pool, store_slug)

        limit = max(1, min(max_results, 50))
        candidate_limit = max(120, limit * 10)

        fts_rows = await pool.fetch(
            """
            with ranked as (
              select
                product_id::text as product_id,
                row_number() over (
                  order by ts_rank_cd(search_tsv, websearch_to_tsquery('simple', $2)) desc, product_id::text
                ) as rank
              from products
              where store_slug = $1
                and search_tsv @@ websearch_to_tsquery('simple', $2)
                and
            """
            + _PRODUCT_ONLY_SQL
            + """
              limit $3
            )
            select product_id, rank from ranked
            """,
            store_slug,
            query_text,
            candidate_limit,
        )
        fts_ranked = [(str(row["product_id"]), int(row["rank"])) for row in fts_rows]

        vector_ranked: list[tuple[str, int]] = []
        if embedder.enabled:
            try:
                embedding = await _embed_query_cached(query_text)
                if embedding is not None:
                    vector_rows = await pool.fetch(
                        """
                        select
                          product_id::text as product_id,
                          row_number() over (order by embedding <=> $2::vector, product_id::text) as rank
                        from products
                        where store_slug = $1 and embedding is not null
                          and
                        """
                        + _PRODUCT_ONLY_SQL
                        + """
                        order by embedding <=> $2::vector, product_id::text
                        limit $3
                        """,
                        store_slug,
                        _embedding_literal(embedding),
                        candidate_limit,
                    )
                    vector_ranked = [(str(row["product_id"]), int(row["rank"])) for row in vector_rows]
            except Exception:
                vector_ranked = []

        fused = _rrf_fuse([vector_ranked, fts_ranked], limit=max(limit * 5, limit))
        product_ids = [product_id for product_id, _ in fused]
        products = await _fetch_products(pool, store_slug, product_ids)
        score_by_id = {product_id: score for product_id, score in fused}
        inferred_skin_tone = _infer_skin_tone_from_query(query_text)

        results: list[dict[str, Any]] = []
        for product_id in product_ids:
            product = products.get(product_id)
            if not product:
                continue
            summary = _product_summary(product, score_by_id.get(product_id), store_url=store_url)
            if available_only and not _to_bool(summary.get("available"), default=False):
                continue
            variants = [_as_mapping(v) for v in _as_list(product.get("variants"))]
            available_options = _available_option_values(variants)
            option_preview = _option_preview(available_options, max_values_per_option=5)
            recommended_option = _recommended_option(available_options, inferred_skin_tone)
            tone_matches = _matched_options_for_skin_tone(available_options, inferred_skin_tone, max_matches=2)
            if option_preview:
                summary["available_options_preview"] = option_preview
            if recommended_option:
                summary["recommended_option"] = recommended_option
            if tone_matches:
                summary["tone_matches"] = tone_matches
            summary["store_slug"] = store_slug
            results.append(summary)
            if len(results) >= limit:
                break

        if _V2_ENABLED and _SHADOW_SAMPLE_RATE > 0 and random.random() <= _SHADOW_SAMPLE_RATE:
            try:
                shadow = await _search_products_v2(
                    query=query_text,
                    slug=store_slug,
                    limit=min(limit, _DEFAULT_V2_RESULTS),
                    available_only=available_only,
                )
                _LOGGER.info(
                    "search_v2_shadow",
                    extra={
                        "store_slug": store_slug,
                        "query": query_text,
                        "v1_count": len(results),
                        "v2_count": len(shadow.get("results") or []),
                    },
                )
            except Exception:
                pass

        return format_payload(results, array_keys={"tags"})

    async def _search_products_v2(
        query: str,
        slug: str | None = None,
        limit: int = _DEFAULT_V2_RESULTS,
        available_only: bool = True,
        budget_max_cents: int | None = None,
        budget_min_cents: int | None = None,
        skin_tone: str | None = None,
        sort: str = "best_match",
    ) -> dict[str, Any]:
        if not _V2_ENABLED:
            return {"error": "v2 tools are disabled", "code": "v2_disabled"}

        started = time.perf_counter()
        pool = db.pool
        query_text = query.strip()
        if not query_text:
            return {
                "store_slug": "",
                "query": "",
                "summary": "No query provided.",
                "applied_filters": {
                    "available_only": bool(available_only),
                    "budget_max_cents": budget_max_cents,
                    "budget_min_cents": budget_min_cents,
                    "skin_tone": skin_tone,
                },
                "excluded_counts": {"over_budget": 0, "unavailable": 0, "low_relevance": 0},
                "results": [],
                "truncated": False,
            }

        bounded_limit = max(1, min(limit, _MAX_V2_RESULTS))
        store_slug = await _resolve_store_slug(pool, slug, query_hint=query_text)
        store_url = await _store_url_for_slug(pool, store_slug)
        normalized_sort = (sort or "best_match").strip().lower()
        if normalized_sort not in {"best_match", "price_low_to_high", "price_high_to_low"}:
            normalized_sort = "best_match"

        cache_key = _cache_key(
            [
                "v2",
                store_slug,
                query_text.lower(),
                bounded_limit,
                bool(available_only),
                budget_max_cents,
                budget_min_cents,
                (skin_tone or "").strip().lower(),
                normalized_sort,
            ]
        )
        cached = _SEARCH_CACHE.get(cache_key)
        if cached is not None:
            cached_payload = _safe_copy(cached)
            cached_payload["cache_hit"] = True
            return cached_payload

        embed_started = time.perf_counter()
        embedding: list[float] | None = None
        if embedder.enabled:
            try:
                embedding = await _embed_query_cached(query_text)
            except Exception:
                embedding = None
        embed_ms = (time.perf_counter() - embed_started) * 1000

        db_started = time.perf_counter()
        candidate_limit = max(100, bounded_limit * 20)

        fts_rows = await pool.fetch(
            """
            with ranked as (
              select
                product_id::text as product_id,
                row_number() over (
                  order by ts_rank_cd(search_tsv, websearch_to_tsquery('simple', $2)) desc, product_id::text
                ) as rank
              from products
              where store_slug = $1
                and search_tsv @@ websearch_to_tsquery('simple', $2)
                and
            """
            + _PRODUCT_ONLY_SQL
            + """
              limit $3
            )
            select product_id, rank from ranked
            """,
            store_slug,
            query_text,
            candidate_limit,
        )
        fts_ranked = [(str(row["product_id"]), int(row["rank"])) for row in fts_rows]

        vector_ranked: list[tuple[str, int]] = []
        if embedding is not None:
            vector_rows = await pool.fetch(
                """
                select
                  product_id::text as product_id,
                  row_number() over (order by embedding <=> $2::vector, product_id::text) as rank
                from products
                where store_slug = $1 and embedding is not null
                  and
                """
                + _PRODUCT_ONLY_SQL
                + """
                order by embedding <=> $2::vector, product_id::text
                limit $3
                """,
                store_slug,
                _embedding_literal(embedding),
                candidate_limit,
            )
            vector_ranked = [(str(row["product_id"]), int(row["rank"])) for row in vector_rows]

        fused = _rrf_fuse([vector_ranked, fts_ranked], limit=max(candidate_limit, 120))
        product_ids = [product_id for product_id, _ in fused]
        products = await _fetch_products(pool, store_slug, product_ids)
        db_ms = (time.perf_counter() - db_started) * 1000

        rank_started = time.perf_counter()
        score_by_id = {product_id: score for product_id, score in fused}

        excluded_counts = {
            "over_budget": 0,
            "unavailable": 0,
            "low_relevance": 0,
        }
        scored: list[dict[str, Any]] = []

        for product_id in product_ids:
            product = products.get(product_id)
            if not product:
                continue

            summary = _product_summary(product, score_by_id.get(product_id), store_url=store_url)
            variants = [_as_mapping(v) for v in _as_list(product.get("variants"))]
            available_options = _available_option_values(variants)
            option_preview = _option_preview(available_options, max_values_per_option=5)
            recommended_option = _recommended_option(available_options, skin_tone)
            tone_option_matches = _matched_options_for_skin_tone(available_options, skin_tone, max_matches=2)
            price_min = _to_cents(summary.get("price_min"), assume_cents_for_int=True)
            price_max = _to_cents(summary.get("price_max"), assume_cents_for_int=True)
            available = _to_bool(summary.get("available"), default=False)

            if available_only and not available:
                excluded_counts["unavailable"] += 1
                continue
            if budget_max_cents is not None and price_min is not None and price_min > budget_max_cents:
                excluded_counts["over_budget"] += 1
                continue
            if budget_min_cents is not None and price_max is not None and price_max < budget_min_cents:
                excluded_counts["over_budget"] += 1
                continue

            relevance = float(score_by_id.get(product_id, 0.0))
            if relevance <= 0:
                excluded_counts["low_relevance"] += 1
                continue

            budget_fit = _budget_fit_score(price_min, price_max, budget_min_cents, budget_max_cents)
            availability_fit = _availability_score(available)
            product_tokens = _extract_product_tokens(product)
            tone_fit, tone_match = _fit_score(product_tokens, skin_tone)

            fit_signals = ["intent_match"]
            if budget_fit > 0:
                fit_signals.append("under_budget")
            if available:
                fit_signals.append("in_stock")
            if tone_match:
                fit_signals.append("deeper_shade_signal" if (skin_tone or "").lower() in {"deep", "dark", "darker"} else "skin_tone_signal")
            if recommended_option:
                fit_signals.append("recommended_option")

            score = (0.50 * relevance) + (0.20 * budget_fit) + (0.15 * availability_fit) + (0.10 * tone_fit) + (0.05 * 1.0)

            why_parts = ["Matches query intent"]
            if budget_fit > 0:
                why_parts.append("within budget")
            if tone_match:
                why_parts.append("shade fit signal detected")
            if tone_option_matches:
                why_parts.append(f"tone-aligned options: {', '.join(tone_option_matches)}")

            scored_row: dict[str, Any] = {
                "handle": summary.get("handle"),
                "title": summary.get("title"),
                "price_min": price_min,
                "price_max": price_max,
                "available": available,
                "url": summary.get("url"),
                "product_url": summary.get("url"),
                "link": summary.get("url"),
                "variant_count": summary.get("variant_count"),
                "summary_short": str(summary.get("summary_short") or _summary_fallback(product)).strip(),
                "why_match": "; ".join(why_parts),
                "fit_signals": fit_signals,
                "_score": score,
            }
            if option_preview:
                scored_row["available_options_preview"] = option_preview
            if recommended_option:
                scored_row["recommended_option"] = recommended_option
            if tone_option_matches:
                scored_row["tone_matches"] = tone_option_matches

            scored.append(scored_row)

        if normalized_sort == "price_low_to_high":
            scored.sort(key=lambda row: (row.get("price_min") if row.get("price_min") is not None else 10**12, -row.get("_score", 0.0)))
        elif normalized_sort == "price_high_to_low":
            scored.sort(key=lambda row: (-(row.get("price_max") if row.get("price_max") is not None else -1), -row.get("_score", 0.0)))
        else:
            scored.sort(key=lambda row: (-row.get("_score", 0.0), row.get("title") or ""))

        top = scored[:bounded_limit]
        results: list[dict[str, Any]] = []
        for index, row in enumerate(top, start=1):
            result_row = {
                "rank": index,
                "handle": row.get("handle"),
                "title": row.get("title"),
                "price_min": row.get("price_min"),
                "price_max": row.get("price_max"),
                "available": row.get("available"),
                "url": row.get("url"),
                "product_url": row.get("product_url"),
                "link": row.get("link"),
                "variant_count": row.get("variant_count"),
                "summary_short": row.get("summary_short"),
                "why_match": row.get("why_match"),
                "fit_signals": row.get("fit_signals") or [],
            }
            if row.get("available_options_preview"):
                result_row["available_options_preview"] = row.get("available_options_preview")
            if row.get("recommended_option"):
                result_row["recommended_option"] = row.get("recommended_option")
            if row.get("tone_matches"):
                result_row["tone_matches"] = row.get("tone_matches")
            results.append(result_row)

        rank_ms = (time.perf_counter() - rank_started) * 1000

        summary_line = f"Top {len(results)} results for '{query_text}'"
        if budget_max_cents is not None:
            summary_line += f" under ${(budget_max_cents / 100):.2f}"
        if skin_tone:
            summary_line += f", ranked for {skin_tone} skin-tone fit"
        summary_line += "."

        response_payload: dict[str, Any] = {
            "store_slug": store_slug,
            "query": query_text,
            "summary": summary_line,
            "applied_filters": {
                "available_only": bool(available_only),
                "budget_max_cents": budget_max_cents,
                "budget_min_cents": budget_min_cents,
                "skin_tone": skin_tone,
            },
            "excluded_counts": excluded_counts,
            "results": results,
            "truncated": False,
            "cache_hit": False,
        }

        serialize_started = time.perf_counter()
        capped_payload = _enforce_payload_cap(response_payload, max_bytes=_V2_PAYLOAD_LIMIT_BYTES)
        serialize_ms = (time.perf_counter() - serialize_started) * 1000
        total_ms = (time.perf_counter() - started) * 1000

        _LOGGER.info(
            "search_products_v2_timing",
            extra={
                "store_slug": store_slug,
                "query": query_text,
                "embed_ms": round(embed_ms, 2),
                "db_ms": round(db_ms, 2),
                "rank_ms": round(rank_ms, 2),
                "serialize_ms": round(serialize_ms, 2),
                "total_ms": round(total_ms, 2),
                "result_count": len(capped_payload.get("results") or []),
                "truncated": bool(capped_payload.get("truncated")),
            },
        )

        normalized_payload = format_payload(capped_payload, array_keys={"results", "fit_signals"})
        _SEARCH_CACHE.set(cache_key, normalized_payload)
        return normalized_payload

    async def _filter_products(
        product_type: str | None = None,
        tags: list[str] | None = None,
        min_price: int | None = None,
        max_price: int | None = None,
        available_only: bool = True,
        options: dict[str, str] | None = None,
        limit: int = 20,
        slug: str | None = None,
    ) -> list[dict[str, Any]]:
        pool = db.pool
        query_hint_parts = [product_type or ""] + [tag.strip() for tag in (tags or []) if tag and tag.strip()]
        query_hint = " ".join(part for part in query_hint_parts if part).strip() or None
        store_slug = await _resolve_store_slug(pool, slug, query_hint=query_hint)
        store_url = await _store_url_for_slug(pool, store_slug)

        bounded_limit = max(1, min(limit, 100))
        params: list[Any] = [store_slug]
        clauses = ["store_slug = $1", _PRODUCT_ONLY_SQL]

        if product_type:
            params.append(product_type)
            clauses.append(f"lower(coalesce(product_type, '')) = lower(${len(params)})")

        normalized_tags = [tag.strip() for tag in (tags or []) if tag and tag.strip()]
        if normalized_tags:
            params.append(normalized_tags)
            clauses.append(f"tags @> ${len(params)}::text[]")

        if min_price is not None:
            params.append(min_price)
            clauses.append(f"coalesce(price_max, price_min, 0) >= ${len(params)}")

        if max_price is not None:
            params.append(max_price)
            clauses.append(f"coalesce(price_min, price_max, 0) <= ${len(params)}")

        if available_only and not options:
            clauses.append("available = true")

        params.append(max(bounded_limit * 15, 200))
        sql = f"""
            select
              product_id::text as product_id,
              handle,
              title,
              product_type,
              vendor,
              tags,
              price_min,
              price_max,
              available,
              url,
              summary_short,
              summary_llm,
              option_tokens,
              is_catalog_product,
              data
            from products
            where {' and '.join(clauses)}
            order by product_id::text
            limit ${len(params)}
        """

        rows = await pool.fetch(sql, *params)
        required_options = _normalize_options(options or {})

        matched: list[dict[str, Any]] = []
        for row in rows:
            product = _product_from_row(row)
            variants = [_as_mapping(v) for v in _as_list(product.get("variants"))]
            matched_variants = variants

            if required_options:
                matched_variants = []
                for variant in variants:
                    normalized_variant_options = _normalize_options(_variant_options(variant))
                    if all(normalized_variant_options.get(k) == v for k, v in required_options.items()):
                        matched_variants.append(variant)

                if not matched_variants:
                    continue

            if available_only and required_options:
                if not any(_variant_available(variant) for variant in matched_variants):
                    continue

            summary = _product_summary(product, store_url=store_url)
            if available_only and not _to_bool(summary.get("available"), default=False):
                continue
            summary["store_slug"] = store_slug
            matched.append(summary)
            if len(matched) >= bounded_limit:
                break

        return format_payload(matched, array_keys={"tags"})

    async def _get_product(handle: str, slug: str | None = None) -> dict[str, Any]:
        pool = db.pool
        store_slug = await _resolve_store_slug(pool, slug, query_hint=handle)
        store_url = await _store_url_for_slug(pool, store_slug)

        product = await _find_by_handle(pool, store_slug, handle)
        if not product:
            return format_payload({"store_slug": store_slug, "handle": handle, "found": False})

        variants = [_as_mapping(v) for v in _as_list(product.get("variants"))]
        option_values: dict[str, set[str]] = defaultdict(set)
        for variant in variants:
            if not _variant_available(variant):
                continue
            for key, value in _variant_options(variant).items():
                if key and value:
                    option_values[key].add(value)

        product["variants"] = variants
        product["available_options"] = {key: sorted(values) for key, values in option_values.items()}
        product_url = _canonical_product_url(product.get("url"), store_url)
        product["url"] = product_url
        product["product_url"] = product_url
        product["link"] = product_url
        return format_payload(
            {
                "store_slug": store_slug,
                "found": True,
                "product_url": product_url,
                "url": product_url,
                "link": product_url,
                "product": product,
            },
            array_keys={"variants"},
        )

    async def _get_product_brief_v2(handle: str, slug: str | None = None) -> dict[str, Any]:
        if not _V2_ENABLED:
            return {"error": "v2 tools are disabled", "code": "v2_disabled"}

        pool = db.pool
        store_slug = await _resolve_store_slug(pool, slug, query_hint=handle)
        store_url = await _store_url_for_slug(pool, store_slug)

        product = await _find_by_handle(pool, store_slug, handle)
        if not product:
            return format_payload({"store_slug": store_slug, "handle": handle, "found": False})

        variants = [_as_mapping(v) for v in _as_list(product.get("variants"))]
        option_values: dict[str, set[str]] = defaultdict(set)
        for variant in variants:
            if not _variant_available(variant):
                continue
            for key, value in _variant_options(variant).items():
                if key and value:
                    option_values[key].add(value)

        summary = _product_summary(product, store_url=store_url)
        payload = {
            "store_slug": store_slug,
            "found": True,
            "product": {
                "handle": summary.get("handle"),
                "title": summary.get("title"),
                "price_min": summary.get("price_min"),
                "price_max": summary.get("price_max"),
                "available": summary.get("available"),
                "url": summary.get("url"),
                "product_url": summary.get("url"),
                "link": summary.get("url"),
                "summary_short": summary.get("summary_short") or _summary_fallback(product),
                "available_options": {key: sorted(values) for key, values in option_values.items()},
                "variant_count": len(variants),
            },
        }
        return format_payload(payload, array_keys={"results"})

    async def _check_variant_availability(
        handle: str,
        options: dict[str, str],
        slug: str | None = None,
    ) -> dict[str, Any]:
        pool = db.pool
        store_slug = await _resolve_store_slug(pool, slug, query_hint=handle)
        store_url = await _store_url_for_slug(pool, store_slug)

        product = await _find_by_handle(pool, store_slug, handle)
        if not product:
            return format_payload(
                {
                    "store_slug": store_slug,
                    "available": False,
                    "variant_id": "",
                    "price": 0,
                    "matched": False,
                    "product_url": "",
                    "url": "",
                    "link": "",
                }
            )

        required_options = _normalize_options(options)
        variants = [_as_mapping(v) for v in _as_list(product.get("variants"))]
        product_url = _canonical_product_url(product.get("url"), store_url)

        for variant in variants:
            normalized_options = _normalize_options(_variant_options(variant))
            if all(normalized_options.get(k) == v for k, v in required_options.items()):
                return format_payload(
                    {
                        "store_slug": store_slug,
                        "product_url": product_url,
                        "url": product_url,
                        "link": product_url,
                        "available": _variant_available(variant),
                        "variant_id": _variant_id(variant),
                        "price": _variant_price(variant) or 0,
                        "matched": True,
                    }
                )

        return format_payload(
            {
                "store_slug": store_slug,
                "available": False,
                "variant_id": "",
                "price": 0,
                "matched": False,
                "product_url": product_url,
                "url": product_url,
                "link": product_url,
            }
        )

    async def _resolve_basket_scope(
        pool: Any,
        basket_id: str,
        slug: str | None = None,
        allow_checked_out: bool = False,
    ) -> tuple[str, str]:
        normalized_basket_id = _normalize_basket_id(basket_id)
        if not normalized_basket_id:
            raise RuntimeError("basket_id is required")

        header = await _fetch_basket_header(pool, normalized_basket_id)
        if not header:
            raise RuntimeError(f"Unknown basket_id: {normalized_basket_id}")

        basket_store_slug = str(header.get("store_slug") or "").strip()
        if not basket_store_slug:
            raise RuntimeError(f"Basket '{normalized_basket_id}' has no store association")

        resolved_slug = basket_store_slug
        if slug and str(slug).strip():
            candidate_slug = await _resolve_store_slug(pool, slug)
            if candidate_slug != basket_store_slug:
                raise RuntimeError(
                    f"basket_id {normalized_basket_id} belongs to store '{basket_store_slug}', expected '{candidate_slug}'"
                )
            resolved_slug = candidate_slug

        status = str(header.get("status") or "active").strip().lower()
        if status != "active":
            if allow_checked_out and status == "checked_out":
                return normalized_basket_id, resolved_slug
            raise RuntimeError(f"Basket '{normalized_basket_id}' is not active (status={status})")
        return normalized_basket_id, resolved_slug

    async def _add_to_basket(
        handle: str,
        quantity: int = 1,
        options: dict[str, str] | None = None,
        variant_id: str | None = None,
        basket_id: str | None = None,
        slug: str | None = None,
    ) -> dict[str, Any]:
        pool = db.pool
        handle_text = str(handle or "").strip()
        if not handle_text:
            return {"error": "handle is required", "code": "invalid_handle"}

        try:
            requested_quantity = int(quantity)
        except Exception:
            return {"error": "quantity must be an integer", "code": "invalid_quantity"}
        if requested_quantity <= 0:
            return {"error": "quantity must be >= 1", "code": "invalid_quantity"}
        quantity_value = _bounded_quantity(requested_quantity, default=1)
        store_slug = await _resolve_store_slug(pool, slug, query_hint=handle_text)
        store_url = await _store_url_for_slug(pool, store_slug)
        product = await _find_by_handle(pool, store_slug, handle_text)
        if not product:
            return {
                "error": f"Product '{handle_text}' not found in store '{store_slug}'",
                "code": "product_not_found",
                "store_slug": store_slug,
                "handle": handle_text,
            }

        selected_variant, reason = _resolve_variant_for_cart(product, variant_id=variant_id, options=options)
        variants = [_as_mapping(item) for item in _as_list(product.get("variants"))]
        if selected_variant is None:
            available_options = _available_option_values(variants)
            return format_payload(
                {
                    "error": "Unable to resolve variant for cart line",
                    "code": reason or "variant_resolution_failed",
                    "store_slug": store_slug,
                    "handle": handle_text,
                    "matched": False,
                    "available_options": available_options,
                },
                array_keys={"available_options"},
            )

        resolved_variant_id = _variant_id(selected_variant).strip()
        if not resolved_variant_id:
            return {
                "error": "Selected variant has no variant_id; cannot build checkout link",
                "code": "missing_variant_id",
                "store_slug": store_slug,
                "handle": handle_text,
            }

        normalized_options = _variant_options(selected_variant)
        unit_price = _variant_price(selected_variant)
        if unit_price is None:
            unit_price = _to_cents(product.get("price_min"), assume_cents_for_int=True) or 0

        product_url = _canonical_product_url(product.get("url"), store_url)
        product_title = str(product.get("title") or handle_text).strip() or handle_text
        available = _variant_available(selected_variant)
        if not available:
            return {
                "error": "Selected variant is unavailable",
                "code": "variant_unavailable",
                "store_slug": store_slug,
                "handle": handle_text,
                "variant_id": resolved_variant_id,
            }

        try:
            basket_id_value = await _ensure_basket(pool, store_slug, basket_id=basket_id)
        except RuntimeError as exc:
            return {
                "error": str(exc),
                "code": "basket_scope_error",
                "store_slug": store_slug,
            }
        await pool.execute(
            """
            insert into basket_items (
              basket_id,
              variant_id,
              product_handle,
              product_title,
              product_url,
              options,
              unit_price,
              quantity,
              available,
              added_at,
              updated_at
            )
            values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now(), now())
            on conflict (basket_id, variant_id) do update set
              product_handle = excluded.product_handle,
              product_title = excluded.product_title,
              product_url = excluded.product_url,
              options = excluded.options,
              unit_price = excluded.unit_price,
              quantity = basket_items.quantity + excluded.quantity,
              available = excluded.available,
              updated_at = now()
            """,
            basket_id_value,
            resolved_variant_id,
            handle_text,
            product_title,
            product_url,
            json.dumps(normalized_options),
            unit_price,
            quantity_value,
            available,
        )
        await _touch_basket(pool, basket_id_value)

        basket_payload = await _fetch_basket(pool, basket_id_value, expected_store_slug=store_slug)
        if not basket_payload:
            raise RuntimeError(f"Failed to load basket '{basket_id_value}' after update")
        return format_payload(
            {
                "store_slug": store_slug,
                "basket_id": basket_id_value,
                "added": {
                    "handle": handle_text,
                    "variant_id": resolved_variant_id,
                    "quantity_added": quantity_value,
                    "price": unit_price,
                    "available": available,
                    "options": normalized_options,
                    "product_url": product_url,
                    "url": product_url,
                    "link": product_url,
                },
                "basket": basket_payload,
            },
            array_keys={"items"},
        )

    async def _get_basket(
        basket_id: str,
        slug: str | None = None,
    ) -> dict[str, Any]:
        pool = db.pool
        normalized_basket_id = _normalize_basket_id(basket_id)
        if not normalized_basket_id:
            return {"error": "basket_id is required", "code": "invalid_basket_id"}

        expected_slug: str | None = None
        if slug and str(slug).strip():
            expected_slug = await _resolve_store_slug(pool, slug)

        basket_payload = await _fetch_basket(pool, normalized_basket_id, expected_store_slug=expected_slug)
        if not basket_payload:
            return {
                "error": f"Basket '{normalized_basket_id}' not found",
                "code": "basket_not_found",
                "basket_id": normalized_basket_id,
                "store_slug": expected_slug or "",
            }
        return format_payload(basket_payload, array_keys={"items"})

    async def _update_basket_item(
        basket_id: str,
        variant_id: str,
        quantity: int,
        slug: str | None = None,
    ) -> dict[str, Any]:
        pool = db.pool
        variant_id_text = str(variant_id or "").strip()
        if not variant_id_text:
            return {"error": "variant_id is required", "code": "invalid_variant_id"}

        try:
            resolved_basket_id, store_slug = await _resolve_basket_scope(pool, basket_id, slug)
        except RuntimeError as exc:
            return {
                "error": str(exc),
                "code": "basket_scope_error",
            }
        try:
            quantity_value = int(quantity)
        except Exception:
            return {
                "error": "quantity must be an integer",
                "code": "invalid_quantity",
                "basket_id": resolved_basket_id,
                "store_slug": store_slug,
            }

        if quantity_value <= 0:
            await pool.execute(
                """
                delete from basket_items
                where basket_id = $1 and variant_id = $2
                """,
                resolved_basket_id,
                variant_id_text,
            )
        else:
            bounded_quantity = _bounded_quantity(quantity_value, default=1)
            update_result = await pool.execute(
                """
                update basket_items
                set quantity = $3, updated_at = now()
                where basket_id = $1 and variant_id = $2
                """,
                resolved_basket_id,
                variant_id_text,
                bounded_quantity,
            )
            if update_result == "UPDATE 0":
                return {
                    "error": f"variant_id '{variant_id_text}' not found in basket",
                    "code": "basket_line_not_found",
                    "basket_id": resolved_basket_id,
                    "store_slug": store_slug,
                }

        await _touch_basket(pool, resolved_basket_id)
        basket_payload = await _fetch_basket(pool, resolved_basket_id, expected_store_slug=store_slug)
        if not basket_payload:
            raise RuntimeError(f"Failed to load basket '{resolved_basket_id}' after update")
        return format_payload(
            {
                "basket_id": resolved_basket_id,
                "store_slug": store_slug,
                "basket": basket_payload,
            },
            array_keys={"items"},
        )

    async def _remove_from_basket(
        basket_id: str,
        variant_id: str,
        slug: str | None = None,
    ) -> dict[str, Any]:
        return await _update_basket_item(
            basket_id=basket_id,
            variant_id=variant_id,
            quantity=0,
            slug=slug,
        )

    async def _clear_basket(
        basket_id: str,
        slug: str | None = None,
    ) -> dict[str, Any]:
        pool = db.pool
        try:
            resolved_basket_id, store_slug = await _resolve_basket_scope(pool, basket_id, slug)
        except RuntimeError as exc:
            return {
                "error": str(exc),
                "code": "basket_scope_error",
            }
        await pool.execute(
            """
            delete from basket_items
            where basket_id = $1
            """,
            resolved_basket_id,
        )
        await _touch_basket(pool, resolved_basket_id)
        basket_payload = await _fetch_basket(pool, resolved_basket_id, expected_store_slug=store_slug)
        if not basket_payload:
            raise RuntimeError(f"Failed to load basket '{resolved_basket_id}' after clear")
        return format_payload(
            {
                "basket_id": resolved_basket_id,
                "store_slug": store_slug,
                "basket": basket_payload,
            },
            array_keys={"items"},
        )

    async def _create_checkout_intent(
        basket_id: str,
        slug: str | None = None,
        mark_checked_out: bool = False,
    ) -> dict[str, Any]:
        pool = db.pool
        try:
            resolved_basket_id, store_slug = await _resolve_basket_scope(
                pool,
                basket_id,
                slug,
                allow_checked_out=True,
            )
        except RuntimeError as exc:
            return {
                "error": str(exc),
                "code": "basket_scope_error",
            }
        basket_payload = await _fetch_basket(pool, resolved_basket_id, expected_store_slug=store_slug)
        if not basket_payload:
            raise RuntimeError(f"Basket '{resolved_basket_id}' not found")

        basket_items = [_as_mapping(item) for item in _as_list(basket_payload.get("items"))]
        if not basket_items:
            return {
                "error": "Cannot create checkout link for an empty basket",
                "code": "empty_basket",
                "basket_id": resolved_basket_id,
                "store_slug": store_slug,
            }

        store_meta = await _store_meta_for_slug(pool, store_slug)
        platform = store_meta.get("platform", "unknown")
        store_url = store_meta.get("url", "")
        invalid_lines = [item for item in basket_items if not str(item.get("variant_id") or "").strip()]
        if platform != "shopify":
            return format_payload(
                {
                    "supported": False,
                    "reason": "unsupported_platform",
                    "platform": platform,
                    "store_slug": store_slug,
                    "basket_id": resolved_basket_id,
                    "manual_checkout": True,
                    "message": "Prefilled checkout links are only supported for Shopify stores.",
                    "basket": basket_payload,
                    "product_urls": [str(item.get("url") or "") for item in basket_items if str(item.get("url") or "")],
                },
                array_keys={"items", "product_urls"},
            )
        if invalid_lines:
            return format_payload(
                {
                    "supported": False,
                    "reason": "missing_variant_ids",
                    "platform": platform,
                    "store_slug": store_slug,
                    "basket_id": resolved_basket_id,
                    "manual_checkout": True,
                    "message": "One or more basket lines are missing variant_id values required by Shopify checkout links.",
                    "basket": basket_payload,
                },
                array_keys={"items"},
            )

        checkout_url = _shopify_checkout_url(store_url, basket_items)
        if not checkout_url:
            return {
                "error": "Unable to build checkout URL",
                "code": "checkout_url_build_failed",
                "basket_id": resolved_basket_id,
                "store_slug": store_slug,
            }

        await _set_basket_checkout(
            pool,
            resolved_basket_id,
            checkout_url,
            mark_checked_out=_to_bool(mark_checked_out, default=False),
        )
        refreshed_payload = await _fetch_basket(pool, resolved_basket_id, expected_store_slug=store_slug)
        if not refreshed_payload:
            raise RuntimeError(f"Failed to load basket '{resolved_basket_id}' after checkout intent")

        return format_payload(
            {
                "supported": True,
                "platform": platform,
                "manual_checkout": True,
                "store_slug": store_slug,
                "basket_id": resolved_basket_id,
                "checkout_url": checkout_url,
                "url": checkout_url,
                "link": checkout_url,
                "message": "Open the checkout URL to review the cart and complete checkout manually.",
                "basket": refreshed_payload,
            },
            array_keys={"items"},
        )

    async def _get_checkout_link(
        basket_id: str,
        slug: str | None = None,
    ) -> dict[str, Any]:
        return await _create_checkout_intent(
            basket_id=basket_id,
            slug=slug,
            mark_checked_out=False,
        )

    async def _checkout_items(
        items: list[dict[str, Any]],
        slug: str | None = None,
        basket_id: str | None = None,
        mark_checked_out: bool = False,
    ) -> dict[str, Any]:
        item_rows = items if isinstance(items, list) else []
        if not item_rows:
            return {"error": "items must be a non-empty array", "code": "invalid_items"}

        active_slug = (slug or "").strip() or None
        active_basket_id = _normalize_basket_id(basket_id) or None
        added_items: list[dict[str, Any]] = []

        for index, raw_item in enumerate(item_rows, start=1):
            item = _as_mapping(raw_item)
            handle = str(item.get("handle") or "").strip()
            if not handle:
                return {
                    "error": f"items[{index}] is missing handle",
                    "code": "invalid_items",
                    "line_index": index,
                    "basket_id": active_basket_id or "",
                }

            quantity_raw = item.get("quantity", 1)
            variant_id_raw = str(item.get("variant_id") or "").strip()
            options_raw = item.get("options")
            options = _as_mapping(options_raw) if isinstance(options_raw, Mapping) else None

            add_result = await _add_to_basket(
                handle=handle,
                quantity=quantity_raw,
                options=options,
                variant_id=variant_id_raw or None,
                basket_id=active_basket_id,
                slug=active_slug,
            )
            if isinstance(add_result, dict) and add_result.get("error"):
                failure = dict(add_result)
                failure["line_index"] = index
                failure["basket_id"] = str(add_result.get("basket_id") or active_basket_id or "")
                failure["added_count"] = len(added_items)
                return format_payload(failure, array_keys={"items", "added_items"})

            active_basket_id = str(add_result.get("basket_id") or active_basket_id or "").strip() or None
            active_slug = str(add_result.get("store_slug") or active_slug or "").strip() or None
            added = _as_mapping(add_result.get("added"))
            if added:
                added["line_index"] = index
                added_items.append(added)

        if not active_basket_id:
            return {"error": "Failed to create or resolve basket_id", "code": "basket_create_failed"}

        checkout_result = await _create_checkout_intent(
            basket_id=active_basket_id,
            slug=active_slug,
            mark_checked_out=mark_checked_out,
        )
        if isinstance(checkout_result, dict):
            checkout_result["added_items"] = added_items
            checkout_result["line_count"] = len(added_items)
        return format_payload(checkout_result, array_keys={"items", "added_items"})

    async def _list_categories(slug: str | None = None) -> dict[str, Any]:
        pool = db.pool
        store_slug = await _resolve_store_slug(pool, slug)

        product_type_rows = await pool.fetch(
            """
            select product_type, count(*)::int as count
            from products
            where store_slug = $1 and product_type is not null and product_type <> ''
              and
            """
            + _PRODUCT_ONLY_SQL
            + """
            group by product_type
            order by count desc, product_type asc
            """,
            store_slug,
        )
        tag_rows = await pool.fetch(
            """
            select tag, count(*)::int as count
            from (
              select unnest(tags) as tag
              from products
              where store_slug = $1
                and
              """
            + _PRODUCT_ONLY_SQL
            + """
            ) t
            where tag is not null and tag <> ''
            group by tag
            order by count desc, tag asc
            limit 25
            """,
            store_slug,
        )
        total_products_row = await pool.fetchrow(
            "select count(*)::int as total from products where store_slug = $1 and " + _PRODUCT_ONLY_SQL,
            store_slug,
        )

        return format_payload(
            {
                "store_slug": store_slug,
                "product_types": [str(row["product_type"]) for row in product_type_rows],
                "top_tags": [{"tag": str(row["tag"]), "count": int(row["count"])} for row in tag_rows],
                "total_products": int(total_products_row["total"]) if total_products_row else 0,
            },
            array_keys={"product_types", "top_tags"},
        )

    mcp.tool(name="list_stores", description="List indexed stores and their slugs for routing.")(_list_stores)
    mcp.tool(
        name="search_products",
        description="Legacy semantic + keyword product search. Prefer search_products_v2 for compact ranked output.",
    )(_search_products)
    mcp.tool(name="filter_products", description="Structured product filtering. Optional: slug.")(_filter_products)
    mcp.tool(name="get_product", description="Get complete product details by handle. Optional: slug.")(_get_product)
    mcp.tool(name="check_variant_availability", description="Check stock for exact variant options.")(
        _check_variant_availability
    )
    mcp.tool(
        name="add_to_basket",
        description="Add a product variant to a persistent basket. Creates basket when basket_id is omitted.",
    )(_add_to_basket)
    mcp.tool(name="get_basket", description="Get basket contents and totals by basket_id.")(_get_basket)
    mcp.tool(
        name="update_basket_item",
        description="Set quantity for a basket line item by basket_id + variant_id. quantity<=0 removes line.",
    )(_update_basket_item)
    mcp.tool(name="remove_from_basket", description="Remove one basket line item by variant_id.")(_remove_from_basket)
    mcp.tool(name="clear_basket", description="Remove all line items from a basket.")(_clear_basket)
    mcp.tool(
        name="create_checkout_intent",
        description="Build a manual checkout link for the current basket (Shopify prefilled cart permalink).",
    )(_create_checkout_intent)
    mcp.tool(name="get_checkout_link", description="Alias for create_checkout_intent.")(_get_checkout_link)
    mcp.tool(
        name="checkout_items",
        description="Single-call flow: add multiple items to basket and return checkout link.",
    )(_checkout_items)
    mcp.tool(name="list_categories", description="List product types and popular tags. Optional: slug.")(_list_categories)

    if _V2_ENABLED:
        mcp.tool(
            name="search_products_v2",
            description="Context-safe compact search with server-side ranking and optional budget/skin-tone filters.",
        )(_search_products_v2)
        mcp.tool(
            name="get_product_brief_v2",
            description="Compact product details without full variant payloads.",
        )(_get_product_brief_v2)

    tool_map: dict[str, ToolInvoker] = {
        "list_stores": _list_stores,
        "search_products": _search_products,
        "filter_products": _filter_products,
        "get_product": _get_product,
        "check_variant_availability": _check_variant_availability,
        "add_to_basket": _add_to_basket,
        "get_basket": _get_basket,
        "update_basket_item": _update_basket_item,
        "remove_from_basket": _remove_from_basket,
        "clear_basket": _clear_basket,
        "create_checkout_intent": _create_checkout_intent,
        "get_checkout_link": _get_checkout_link,
        "checkout_items": _checkout_items,
        "list_categories": _list_categories,
    }
    if _V2_ENABLED:
        tool_map["search_products_v2"] = _search_products_v2
        tool_map["get_product_brief_v2"] = _get_product_brief_v2

    return tool_map


__all__ = ["register_tools", "ToolInvoker"]
