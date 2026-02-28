import { AppConfig } from "../config";
import { Database, toStoreStatus } from "../lib/db";
import { EmbeddingService } from "../lib/embedder";
import { ExternalDiscoveryPlugin } from "../lib/exa";
import { extractDiscoveryLinksFromHtml, extractProductsFromHtml } from "../lib/extract";
import { fetchWithTimeout, FetchRuntimeConfig } from "../lib/http";
import { normalizeRawProduct } from "../lib/normalize";
import { detectPlatform, Platform } from "../lib/platform";
import { collectSitemapUrls, extractSitemapUrlsFromRobots, fallbackSitemapUrls } from "../lib/sitemap";
import { slugifyStore } from "../lib/slugify";
import { StatusMetrics, StatusRegistry, StoreStatus } from "../lib/status";
import { normalizeUrl, prioritizeUrls } from "../lib/url";
import { NormalizedProduct, RawProduct } from "../types";
import { Logger } from "../lib/logger";

interface StartIndexArgs {
  storeUrl: string;
  storeName: string;
  slug?: string;
  force?: boolean;
  mode?: "index" | "refresh";
}

interface ShopifyProductsResponse {
  products?: unknown[];
}

interface ProductLogEntry {
  title: string;
  handle: string;
  category: string;
  price_min?: number;
  price_max?: number;
  available: boolean;
  variant_count: number;
  source: string;
  url: string;
  exa_matched: boolean;
}

type DiscoveredSource = "sitemap" | "shopify_json" | "external" | "html_link";
type DuplicateCountItem = { value: string; count: number };
type CollectionDiscoveryResult = {
  product_urls: string[];
  visited_collection_pages: number;
  seeded_collection_urls: number;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

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

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const text = asString(value)?.toLowerCase();
  if (!text) {
    return undefined;
  }
  if (["true", "1", "yes", "in stock", "instock", "available"].includes(text)) {
    return true;
  }
  if (["false", "0", "no", "out of stock", "outofstock", "sold out", "soldout", "unavailable"].includes(text)) {
    return false;
  }
  return undefined;
}

function dedupeStrings(values: string[]): string[] {
  const unique = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || unique.has(trimmed)) {
      continue;
    }
    unique.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

function parseShopifyTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return dedupeStrings(
      value.map((entry) => asString(entry)).filter((entry): entry is string => entry !== undefined)
    );
  }

  const text = asString(value);
  if (!text) {
    return [];
  }
  return dedupeStrings(text.split(","));
}

function toPlainText(html: string | undefined): string | undefined {
  if (!html) {
    return undefined;
  }

  const plain = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 0 ? plain : undefined;
}

function isLikelyProductUrl(url: string): boolean {
  const text = url.toLowerCase();
  return (
    text.includes("/products/") ||
    text.includes("/product/") ||
    text.includes("?variant=")
  );
}

function sourcePriority(source: DiscoveredSource): number {
  switch (source) {
    case "external":
      return 4;
    case "shopify_json":
      return 3;
    case "html_link":
      return 2;
    default:
      return 1;
  }
}

function duplicateKeyCount(counts: Map<string, number>): number {
  let duplicates = 0;
  for (const count of counts.values()) {
    if (count > 1) {
      duplicates += 1;
    }
  }
  return duplicates;
}

