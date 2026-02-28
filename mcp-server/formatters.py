from __future__ import annotations

from dataclasses import is_dataclass, asdict
from datetime import date, datetime, time
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Mapping
from uuid import UUID

_ARRAY_KEY_HINTS = {
    "products",
    "results",
    "variants",
    "tags",
    "images",
    "top_tags",
    "product_types",
    "options",
    "values",
}


class _OmitType:
    pass


_OMIT = _OmitType()


def _price_to_cents(value: Any, key: str) -> Any:
    key_lower = key.lower()
    key_is_cents = "cents" in key_lower

    if isinstance(value, bool):
        return int(value)

    if isinstance(value, int):
        return int(value)

    if isinstance(value, float):
        if key_is_cents:
            return int(round(value))
        return int(round(value * 100))

    if isinstance(value, Decimal):
        if key_is_cents:
            return int(value.to_integral_value(rounding=ROUND_HALF_UP))
        return int((value * Decimal("100")).to_integral_value(rounding=ROUND_HALF_UP))

    if isinstance(value, str):
        stripped = value.strip().replace(",", "")
        if not stripped:
            return value
        try:
            parsed = Decimal(stripped)
        except Exception:
            return value
        if key_is_cents:
            return int(parsed.to_integral_value(rounding=ROUND_HALF_UP))
        if "." in stripped:
            return int((parsed * Decimal("100")).to_integral_value(rounding=ROUND_HALF_UP))
        return int(parsed)

    return value


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value

    if isinstance(value, (int, float, Decimal)):
        return bool(value)

    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "t", "1", "yes", "y", "available", "in stock", "in_stock"}:
            return True
        if normalized in {"false", "f", "0", "no", "n", "unavailable", "out of stock", "out_of_stock"}:
            return False

    return bool(value)


def _to_plain(value: Any) -> Any:
    if value is None:
        return None

    if is_dataclass(value):
        return asdict(value)

    if isinstance(value, Mapping):
        return dict(value)

    if hasattr(value, "items") and callable(value.items):
        try:
            return dict(value)
        except Exception:
            pass

    if isinstance(value, (set, tuple)):
        return list(value)

    if isinstance(value, UUID):
        return str(value)

    if isinstance(value, (datetime, date, time)):
        return value.isoformat()

    return value


def _normalize(value: Any, key: str | None, array_keys: set[str]) -> Any:
    value = _to_plain(value)

    if value is None:
        if key and key in array_keys:
            return []
        return _OMIT

    if key:
        lowered_key = key.lower()
        if "price" in lowered_key:
            value = _price_to_cents(value, key)
        if "available" in lowered_key or "availability" in lowered_key:
            value = _to_bool(value)

    if isinstance(value, Mapping):
        output: dict[str, Any] = {}
        for child_key, child_value in value.items():
            normalized = _normalize(child_value, str(child_key), array_keys)
            if normalized is _OMIT:
                if str(child_key) in array_keys:
                    output[str(child_key)] = []
                continue
            output[str(child_key)] = normalized
        return output

    if isinstance(value, list):
        normalized_list = []
        for item in value:
            normalized_item = _normalize(item, None, array_keys)
            if normalized_item is _OMIT:
                continue
            normalized_list.append(normalized_item)
        return normalized_list

    if isinstance(value, Decimal):
        return float(value)

    return value


def format_payload(payload: Any, array_keys: set[str] | None = None) -> Any:
    """Normalizes payloads for MCP JSON responses.

    Invariants:
    - prices are integer cents
    - availability-like fields are booleans
    - keys with None values are omitted
    - array-like keys are never null
    """

    merged_array_keys = set(_ARRAY_KEY_HINTS)
    if array_keys:
        merged_array_keys.update(array_keys)

    normalized = _normalize(payload, None, merged_array_keys)
    return {} if normalized is _OMIT else normalized


__all__ = ["format_payload"]
