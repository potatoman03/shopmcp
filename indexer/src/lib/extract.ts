import { load } from "cheerio";
import { RawProduct, RawProductSchema, RawVariant } from "../types";
import { normalizeUrl } from "./url";

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
}

function isLikelyProductPageUrl(pageUrl: string): boolean {
  const normalized = normalizeUrl(pageUrl) ?? pageUrl;
  const lower = normalized.toLowerCase();
  return lower.includes("/products/") || lower.includes("/product/") || lower.includes("variant=");
}

function isLikelyCollectionUrl(pageUrl: string): boolean {
  const normalized = normalizeUrl(pageUrl) ?? pageUrl;
  return normalized.toLowerCase().includes("/collections/");
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => asText(entry))
      .filter((entry): entry is string => entry !== undefined);
  }

  const text = asText(value);
  if (!text) {
    return [];
  }

  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function typeMatches(node: Record<string, unknown>, expected: string): boolean {
  const typeField = node["@type"];
  const values = asArray(typeField);

  return values.some((value) => {
    const text = asText(value)?.toLowerCase();
    return text === expected;
  });
}

function extractOfferVariants(offers: unknown): RawVariant[] {
  const normalizedOffers: RawVariant[] = [];

  const flattenOfferNode = (offerNode: unknown): void => {
    const offer = asObject(offerNode);
    if (!offer) {
      return;
    }

    if (typeMatches(offer, "aggregateoffer") && offer.offers !== undefined) {
      for (const nested of asArray(offer.offers)) {
        flattenOfferNode(nested);
      }
      return;
    }

    normalizedOffers.push({
      id: asText(offer["@id"]) ?? asText(offer.sku),
      title: asText(offer.name),
      sku: asText(offer.sku),
      price: asText(offer.price),
      compare_at_price: asText(offer.highPrice),
      currency: asText(offer.priceCurrency),
      available: asText(offer.availability) ?? asText(offer.inventoryLevel)
    });
  };

  for (const offerNode of asArray(offers)) {
    flattenOfferNode(offerNode);
  }

  return normalizedOffers;
}

function productFromJsonLdNode(node: Record<string, unknown>, pageUrl: string): RawProduct | null {
  const productUrl = normalizeUrl(asText(node.url) ?? asText(node["@id"]) ?? pageUrl, pageUrl);
  const imageNode = asArray(node.image)[0];
  const imageUrl = normalizeUrl(asText(imageNode) ?? "", pageUrl) ?? undefined;
  const brandNode = asObject(node.brand);
  const variants = extractOfferVariants(node.offers);

  const product: RawProduct = {
    id: asText(node.productID) ?? asText(node.sku) ?? asText(node["@id"]),
    url: productUrl ?? undefined,
    title: asText(node.name),
    handle: productUrl ? new URL(productUrl).pathname.split("/").filter(Boolean).at(-1) : undefined,
    description: asText(node.description),
    brand: asText(brandNode?.name) ?? asText(node.brand),
    image_url: imageUrl,
    tags: parseTags(node.category),
    price: variants[0]?.price,
    currency: variants[0]?.currency,
    availability: variants[0]?.available,
    variants,
    source: "html"
  };

  const parsed = RawProductSchema.safeParse(product);
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

function collectJsonLdProducts(value: unknown, pageUrl: string, collector: RawProduct[]): void {
  const node = asObject(value);
  if (!node) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectJsonLdProducts(entry, pageUrl, collector);
    }
    return;
  }

  if (Array.isArray(node["@graph"])) {
    for (const graphNode of node["@graph"]) {
      collectJsonLdProducts(graphNode, pageUrl, collector);
    }
  }

  if (typeMatches(node, "product")) {
    const mapped = productFromJsonLdNode(node, pageUrl);
    if (mapped) {
      collector.push(mapped);
    }
    return;
  }

  if (typeMatches(node, "itemlist")) {
    for (const item of asArray(node.itemListElement)) {
      const itemNode = asObject(item);
      if (!itemNode) {
        continue;
      }
      collectJsonLdProducts(itemNode.item ?? itemNode, pageUrl, collector);
    }
  }
}

function extractJsonLdProducts(html: string, pageUrl: string): RawProduct[] {
  const $ = load(html);
  const products: RawProduct[] = [];

  $("script[type='application/ld+json']").each((_, element) => {
    const rawJson = $(element).contents().text().trim();
    if (!rawJson) {
      return;
    }

    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          collectJsonLdProducts(entry, pageUrl, products);
        }
      } else {
        collectJsonLdProducts(parsed, pageUrl, products);
      }
    } catch {
      // Ignore invalid JSON-LD blocks.
    }
  });

  return products;
}