function topDuplicateCounts(counts: Map<string, number>, limit = 25): DuplicateCountItem[] {
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let index = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function mergeProduct(existing: NormalizedProduct | undefined, incoming: NormalizedProduct): NormalizedProduct {
  if (!existing) {
    return incoming;
  }
  const score = (product: NormalizedProduct): number => {
    let value = 0;
    if (product.price_min !== undefined || product.price_max !== undefined) {
      value += 1;
    }
    if (product.description) {
      value += 1;
    }
    if (product.image_url) {
      value += 1;
    }
    if (product.variants && product.variants.length > 0) {
      value += 1;
    }
    if (product.source === "shopify_json") {
      value += 2;
    }
    return value;
  };
  return score(incoming) >= score(existing) ? incoming : existing;
}

function toProductMapKey(product: NormalizedProduct): string {
  const productId = product.product_id.trim();
  if (productId.length > 0) {
    return `id:${productId.toLowerCase()}`;
  }
  const handle = product.handle.trim().toLowerCase();
  if (handle.length > 0) {
    return `handle:${handle}`;
  }
  return `url:${(normalizeUrl(product.url) ?? product.url).toLowerCase()}`;
}

function isCatalogProduct(product: NormalizedProduct): boolean {
  const normalizedUrl = (normalizeUrl(product.url) ?? product.url).toLowerCase();
  const hasProductPath = normalizedUrl.includes("/products/") || normalizedUrl.includes("/product/");
  const hasVariants = (product.variants?.length ?? 0) > 0;
  const hasPrice = product.price_min !== undefined || product.price_max !== undefined;
  return hasProductPath || hasVariants || hasPrice;
}

function buildProductLogEntry(product: NormalizedProduct, exaDiscoveredUrls: Set<string>): ProductLogEntry {
  const normalizedUrl = normalizeUrl(product.url) ?? product.url;
  return {
    title: product.title,
    handle: product.handle,
    category: product.product_type ?? "uncategorized",
    ...(product.price_min !== undefined ? { price_min: product.price_min } : {}),
    ...(product.price_max !== undefined ? { price_max: product.price_max } : {}),
    available: product.available,
    variant_count: product.variants?.length ?? 0,
    source: product.source,
    url: product.url,
    exa_matched: exaDiscoveredUrls.has(normalizedUrl)
  };
}

export class IndexerService {
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly runtimeConfig: FetchRuntimeConfig;
  private readonly logger: Logger;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
    private readonly embedder: EmbeddingService,
    private readonly statuses: StatusRegistry,
    private readonly discoveryPlugin: ExternalDiscoveryPlugin | null
  ) {
    this.runtimeConfig = {
      timeoutMs: config.REQUEST_TIMEOUT_MS,
      userAgent: config.USER_AGENT,
      readerProxyEnabled: config.READER_PROXY_ENABLED,
      readerProxyBaseUrl: config.READER_PROXY_BASE_URL
    };
    this.logger = new Logger("indexer.pipeline", config.LOG_LEVEL);
  }

  async getStatus(slug: string): Promise<StoreStatus | undefined> {
    const inMemory = this.statuses.get(slug);
    if (inMemory) {
      return inMemory;
    }
    const stored = await this.db.getStoredStatus(slug);
    return stored ? toStoreStatus(stored) : undefined;
  }

  async listStores(limit: number, offset: number): Promise<{
    total: number;
    stores: Array<{
      slug: string;
      store_name: string;
      store_url: string;
      platform: Platform;
      product_count: number;
      status: "queued" | "running" | "completed" | "failed";
      metrics: StatusMetrics;
      indexed_at?: string;
      created_at?: string;
      updated_at?: string;
      run_started_at?: string;
      run_finished_at?: string;
      last_error?: string;
    }>;
  }> {
    return this.db.listStores(limit, offset);
  }

  async listIndexedProducts(slug: string, limit: number, offset: number): Promise<{
    status: StoreStatus | undefined;
    products: { title: string; price?: number; description?: string; url: string }[];
  }> {
    const status = await this.getStatus(slug);
    if (!status) {
      return { status: undefined, products: [] };
    }
    const products = await this.db.listIndexedProducts(slug, limit, offset);
    return { status, products };
  }

  async getIndexedProductManifest(
    slug: string,
    limit: number,
    offset: number
  ): Promise<{
    status: StoreStatus | undefined;
    products: Array<{
      title: string;
      handle: string;
      category: string;
      price_min?: number;
      price_max?: number;
      available: boolean;
      variant_count: number;
      variants?: Array<{
        id?: string;
        title?: string;
        sku?: string;
        price_cents?: number;
        compare_at_cents?: number;
        currency?: string;
        available?: boolean;
        options?: Record<string, string>;
      }>;
      source: string;
      url: string;
      description?: string;
      exa_matched: boolean;
    }>;
    summary: {
      indexed_products: number;
      available_products: number;
      unavailable_products: number;
      total_variants: number;
      avg_variants_per_product: number;
      categories: Record<string, number>;
      sources: Record<string, number>;
      exa_discovered_urls: number;
      exa_matched_urls: number;
      exa_unmatched_urls: number;
    };
    exa: {
      matched_urls: string[];
      unmatched_urls: string[];
      discovered_urls: string[];
    };
  }> {
    const status = await this.getStatus(slug);
    if (!status) {
      return {
        status: undefined,
        products: [],
        summary: {
          indexed_products: 0,
          available_products: 0,
          unavailable_products: 0,
          total_variants: 0,
          avg_variants_per_product: 0,
          categories: {},
          sources: {},
          exa_discovered_urls: 0,
          exa_matched_urls: 0,
          exa_unmatched_urls: 0
        },
        exa: {
          matched_urls: [],
          unmatched_urls: [],
          discovered_urls: []
        }
      };
    }

    const manifestRows = await this.db.listIndexedProductManifest(slug, limit, offset);
    const exaDiscoveredUrls = await this.db.listExternalDiscoveredUrls(slug);
    const normalizedExaDiscoveredUrls = [...new Set(
      exaDiscoveredUrls
        .map((url) => normalizeUrl(url))
        .filter((value): value is string => value !== null)
    )];
    const exaDiscoveredSet = new Set(normalizedExaDiscoveredUrls);

    const products = manifestRows.map((row) => ({
      ...row,
      exa_matched: exaDiscoveredSet.has(normalizeUrl(row.url) ?? row.url)
    }));

    const categories: Record<string, number> = {};
    const sources: Record<string, number> = {};
    let availableProducts = 0;
    let unavailableProducts = 0;
    let totalVariants = 0;
    for (const row of products) {
      categories[row.category] = (categories[row.category] ?? 0) + 1;
      sources[row.source] = (sources[row.source] ?? 0) + 1;
      totalVariants += row.variant_count;
      if (row.available) {
        availableProducts += 1;
      } else {
        unavailableProducts += 1;
      }
    }

    const productUrlSet = new Set(products.map((product) => normalizeUrl(product.url) ?? product.url));
    const exaMatchedUrls = normalizedExaDiscoveredUrls.filter((url) => productUrlSet.has(url));
    const exaUnmatchedUrls = normalizedExaDiscoveredUrls.filter((url) => !productUrlSet.has(url));

    return {
      status,
      products,
      summary: {
        indexed_products: products.length,
        available_products: availableProducts,
        unavailable_products: unavailableProducts,
        total_variants: totalVariants,
        avg_variants_per_product:
          products.length > 0 ? Number((totalVariants / products.length).toFixed(2)) : 0,
        categories,
        sources,
        exa_discovered_urls: normalizedExaDiscoveredUrls.length,
        exa_matched_urls: exaMatchedUrls.length,
        exa_unmatched_urls: exaUnmatchedUrls.length
      },
      exa: {
        matched_urls: exaMatchedUrls,
        unmatched_urls: exaUnmatchedUrls,
        discovered_urls: normalizedExaDiscoveredUrls
      }
    };
  }

  async health(): Promise<{ ok: boolean; db: boolean; embeddings: "enabled" | "disabled" }> {
    const dbHealthy = await this.db.healthcheck();
    return { ok: dbHealthy, db: dbHealthy, embeddings: this.embedder.isEnabled() ? "enabled" : "disabled" };
  }

  async startIndex({ storeUrl, storeName, slug, force = false, mode = "index" }: StartIndexArgs): Promise<StoreStatus> {
    const normalizedStoreUrl = this.normalizeStoreUrl(storeUrl);
    const resolvedStoreName = storeName.trim() || slug || normalizedStoreUrl;
    const resolvedSlug =
      slug && slug.length > 0 ? slugifyStore(slug) : slugifyStore(resolvedStoreName || normalizedStoreUrl);

    if (this.activeRuns.has(resolvedSlug)) {
      this.logger.warn("run_rejected_active", { slug: resolvedSlug });
      throw new Error(`index run already in progress for ${resolvedSlug}`);
    }

    this.statuses.registerStore(resolvedSlug, normalizedStoreUrl, resolvedStoreName);
    this.statuses.markQueued(resolvedSlug, normalizedStoreUrl, resolvedStoreName);
    await this.db.upsertStore(resolvedSlug, resolvedStoreName, normalizedStoreUrl, "unknown");
    this.logger.info("run_queued", {
      slug: resolvedSlug,
      store_name: resolvedStoreName,
      store_url: normalizedStoreUrl,
      mode,
      force
    });

    const runPromise = this.runIndex(resolvedSlug, resolvedStoreName, normalizedStoreUrl, force, mode).finally(() => {
      this.activeRuns.delete(resolvedSlug);
    });
    this.activeRuns.set(resolvedSlug, runPromise);
    void runPromise;

    const status = this.statuses.get(resolvedSlug);
    if (!status) {
      throw new Error("failed to initialize status");
    }
    return status;
  }

  async refresh(slug: string, force = false): Promise<StoreStatus> {
    const inMemoryStore = this.statuses.getStore(slug);
    if (inMemoryStore) {
      return this.startIndex({
        slug,
        storeUrl: inMemoryStore.url,
        storeName: inMemoryStore.storeName,
        force,
        mode: "refresh"
      });
    }

    const stored = await this.db.getStore(slug);
    if (!stored) {
      throw new Error(`unknown slug ${slug}`);
    }
    return this.startIndex({
      slug,
      storeUrl: stored.url,
      storeName: stored.store_name,
      force,
      mode: "refresh"
    });
  }

  private normalizeStoreUrl(input: string): string {
    const trimmed = input.trim();
    const prefixed = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const normalized = normalizeUrl(prefixed);
    if (!normalized) {
      throw new Error("invalid store URL");
    }
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  }

  private async runIndex(
    slug: string,
    storeName: string,
    storeUrl: string,
    force: boolean,
    mode: "index" | "refresh"
  ): Promise<void> {
    const startedAt = Date.now();
    const metrics: StatusMetrics = {
      discovered_urls: 0,
      crawled_urls: 0,
      sitemap_urls: 0,
      skipped_unchanged: 0
    };

    let crawlRunId: number | null = null;
    let platform: Platform = "unknown";
    let progressLogs = 0;

    this.statuses.markRunning(slug);
    this.logger.info("run_started", { slug, store_name: storeName, store_url: storeUrl, mode, force });

    try {
      platform = await detectPlatform(storeUrl, async (url) => {
        try {
          const response = await fetchWithTimeout(url, { method: "GET", redirect: "follow" }, this.runtimeConfig);
          if (!response.ok) {
            return null;
          }
          return await response.text();
        } catch {
          return null;
        }
      });

      this.statuses.setPlatform(slug, platform);
      await this.db.upsertStore(slug, storeName, storeUrl, platform);
      crawlRunId = await this.db.createCrawlRun(slug, mode);
      this.logger.info("platform_detected", { slug, platform, crawl_run_id: crawlRunId });

      const seedSitemaps = await this.discoverSeedSitemaps(storeUrl);
      const sitemapResult = await collectSitemapUrls({
        seedSitemaps,
        baseUrl: storeUrl,
        fetchSitemap: async (sitemapUrl) => {
          try {
            const response = await fetchWithTimeout(
              sitemapUrl,
              { method: "GET", redirect: "follow", headers: { accept: "application/xml,text/xml,*/*" } },
              this.runtimeConfig
            );
            if (!response.ok) {
              this.logger.debug("sitemap_fetch_http_error", {
                slug,
                sitemap_url: sitemapUrl,
                status: response.status,
                cf_mitigated: response.headers.get("cf-mitigated") ?? undefined
              });
              return null;
            }
            const body = await response.arrayBuffer();
            return Buffer.from(body);
          } catch {
            return null;
          }
        }
      });

      metrics.sitemap_urls = sitemapResult.sitemapUrls;
      this.logger.info("sitemap_discovery_completed", {
        slug,
        sitemap_urls: sitemapResult.sitemapUrls,
        visited_sitemaps: sitemapResult.visitedSitemaps
      });

      const externalUrls = this.discoveryPlugin ? await this.discoveryPlugin.discoverProductUrls(storeUrl) : [];
      const shopifyProducts = await this.fetchShopifyProducts(storeUrl, platform);
      const collectionDiscovery =
        platform === "shopify" && shopifyProducts.length === 0
          ? await this.discoverShopifyCollectionProductUrls(storeUrl, sitemapResult.urls)
          : {
              product_urls: [] as string[],
              visited_collection_pages: 0,
              seeded_collection_urls: 0
            };
      const normalizedExternalUrls = externalUrls
        .map((url) => normalizeUrl(url, storeUrl))
        .filter((value): value is string => value !== null);
      const normalizedCollectionProductUrls = collectionDiscovery.product_urls
        .map((url) => normalizeUrl(url, storeUrl))
        .filter((value): value is string => value !== null);
      const externalUrlSet = new Set(normalizedExternalUrls);
      this.logger.info("exa_discovery_results", {
        slug,
        exa_discovered_urls: normalizedExternalUrls.length,
        exa_urls: normalizedExternalUrls
      });
      this.logger.info("shopify_collection_discovery_results", {
        slug,
        discovered_product_urls: normalizedCollectionProductUrls.length,
        visited_collection_pages: collectionDiscovery.visited_collection_pages,
        seeded_collection_urls: collectionDiscovery.seeded_collection_urls
      });
      this.logger.info("source_discovery_completed", {
        slug,
        external_urls: normalizedExternalUrls.length,
        shopify_products: shopifyProducts.length,
        collection_product_urls: normalizedCollectionProductUrls.length
      });
      const shopifyUrls = shopifyProducts
        .map((product) => asString(product.url))
        .filter((value): value is string => value !== undefined)
        .map((url) => normalizeUrl(url, storeUrl))
        .filter((value): value is string => value !== null);

      const discoveredEntries = new Map<
        string,
        { url: string; source: DiscoveredSource; is_candidate_product: boolean }
      >();
      const upsertDiscoveredEntry = (incoming: {
        url: string;
        source: DiscoveredSource;
        is_candidate_product: boolean;
      }): void => {
        const existing = discoveredEntries.get(incoming.url);
        if (!existing) {
          discoveredEntries.set(incoming.url, incoming);
          return;
        }
        discoveredEntries.set(incoming.url, {
          url: existing.url,
          source:
            sourcePriority(incoming.source) > sourcePriority(existing.source)
              ? incoming.source
              : existing.source,
          is_candidate_product: existing.is_candidate_product || incoming.is_candidate_product
        });
      };

      for (const url of sitemapResult.urls) {
        upsertDiscoveredEntry({
          url,
          source: "sitemap",
          is_candidate_product: isLikelyProductUrl(url)
        });
      }
      for (const normalized of normalizedExternalUrls) {
        upsertDiscoveredEntry({
          url: normalized,
          source: "external",
          is_candidate_product: true
        });
      }
      for (const normalized of normalizedCollectionProductUrls) {
        upsertDiscoveredEntry({
          url: normalized,
          source: "html_link",
          is_candidate_product: true
        });
      }
      for (const url of shopifyUrls) {
        upsertDiscoveredEntry({
          url,
          source: "shopify_json",
          is_candidate_product: true
        });
      }

      metrics.discovered_urls = discoveredEntries.size;
      if (metrics.discovered_urls === 0 && shopifyProducts.length === 0) {
        this.logger.warn("source_discovery_empty", {
          slug,
          store_url: storeUrl,
          platform,
          hint: "likely blocked by anti-bot challenge or empty catalog"
        });
      }
      this.statuses.updateMetrics(slug, metrics);
      this.logger.info("url_discovery_completed", {
        slug,
        discovered_urls: metrics.discovered_urls
      });

      const prioritizedTargets = prioritizeUrls([...discoveredEntries.keys()]);
      const productTargets = prioritizedTargets.filter((url) => isLikelyProductUrl(url));
      const fallbackTargets = prioritizedTargets.filter((url) => !isLikelyProductUrl(url));
      const largeStoreMode =
        metrics.discovered_urls >= this.config.LARGE_STORE_URL_THRESHOLD && shopifyProducts.length === 0;
      const shopifyNoFeedMode =
        platform === "shopify" && shopifyProducts.length === 0 && productTargets.length > 0;
      const effectiveCrawlMaxUrls = largeStoreMode
        ? Math.min(this.config.CRAWL_MAX_URLS, this.config.LARGE_STORE_CRAWL_MAX_URLS)
        : this.config.CRAWL_MAX_URLS;
      const effectiveCrawlConcurrency = largeStoreMode
        ? Math.max(this.config.CRAWL_CONCURRENCY, this.config.LARGE_STORE_CRAWL_CONCURRENCY)
        : shopifyNoFeedMode
          ? Math.max(this.config.CRAWL_CONCURRENCY, this.config.SHOPIFY_NO_FEED_CRAWL_CONCURRENCY)
          : this.config.CRAWL_CONCURRENCY;
      const preferProductOnlyTargets =
        platform === "shopify" && shopifyProducts.length === 0 && productTargets.length > 0;
      const crawlTargets = (
        preferProductOnlyTargets ? productTargets : [...productTargets, ...fallbackTargets]
      ).slice(0, effectiveCrawlMaxUrls);
      this.logger.info("crawl_targets_prepared", {
        slug,
        large_store_mode: largeStoreMode,
        prefer_product_only_targets: preferProductOnlyTargets,
        discovered_product_like_urls: productTargets.length,
        discovered_non_product_urls: fallbackTargets.length,
        crawl_targets: crawlTargets.length,
        crawl_max_urls: effectiveCrawlMaxUrls,
        crawl_concurrency: effectiveCrawlConcurrency
      });
      await this.db.upsertCrawlUrls(
        slug,
        crawlRunId,
        crawlTargets.map((url) => ({
          url,
          url_norm: url,
          source: discoveredEntries.get(url)?.source ?? "sitemap",
          is_candidate_product: discoveredEntries.get(url)?.is_candidate_product ?? false
        })),
        this.config.CRAWL_URL_UPSERT_BATCH_SIZE
      );

      const fetchState = force ? new Map() : await this.db.getFetchState(slug, crawlTargets);
      this.logger.debug("fetch_state_loaded", { slug, prior_state_entries: fetchState.size });
      const productMap = new Map<string, NormalizedProduct>();
      const dedupCounts = {
        rawCandidates: 0,
        key: new Map<string, number>(),
        handle: new Map<string, number>(),
        productId: new Map<string, number>(),
        url: new Map<string, number>(),
        handleProductIds: new Map<string, Set<string>>()
      };
      const incrementCount = (counts: Map<string, number>, value: string): void => {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      };
      const ingestCandidate = (product: NormalizedProduct): void => {
        dedupCounts.rawCandidates += 1;
        const key = toProductMapKey(product);
        incrementCount(dedupCounts.key, key);

        const handle = product.handle.trim().toLowerCase();
        if (handle.length > 0) {
          incrementCount(dedupCounts.handle, handle);
          const productIds = dedupCounts.handleProductIds.get(handle) ?? new Set<string>();
          if (product.product_id.trim().length > 0) {
            productIds.add(product.product_id.trim());
          }
          dedupCounts.handleProductIds.set(handle, productIds);
        }

        const productId = product.product_id.trim();
        if (productId.length > 0) {
          incrementCount(dedupCounts.productId, productId);
        }

        const normalizedProductUrl = (normalizeUrl(product.url) ?? product.url).toLowerCase();
        incrementCount(dedupCounts.url, normalizedProductUrl);

        productMap.set(key, mergeProduct(productMap.get(key), product));
      };

      for (const rawProduct of shopifyProducts) {
        const normalized = normalizeRawProduct(rawProduct, slug, storeUrl);
        if (!normalized) {
          continue;
        }
        ingestCandidate(normalized);
      }

      await mapLimit(crawlTargets, effectiveCrawlConcurrency, async (url) => {
        const requestHeaders = new Headers({ accept: "text/html,application/xhtml+xml" });
        const previousState = fetchState.get(url);

        if (previousState?.etag) {
          requestHeaders.set("if-none-match", previousState.etag);
        }
        if (previousState?.last_modified) {
          requestHeaders.set("if-modified-since", previousState.last_modified);
        }

        try {
          const response = await fetchWithTimeout(
            url,
            { method: "GET", redirect: "follow", headers: requestHeaders },
            this.runtimeConfig
          );

          metrics.crawled_urls += 1;
          if (metrics.crawled_urls % 25 === 0 && progressLogs < 20) {
            progressLogs += 1;
            this.logger.info("crawl_progress", {
              slug,
              crawled_urls: metrics.crawled_urls,
              discovered_urls: metrics.discovered_urls,
              indexed_candidates: productMap.size,
              skipped_unchanged: metrics.skipped_unchanged
            });
          }

          if (response.status === 304) {
            metrics.skipped_unchanged += 1;
            await this.db.markCrawlUrl(slug, url, "excluded", 304);
            this.statuses.updateMetrics(slug, metrics);
            return;
          }

          if (!response.ok) {
            await this.db.markCrawlUrl(slug, url, "error", response.status);
            this.logger.debug("crawl_http_error", { slug, url, status: response.status });
            this.statuses.updateMetrics(slug, metrics);
            return;
          }

          const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
          if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
            await this.db.markCrawlUrl(slug, url, "crawled", response.status);
            this.logger.debug("crawl_non_html_skipped", { slug, url, content_type: contentType });
            this.statuses.updateMetrics(slug, metrics);
            return;
          }

          const html = await response.text();
          const etag = response.headers.get("etag") ?? undefined;
          const lastModified = response.headers.get("last-modified") ?? undefined;

          let extractedCount = 0;
          for (const extracted of extractProductsFromHtml(html, url)) {
            const normalized = normalizeRawProduct(
              {
                ...extracted,
                etag,
                last_modified: lastModified,
                source: extracted.source ?? "html"
              },
              slug,
              storeUrl
            );
            if (!normalized) {
              continue;
            }
            extractedCount += 1;
            ingestCandidate(normalized);
          }

          await this.db.markCrawlUrl(slug, url, extractedCount > 0 ? "indexed" : "crawled", response.status);
          if (extractedCount > 0) {
            this.logger.debug("crawl_extracted_products", { slug, url, extracted_count: extractedCount });
          }
          this.statuses.updateMetrics(slug, metrics);
        } catch (error) {
          metrics.crawled_urls += 1;
          const message = error instanceof Error ? error.message : "crawl_failed";
          await this.db.markCrawlUrl(slug, url, "error", undefined, message);
          this.logger.warn("crawl_request_failed", { slug, url, error: message });
          this.statuses.updateMetrics(slug, metrics);
        }
      });

      const preDedupRecords = [...productMap.values()];
      const dedupByProductId = new Map<string, NormalizedProduct>();
      for (const product of preDedupRecords) {
        const productId = product.product_id.trim().toLowerCase();
        const productIdKey =
          productId.length > 0 ? `id:${productId}` : `url:${(normalizeUrl(product.url) ?? product.url).toLowerCase()}`;
        dedupByProductId.set(productIdKey, mergeProduct(dedupByProductId.get(productIdKey), product));
      }
      const dedupByHandle = new Map<string, NormalizedProduct>();
      for (const product of dedupByProductId.values()) {
        const handle = product.handle.trim().toLowerCase();
        const fallbackId = product.product_id.trim().toLowerCase();
        const fallbackUrl = (normalizeUrl(product.url) ?? product.url).toLowerCase();
        const handleKey =
          handle.length > 0 ? `handle:${handle}` : fallbackId.length > 0 ? `id:${fallbackId}` : `url:${fallbackUrl}`;
        dedupByHandle.set(handleKey, mergeProduct(dedupByHandle.get(handleKey), product));
      }
      const indexedRecords = [...dedupByHandle.values()];
      const topDuplicateHandles = topDuplicateCounts(dedupCounts.handle);
      const topDuplicateMapKeys = topDuplicateCounts(dedupCounts.key);
      const topDuplicateProductIds = topDuplicateCounts(dedupCounts.productId);
      const topDuplicateUrls = topDuplicateCounts(dedupCounts.url);
      const handleIdCollisions = [...dedupCounts.handleProductIds.entries()]
        .filter(([, productIds]) => productIds.size > 1)
        .sort((left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]))
        .slice(0, 25)
        .map(([handle, productIds]) => ({
          handle,
          product_ids: [...productIds].sort()
        }));
      const dedupSummary = {
        raw_candidate_count: dedupCounts.rawCandidates,
        unique_by_map_key_count: preDedupRecords.length,
        unique_after_key_constraint_count: indexedRecords.length,
        dedup_dropped_count: Math.max(0, dedupCounts.rawCandidates - indexedRecords.length),
        duplicate_map_key_count: duplicateKeyCount(dedupCounts.key),
        duplicate_handle_count: duplicateKeyCount(dedupCounts.handle),
        duplicate_product_id_count: duplicateKeyCount(dedupCounts.productId),
        duplicate_url_count: duplicateKeyCount(dedupCounts.url),
        handle_id_collision_count: handleIdCollisions.length
      };
      this.logger.info("non_dedup_checks_summary", { slug, ...dedupSummary });
      this.logger.info("non_dedup_checks_details", {
        slug,
        top_duplicate_map_keys: topDuplicateMapKeys,
        top_duplicate_handles: topDuplicateHandles,
        top_duplicate_product_ids: topDuplicateProductIds,
        top_duplicate_urls: topDuplicateUrls,
        handle_id_collisions: handleIdCollisions
      });
      const catalogProducts = indexedRecords
        .filter((product) => isCatalogProduct(product))
        .map((product) => ({
          ...product,
          is_catalog_product: true
        }));
      const nonProductRecords = indexedRecords
        .filter((product) => !isCatalogProduct(product))
        .map((product) => ({
          title: product.title,
          handle: product.handle,
          source: product.source,
          url: product.url
        }));

      const existingHashes =
        force || catalogProducts.length === 0
          ? new Map<string, string>()
          : await this.db.getProductHashesByHandle(
              slug,
              catalogProducts.map((product) => product.handle)
            );

      const changedProducts = catalogProducts.filter(
        (product) => force || existingHashes.get(product.handle) !== product.content_hash
      );

      const summaryStartedAt = Date.now();
      if (this.embedder.canSummarize() && changedProducts.length > 0) {
        await mapLimit(changedProducts, 4, async (product) => {
          if (product.summary_llm) {
            return;
          }
          const summary = await this.embedder.summarizeOneLine({
            title: product.title,
            productType: product.product_type,
            description: product.description,
            tags: product.tags
          });
          if (summary) {
            product.summary_llm = summary;
          }
        });
      }
      const summaryMs = Date.now() - summaryStartedAt;

      const embedStartedAt = Date.now();
      const changedEmbeddings = await this.embedder.embedMany(
        changedProducts.map((product) => product.search_text),
        this.config.EMBED_BATCH_SIZE
      );
      const embeddingByHandle = new Map<string, number[] | null>();
      changedProducts.forEach((product, index) => {
        embeddingByHandle.set(product.handle, changedEmbeddings[index] ?? null);
      });
      const embedMs = Date.now() - embedStartedAt;

      const upsertStartedAt = Date.now();
      await this.db.upsertProductsBatch(
        catalogProducts.map((product) => ({
          product,
          embedding: embeddingByHandle.get(product.handle) ?? null
        })),
        this.config.UPSERT_BATCH_SIZE
      );
      const upsertMs = Date.now() - upsertStartedAt;
      this.logger.info("catalog_indexed_ready", {
        slug,
        product_count: catalogProducts.length,
        changed_products: changedProducts.length
      });
      this.logger.info("enrichment_completed", {
        slug,
        summarized_products: changedProducts.filter((product) => Boolean(product.summary_llm)).length,
        embedded_products: changedProducts.length,
        summary_ms: summaryMs,
        embed_ms: embedMs
      });
      this.logger.info("products_upserted", {
        slug,
        ...dedupSummary,
        indexed_record_count: indexedRecords.length,
        catalog_product_count: catalogProducts.length,
        non_product_record_count: nonProductRecords.length,
        changed_products: changedProducts.length,
        unchanged_products: Math.max(0, catalogProducts.length - changedProducts.length),
        embeddings: this.embedder.isEnabled() ? "enabled" : "disabled",
        summary_llm: this.embedder.canSummarize() ? "enabled" : "disabled",
        summary_ms: summaryMs,
        embed_ms: embedMs,
        upsert_ms: upsertMs
      });

      const manifest = catalogProducts
        .map((product) => buildProductLogEntry(product, externalUrlSet))
        .sort((left, right) => left.title.localeCompare(right.title));
      const categoryBreakdown: Record<string, number> = {};
      const sourceBreakdown: Record<string, number> = {};
      let availableProducts = 0;
      let unavailableProducts = 0;
      let totalVariants = 0;
      for (const entry of manifest) {
        categoryBreakdown[entry.category] = (categoryBreakdown[entry.category] ?? 0) + 1;
        sourceBreakdown[entry.source] = (sourceBreakdown[entry.source] ?? 0) + 1;
        totalVariants += entry.variant_count;
        if (entry.available) {
          availableProducts += 1;
        } else {
          unavailableProducts += 1;
        }
      }

      const indexedProductUrlSet = new Set(
        catalogProducts
          .map((product) => normalizeUrl(product.url))
          .filter((url): url is string => url !== null)
      );
      const exaMatchedUrls = normalizedExternalUrls.filter((url) => indexedProductUrlSet.has(url));
      const exaUnmatchedUrls = normalizedExternalUrls.filter((url) => !indexedProductUrlSet.has(url));

      this.logger.info("indexed_products_manifest", {
        slug,
        product_count: manifest.length,
        products: manifest
      });
      this.logger.info("indexed_non_product_records", {
        slug,
        non_product_record_count: nonProductRecords.length,
        non_product_records: nonProductRecords
      });
      this.logger.info("indexed_products_summary", {
        slug,
        indexed_records: indexedRecords.length,
        indexed_products: manifest.length,
        available_products: availableProducts,
        unavailable_products: unavailableProducts,
        total_variants: totalVariants,
        avg_variants_per_product:
          manifest.length > 0 ? Number((totalVariants / manifest.length).toFixed(2)) : 0,
        categories: categoryBreakdown,
        sources: sourceBreakdown,
        exa_discovered_urls: normalizedExternalUrls.length,
        exa_matched_urls: exaMatchedUrls.length,
        exa_unmatched_urls: exaUnmatchedUrls.length,
        exa_matched_url_list: exaMatchedUrls,
        exa_unmatched_url_list: exaUnmatchedUrls
      });

      this.statuses.markCompleted(slug, metrics, catalogProducts.length);
      await this.db.updateStoreIndexOutcome(slug, platform, catalogProducts.length);
      await this.db.completeCrawlRun(slug, crawlRunId, "completed", metrics);
      this.logger.info("run_completed", {
        slug,
        platform,
        crawl_run_id: crawlRunId,
        duration_ms: Date.now() - startedAt,
        ...dedupSummary,
        indexed_record_count: indexedRecords.length,
        product_count: catalogProducts.length,
        non_product_record_count: nonProductRecords.length,
        metrics
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "indexing failed";
      this.statuses.markFailed(slug, metrics, message);
      await this.db.updateStoreIndexOutcome(slug, platform, 0, message);
      await this.db.completeCrawlRun(slug, crawlRunId, "failed", metrics, message);
      this.logger.error("run_failed", {
        slug,
        platform,
        crawl_run_id: crawlRunId,
        duration_ms: Date.now() - startedAt,
        metrics,
        error
      });
    }
  }

  private async discoverShopifyCollectionProductUrls(
    storeUrl: string,
    sitemapUrls: string[]
  ): Promise<CollectionDiscoveryResult> {
    const maxCollectionPages = 12;
    const maxCollectionSeeds = 16;
    const collectionSeedSet = new Set<string>();

    for (const fallback of ["/collections/all", "/collections/all?sort_by=best-selling"]) {
      const normalized = normalizeUrl(fallback, storeUrl);
      if (normalized) {
        collectionSeedSet.add(normalized);
      }
    }
    for (const url of sitemapUrls) {
      if (!url.toLowerCase().includes("/collections/")) {
        continue;
      }
      collectionSeedSet.add(url);
      if (collectionSeedSet.size >= maxCollectionSeeds) {
        break;
      }
    }

    const queue = [...collectionSeedSet];
    const visited = new Set<string>();
    const discoveredProducts = new Set<string>();
    let fetchedCollectionPages = 0;

    while (queue.length > 0 && fetchedCollectionPages < maxCollectionPages) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);

      try {
        const response = await fetchWithTimeout(
          current,
          { method: "GET", redirect: "follow", headers: { accept: "text/html,application/xhtml+xml" } },
          this.runtimeConfig
        );
        if (!response.ok) {
          continue;
        }
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
          continue;
        }

        const html = await response.text();
        fetchedCollectionPages += 1;
        const links = extractDiscoveryLinksFromHtml(html, current);
        for (const productUrl of links.product_urls) {
          discoveredProducts.add(productUrl);
        }
        for (const collectionUrl of links.collection_urls) {
          if (!visited.has(collectionUrl) && !queue.includes(collectionUrl)) {
            queue.push(collectionUrl);
          }
        }
      } catch {
        continue;
      }
    }

    return {
      product_urls: [...discoveredProducts],
      visited_collection_pages: fetchedCollectionPages,
      seeded_collection_urls: collectionSeedSet.size
    };
  }

  private async discoverSeedSitemaps(storeUrl: string): Promise<string[]> {
    const seeds = new Set<string>(fallbackSitemapUrls(storeUrl));

    const robotsUrl = new URL("/robots.txt", storeUrl).toString();
    try {
      const response = await fetchWithTimeout(
        robotsUrl,
        { method: "GET", redirect: "follow", headers: { accept: "text/plain,*/*" } },
        this.runtimeConfig
      );
      if (response.ok) {
        const robotsTxt = await response.text();
        for (const sitemapUrl of extractSitemapUrlsFromRobots(robotsTxt, storeUrl)) {
          seeds.add(sitemapUrl);
        }
        this.logger.debug("robots_processed", { store_url: storeUrl, discovered_sitemaps: seeds.size });
      } else {
        this.logger.warn("robots_fetch_http_error", {
          store_url: storeUrl,
          status: response.status,
          cf_mitigated: response.headers.get("cf-mitigated") ?? undefined
        });
      }
    } catch {
      // Keep fallback sitemap paths only.
      this.logger.warn("robots_fetch_failed", { store_url: storeUrl });
    }

    return [...seeds];
  }

  private async fetchShopifyProducts(storeUrl: string, platform: Platform): Promise<RawProduct[]> {
    const products: RawProduct[] = [];

    if (platform !== "shopify") {
      const firstBatch = await this.fetchShopifyBatch(storeUrl, 0);
      this.logger.debug("shopify_probe_completed", {
        store_url: storeUrl,
        platform,
        batch_count: firstBatch.length
      });
      return firstBatch;
    }

    let sinceId = 0;
    for (let page = 0; page < 30; page += 1) {
      const batch = await this.fetchShopifyBatch(storeUrl, sinceId);
      if (batch.length === 0) {
        break;
      }
      products.push(...batch);

      const ids = batch
        .map((product) => asString(product.id))
        .map((id) => Number.parseInt(id ?? "", 10))
        .filter((id) => Number.isFinite(id));

      const maxId = ids.length > 0 ? Math.max(...ids) : sinceId;
      if (maxId <= sinceId || batch.length < 250) {
        break;
      }
      sinceId = maxId;
    }
    this.logger.debug("shopify_sync_completed", {
      store_url: storeUrl,
      fetched_products: products.length
    });
    return products;
  }

  private async fetchShopifyBatch(storeUrl: string, sinceId: number): Promise<RawProduct[]> {
    const endpoint = new URL("/products.json", storeUrl);
    endpoint.searchParams.set("limit", "250");
    if (sinceId > 0) {
      endpoint.searchParams.set("since_id", String(sinceId));
    }

    try {
      const response = await fetchWithTimeout(
        endpoint.toString(),
        { method: "GET", redirect: "follow", headers: { accept: "application/json" } },
        this.runtimeConfig
      );
      const fetchSource = response.headers.get("x-shopmcp-fetch-source");
      if (fetchSource) {
        this.logger.info("shopify_batch_fallback_used", {
          endpoint: endpoint.toString(),
          fetch_source: fetchSource,
          fetch_proxy: response.headers.get("x-shopmcp-fetch-proxy") ?? undefined
        });
      }
      if (!response.ok) {
        this.logger.debug("shopify_batch_http_error", {
          endpoint: endpoint.toString(),
          status: response.status,
          cf_mitigated: response.headers.get("cf-mitigated") ?? undefined
        });
        return [];
      }
      const payload = (await response.json()) as ShopifyProductsResponse;
      if (!Array.isArray(payload.products)) {
        this.logger.debug("shopify_batch_payload_invalid", { endpoint: endpoint.toString() });
        return [];
      }

      const batch: RawProduct[] = [];
      for (const entry of payload.products) {
        const mapped = this.mapShopifyProduct(entry, storeUrl);
        if (mapped) {
          batch.push(mapped);
        }
      }
      return batch;
    } catch {
      this.logger.warn("shopify_batch_failed", { endpoint: endpoint.toString() });
      return [];
    }
  }

  private mapShopifyProduct(input: unknown, storeUrl: string): RawProduct | null {
    const product = asObject(input);
    if (!product) {
      return null;
    }

    const handle = asString(product.handle);
    const productUrl = handle
      ? normalizeUrl(`/products/${handle}`, storeUrl)
      : normalizeUrl(asString(product.url) ?? "", storeUrl);

    const optionNodes = Array.isArray(product.options) ? product.options : [];
    const optionDefinitions: Array<{ name: string; values: Set<string> }> = optionNodes.map((node, index) => {
      const option = asObject(node);
      const values = Array.isArray(option?.values)
        ? option.values
            .map((value) => asString(value))
            .filter((value): value is string => value !== undefined)
        : [];
      return {
        name: asString(option?.name) ?? `Option ${index + 1}`,
        values: new Set(values)
      };
    });

    const variantNodes = Array.isArray(product.variants) ? product.variants : [];
    const variants = variantNodes
      .map((variant) => asObject(variant))
      .filter((variant): variant is Record<string, unknown> => variant !== null)
      .map((variant) => {
        const optionValues = [asString(variant.option1), asString(variant.option2), asString(variant.option3)];
        const variantOptions: Record<string, string> = {};
        optionValues.forEach((value, index) => {
          if (!value) {
            return;
          }
          while (optionDefinitions.length <= index) {
            optionDefinitions.push({ name: `Option ${index + 1}`, values: new Set<string>() });
          }
          const optionName = optionDefinitions[index].name;
          optionDefinitions[index].values.add(value);
          variantOptions[optionName] = value;
        });

        return {
          id: asString(variant.id),
          title: asString(variant.title),
          sku: asString(variant.sku),
          price: asString(variant.price),
          compare_at_price: asString(variant.compare_at_price),
          currency: extractVariantCurrency(variant),
          available: extractShopifyVariantAvailability(variant),
          option1: optionValues[0],
          option2: optionValues[1],
          option3: optionValues[2],
          options: Object.keys(variantOptions).length > 0 ? variantOptions : undefined
        };
      });

    const normalizedOptions = optionDefinitions
      .map((option) => ({
        name: option.name,
        values: dedupeStrings([...option.values])
      }))
      .filter((option) => option.values.length > 0);

    const availabilityFlags = variants
      .map((variant) => asBoolean(variant.available))
      .filter((value): value is boolean => value !== undefined);
    const availability = availabilityFlags.length > 0 ? availabilityFlags.some(Boolean) : asBoolean(product.available);

    const imageFromProductImage = normalizeUrl(
      asString(asObject(product.image)?.src) ?? asString(product.image) ?? "",
      storeUrl
    );
    const imageFromImagesArray = Array.isArray(product.images)
      ? product.images
          .map((image) => asObject(image))
          .filter((image): image is Record<string, unknown> => image !== null)
          .map((image) => normalizeUrl(asString(image.src) ?? "", storeUrl))
          .find((url): url is string => typeof url === "string")
      : null;
    const imageFromVariant = variantNodes
      .map((variant) => asObject(variant))
      .filter((variant): variant is Record<string, unknown> => variant !== null)
      .map((variant) => asObject(variant.featured_image))
      .filter((image): image is Record<string, unknown> => image !== null)
      .map((image) => normalizeUrl(asString(image.src) ?? "", storeUrl))
      .find((url): url is string => typeof url === "string");
    const imageUrl = imageFromProductImage ?? imageFromImagesArray ?? imageFromVariant ?? undefined;

    const bodyHtml = asString(product.body_html);
    const description = toPlainText(bodyHtml);

    return {
      id: asString(product.id),
      url: productUrl ?? undefined,
      title: asString(product.title),
      handle,
      description,
      brand: asString(product.vendor),
      vendor: asString(product.vendor),
      product_type: asString(product.product_type),
      image_url: imageUrl,
      tags: parseShopifyTags(product.tags),
      price: variants[0]?.price,
      currency: variants[0]?.currency,
      availability,
      variants,
      options: normalizedOptions.length > 0 ? normalizedOptions : undefined,
      source: "shopify_json"
    };
  }
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function extractVariantCurrency(variant: Record<string, unknown>): string | undefined {
  const directCurrency = asString(variant.currency);
  if (directCurrency) {
    return directCurrency;
  }

  const presentmentContainer = asObject(variant.presentment_prices);
  const firstPresentment = asObject(asArray(presentmentContainer?.presentment_prices)[0]);
  const priceNode = asObject(firstPresentment?.price);
  return asString(priceNode?.currency_code);
}

function extractShopifyVariantAvailability(
  variant: Record<string, unknown>
): boolean | string | undefined {
  const direct = asBoolean(variant.available);
  if (direct !== undefined) {
    return direct;
  }

  const inventoryQuantityRaw = variant.inventory_quantity;
  if (typeof inventoryQuantityRaw === "number" && Number.isFinite(inventoryQuantityRaw)) {
    return inventoryQuantityRaw > 0;
  }

  const inventoryQuantityText = asString(inventoryQuantityRaw);
  if (inventoryQuantityText) {
    const parsed = Number.parseFloat(inventoryQuantityText);
    if (Number.isFinite(parsed)) {
      return parsed > 0;
    }
  }

  const inventoryPolicy = asString(variant.inventory_policy)?.toLowerCase();
  if (inventoryPolicy === "continue") {
    return true;
  }

  return undefined;
}
