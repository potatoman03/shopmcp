from __future__ import annotations

from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Awaitable, Callable, Mapping, Sequence

from fastmcp import FastMCP

from db import Database
from embedder import QueryEmbedder
from formatters import format_payload
from tools.context import get_store_slug

ToolInvoker = Callable[..., Awaitable[dict[str, Any] | list[dict[str, Any]]]]
_RRF_K = 60
_PRODUCT_ONLY_SQL = """
(
  lower(url) like '%/products/%'
  or lower(url) like '%/product/%'
  or (
    jsonb_typeof(data->'variants') = 'array'
    and jsonb_array_length(data->'variants') > 0
  )
)
"""


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


def _coerce_tags(value: Any) -> list[str]:
    if isinstance(value, list):
        tags = [str(item).strip() for item in value if str(item).strip()]
    elif isinstance(value, str):
        tags = [part.strip() for part in value.split(",") if part.strip()]
    else:
        tags = []
    return list(dict.fromkeys(tags))


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
    }
    data = _as_mapping(row["data"])
    merged = {**data, **{k: v for k, v in base.items() if v is not None}}
    if "variants" not in merged:
        merged["variants"] = _as_list(data.get("variants"))
    return merged


def _product_summary(product: Mapping[str, Any], score: float | None = None) -> dict[str, Any]:
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

    payload: dict[str, Any] = {
        "title": product.get("title"),
        "handle": product.get("handle"),
        "price_min": price_min,
        "price_max": price_max,
        "available": available,
        "variant_count": len(variants),
        "url": product.get("url"),
        "product_url": product.get("url"),
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


def register_tools(mcp: FastMCP, db: Database, embedder: QueryEmbedder) -> dict[str, ToolInvoker]:
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
                embedding = await embedder.embed_query(query_text)
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

        results: list[dict[str, Any]] = []
        for product_id in product_ids:
            product = products.get(product_id)
            if not product:
                continue
            if available_only and not _to_bool(product.get("available"), default=False):
                continue
            summary = _product_summary(product, score_by_id.get(product_id))
            summary["store_slug"] = store_slug
            results.append(summary)
            if len(results) >= limit:
                break

        return format_payload(results, array_keys={"tags"})

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

        if available_only:
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

            if required_options:
                variant_match = False
                for variant in variants:
                    normalized_variant_options = _normalize_options(_variant_options(variant))
                    if all(normalized_variant_options.get(k) == v for k, v in required_options.items()):
                        variant_match = True
                        break
                if not variant_match:
                    continue

            summary = _product_summary(product)
            summary["store_slug"] = store_slug
            matched.append(summary)
            if len(matched) >= bounded_limit:
                break

        return format_payload(matched, array_keys={"tags"})

    async def _get_product(handle: str, slug: str | None = None) -> dict[str, Any]:
        pool = db.pool
        store_slug = await _resolve_store_slug(pool, slug, query_hint=handle)

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
        return format_payload({"store_slug": store_slug, "found": True, "product": product}, array_keys={"variants"})

    async def _check_variant_availability(
        handle: str,
        options: dict[str, str],
        slug: str | None = None,
    ) -> dict[str, Any]:
        pool = db.pool
        store_slug = await _resolve_store_slug(pool, slug, query_hint=handle)

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
                }
            )

        required_options = _normalize_options(options)
        variants = [_as_mapping(v) for v in _as_list(product.get("variants"))]

        for variant in variants:
            normalized_options = _normalize_options(_variant_options(variant))
            if all(normalized_options.get(k) == v for k, v in required_options.items()):
                return format_payload(
                    {
                        "store_slug": store_slug,
                        "product_url": product.get("url"),
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
                "product_url": product.get("url"),
            }
        )

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
    mcp.tool(name="search_products", description="Semantic + keyword product search. Optional: slug.")(_search_products)
    mcp.tool(name="filter_products", description="Structured product filtering. Optional: slug.")(_filter_products)
    mcp.tool(name="get_product", description="Get complete product details by handle. Optional: slug.")(_get_product)
    mcp.tool(name="check_variant_availability", description="Check stock for exact variant options.")(
        _check_variant_availability
    )
    mcp.tool(name="list_categories", description="List product types and popular tags. Optional: slug.")(_list_categories)

    return {
        "list_stores": _list_stores,
        "search_products": _search_products,
        "filter_products": _filter_products,
        "get_product": _get_product,
        "check_variant_availability": _check_variant_availability,
        "list_categories": _list_categories,
    }


__all__ = ["register_tools", "ToolInvoker"]