function extractFallbackProduct(html: string, pageUrl: string): RawProduct | null {
  if (!isLikelyProductPageUrl(pageUrl)) {
    return null;
  }

  const $ = load(html);

  const title =
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("h1[itemprop='name']").first().text().trim() ||
    $("h1").first().text().trim();

  if (!title) {
    return null;
  }
  const lowerTitle = title.toLowerCase();
  if (lowerTitle.includes("404") || lowerTitle.includes("not found")) {
    return null;
  }

  const price =
    $("meta[property='product:price:amount']").attr("content")?.trim() ||
    $("[itemprop='price']").first().attr("content")?.trim() ||
    $("[itemprop='price']").first().text().trim() ||
    $(".price").first().text().trim() ||
    undefined;

  const availability =
    $("meta[property='product:availability']").attr("content")?.trim() ||
    $("link[itemprop='availability']").attr("href")?.trim() ||
    $("[data-availability]").attr("data-availability")?.trim() ||
    undefined;

  const fallback: RawProduct = {
    id: $("meta[property='product:retailer_item_id']").attr("content")?.trim() || undefined,
    url: normalizeUrl(pageUrl) ?? undefined,
    title,
    handle: (() => {
      const normalized = normalizeUrl(pageUrl);
      if (!normalized) {
        return undefined;
      }
      return new URL(normalized).pathname.split("/").filter(Boolean).at(-1);
    })(),
    description:
      $("meta[name='description']").attr("content")?.trim() ||
      $("[itemprop='description']").first().text().trim() ||
      undefined,
    brand:
      $("meta[property='product:brand']").attr("content")?.trim() ||
      $("[itemprop='brand']").first().text().trim() ||
      undefined,
    image_url: normalizeUrl($("meta[property='og:image']").attr("content")?.trim() || "", pageUrl) ?? undefined,
    tags: parseTags($("meta[name='keywords']").attr("content")),
    price,
    availability,
    source: "html"
  };

  const parsed = RawProductSchema.safeParse(fallback);
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

export function extractProductsFromHtml(html: string, pageUrl: string): RawProduct[] {
  const discovered = new Map<string, RawProduct>();
  const jsonLdProducts = extractJsonLdProducts(html, pageUrl);

  for (const product of jsonLdProducts) {
    const key =
      (typeof product.id === "string" || typeof product.id === "number"
        ? String(product.id)
        : undefined) ?? `${product.url ?? ""}|${product.title ?? ""}`;
    discovered.set(key, product);
  }

  if (discovered.size === 0) {
    const fallback = extractFallbackProduct(html, pageUrl);
    if (fallback) {
      const key =
        (typeof fallback.id === "string" || typeof fallback.id === "number"
          ? String(fallback.id)
          : undefined) ?? `${fallback.url ?? ""}|${fallback.title ?? ""}`;
      discovered.set(key, fallback);
    }
  }

  return [...discovered.values()];
}

export function extractDiscoveryLinksFromHtml(
  html: string,
  pageUrl: string
): { product_urls: string[]; collection_urls: string[] } {
  const $ = load(html);
  const productUrls = new Set<string>();
  const collectionUrls = new Set<string>();

  let baseHost = "";
  try {
    baseHost = new URL(normalizeUrl(pageUrl) ?? pageUrl).hostname.toLowerCase();
  } catch {
    baseHost = "";
  }

  const collectUrl = (candidate: string): void => {
    const normalized = normalizeUrl(candidate, pageUrl);
    if (!normalized) {
      return;
    }
    if (baseHost) {
      try {
        if (new URL(normalized).hostname.toLowerCase() !== baseHost) {
          return;
        }
      } catch {
        return;
      }
    }
    if (isLikelyProductPageUrl(normalized)) {
      productUrls.add(normalized);
      return;
    }
    if (isLikelyCollectionUrl(normalized)) {
      collectionUrls.add(normalized);
    }
  };

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (typeof href !== "string" || href.trim().length === 0) {
      return;
    }
    collectUrl(href.trim());
  });

  for (const match of html.matchAll(/["'](\/[^"']*\/products?\/[^"']+)["']/gi)) {
    const candidate = match[1]?.replace(/&amp;/gi, "&");
    if (candidate) {
      collectUrl(candidate);
    }
  }
  for (const match of html.matchAll(/["'](\/[^"']*\/collections\/[^"']+)["']/gi)) {
    const candidate = match[1]?.replace(/&amp;/gi, "&");
    if (candidate) {
      collectUrl(candidate);
    }
  }

  return {
    product_urls: [...productUrls],
    collection_urls: [...collectionUrls]
  };
}
