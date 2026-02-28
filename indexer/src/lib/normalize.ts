import { createHash } from "node:crypto";
import {
  NormalizedProduct,
  NormalizedProductSchema,
  NormalizedVariant,
  RawProduct,
  RawProductSchema,
  RawVariant
} from "../types";
import { slugifyText } from "./slugify";
import { normalizeUrl } from "./url";

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
}

export function toIntegerCents(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value * 100));
  }

  const raw = asString(value);
  if (!raw) {
    return undefined;
  }

  const normalized = raw.replace(/[^\d.,-]/g, "").replace(/,(?=\d{2}$)/, ".");
  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.max(0, Math.round(parsed * 100));
}

export function toAvailabilityBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  const text = asString(value)?.toLowerCase();
  if (!text) {
    return undefined;
  }

  if (["instock", "in stock", "available", "true", "1", "http://schema.org/instock", "https://schema.org/instock"].includes(text)) {
    return true;
  }

  if (
    ["outofstock", "out of stock", "soldout", "sold out", "unavailable", "false", "0", "http://schema.org/outofstock", "https://schema.org/outofstock"].includes(
      text
    )
  ) {
    return false;
  }

  return undefined;
}

function parseTags(tags: RawProduct["tags"]): string[] {
  if (Array.isArray(tags)) {
    const cleaned = tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
    return [...new Set(cleaned)];
  }

  const text = asString(tags);
  if (!text) {
    return [];
  }

  const cleaned = text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return [...new Set(cleaned)];
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeVariant(variant: RawVariant): NormalizedVariant {
  const normalized: NormalizedVariant = {};

  const id = asString(variant.id);
  if (id) {
    normalized.id = id;
  }

  const title = asString(variant.title);
  if (title) {
    normalized.title = title;
  }

  const sku = asString(variant.sku);
  if (sku) {
    normalized.sku = sku;
  }

  const price = toIntegerCents(variant.price);
  if (price !== undefined) {
    normalized.price_cents = price;
  }

  const compareAt = toIntegerCents(variant.compare_at_price);
  if (compareAt !== undefined) {
    normalized.compare_at_cents = compareAt;
  }

  const currency = asString(variant.currency);
  if (currency) {
    normalized.currency = currency.toUpperCase();
  }

  const available = toAvailabilityBoolean(variant.available);
  if (available !== undefined) {
    normalized.available = available;
  }

  const explicitOptions: Record<string, string> = {};
  if (variant.options) {
    for (const [key, value] of Object.entries(variant.options)) {
      const optionKey = titleCase(String(key).trim());
      const optionValue = String(value).trim();
      if (optionKey && optionValue) {
        explicitOptions[optionKey] = optionValue;
      }
    }
  }

  const positional = [variant.option1, variant.option2, variant.option3]
    .map((value) => asString(value))
    .filter((value): value is string => value !== undefined);
  if (Object.keys(explicitOptions).length === 0 && positional.length > 0) {
    positional.forEach((value, index) => {
      explicitOptions[`Option ${index + 1}`] = value;
    });
  }
  if (Object.keys(explicitOptions).length > 0) {
    normalized.options = explicitOptions;
  }

  return normalized;
}

function deriveHandle(raw: RawProduct, fallbackUrl: string): string {
  const explicitHandle = asString(raw.handle);
  if (explicitHandle) {
    return slugifyText(explicitHandle);
  }

  const normalizedUrl = normalizeUrl(asString(raw.url) ?? fallbackUrl, fallbackUrl);
  if (normalizedUrl) {
    const pathParts = new URL(normalizedUrl).pathname.split("/").filter(Boolean);
    const candidate = pathParts.at(-1);
    if (candidate) {
      return slugifyText(candidate);
    }
  }

  const title = asString(raw.title);
  if (title) {
    const titleHandle = slugifyText(title);
    if (titleHandle.length > 0) {
      return titleHandle;
    }
  }

  return "product";
}

function deriveProductId(raw: RawProduct, handle: string, normalizedUrl: string): string {
  const explicitId = asString(raw.id);
  if (explicitId) {
    return explicitId;
  }

  const digest = createHash("sha1").update(`${handle}|${normalizedUrl}`).digest("hex").slice(0, 12);
  return `${handle}-${digest}`;
}

function compactOptionalFields<T extends Record<string, unknown>>(input: T): T {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) {
      continue;
    }
    output[key] = value;
  }

  return output as T;
}

export function normalizeRawProduct(rawInput: RawProduct, storeSlug: string, storeUrl: string): NormalizedProduct | null {
  const parsed = RawProductSchema.safeParse(rawInput);
  if (!parsed.success) {
    return null;
  }

  const raw = parsed.data;
  const title = asString(raw.title);
  if (!title) {
    return null;
  }

  const normalizedUrl = normalizeUrl(asString(raw.url) ?? storeUrl, storeUrl);
  if (!normalizedUrl) {
    return null;
  }

  const handle = deriveHandle(raw, normalizedUrl);
  const productId = deriveProductId(raw, handle, normalizedUrl);

  const variants = (raw.variants ?? []).map(normalizeVariant);
  const variantPrices = variants
    .map((variant) => variant.price_cents)
    .filter((value): value is number => value !== undefined);
  const fallbackPrice = toIntegerCents(raw.price);
  const priceMin = variantPrices.length > 0 ? Math.min(...variantPrices) : fallbackPrice;
  const priceMax = variantPrices.length > 0 ? Math.max(...variantPrices) : fallbackPrice;

  const currency =
    asString(raw.currency)?.toUpperCase() ?? variants.find((variant) => variant.currency !== undefined)?.currency;

  let available = toAvailabilityBoolean(raw.availability);
  if (available === undefined) {
    const variantFlags = variants
      .map((variant) => variant.available)
      .filter((value): value is boolean => value !== undefined);

    if (variantFlags.length > 0) {
      available = variantFlags.some(Boolean);
    }
  }

  if (available === undefined) {
    available = true;
  }

  const description = asString(raw.description);
  const brand = asString(raw.brand);
  const vendor = asString(raw.vendor) ?? brand;
  const productType = asString(raw.product_type);
  const rawImageUrl = asString(raw.image_url);
  const imageUrl = rawImageUrl ? normalizeUrl(rawImageUrl, normalizedUrl) ?? undefined : undefined;
  const tags = parseTags(raw.tags);

  const options =
    raw.options
      ?.map((option) => ({
        name: option.name.trim(),
        values: option.values.map((value) => value.trim()).filter((value) => value.length > 0)
      }))
      .filter((option) => option.name.length > 0) ?? [];

  const searchText = [title, handle, description, brand, vendor, productType, tags.join(" ")]
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry))
    .join(" ")
    .trim();

  const normalized: NormalizedProduct = {
    store_slug: storeSlug,
    product_id: productId,
    title,
    handle,
    url: normalizedUrl,
    tags,
    search_text: searchText.length > 0 ? searchText : title,
    available,
    source: raw.source ?? "html",
    ...(priceMin !== undefined ? { price_min: priceMin } : {}),
    ...(priceMax !== undefined ? { price_max: priceMax } : {}),
    ...(currency ? { currency } : {}),
    ...(description ? { description } : {}),
    ...(brand ? { brand } : {}),
    ...(vendor ? { vendor } : {}),
    ...(productType ? { product_type: productType } : {}),
    ...(imageUrl ? { image_url: imageUrl } : {}),
    ...(variants.length > 0 ? { variants } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(asString(raw.etag) ? { etag: asString(raw.etag) } : {}),
    ...(asString(raw.last_modified) ? { last_modified: asString(raw.last_modified) } : {})
  };

  const compacted = compactOptionalFields(normalized);
  const result = NormalizedProductSchema.safeParse(compacted);
  return result.success ? compactOptionalFields(result.data) : null;
}
