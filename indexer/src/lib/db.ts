import { Pool } from "pg";
import { NormalizedProduct } from "../types";
import { Platform } from "./platform";
import { StatusMetrics, StoreStatus } from "./status";

interface ProductFetchState {
  etag?: string;
  last_modified?: string;
}

interface ProductUpsertInput {
  product: NormalizedProduct;
  embedding: number[] | null;
}

type CrawlRunMode = "index" | "refresh";
type CrawlUrlStatus = "queued" | "crawled" | "indexed" | "excluded" | "error";
type CrawlUrlSource = "sitemap" | "shopify_json" | "html_link" | "external";

interface CrawlUrlEntry {
  url: string;
  url_norm: string;
  source: CrawlUrlSource;
  is_candidate_product: boolean;
}

interface StoredStoreStatus {
  slug: string;
  store_name: string;
  store_url: string;
  platform: Platform;
  product_count: number;
  indexed_at?: string;
  last_error?: string;
  run_state?: "queued" | "running" | "completed" | "failed";
  metrics?: StatusMetrics;
}

interface ListedStoreItem {
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
}

interface ListStoresResult {
  total: number;
  stores: ListedStoreItem[];
}

interface IndexedProductListItem {
  title: string;
  price?: number;
  description?: string;
  url: string;
}

interface IndexedProductManifestVariantItem {
  id?: string;
  title?: string;
  sku?: string;
  price_cents?: number;
  compare_at_cents?: number;
  currency?: string;
  available?: boolean;
  options?: Record<string, string>;
}

interface IndexedProductManifestItem {
  title: string;
  handle: string;
  category: string;
  price_min?: number;
  price_max?: number;
  available: boolean;
  variant_count: number;
  source: string;
  url: string;
  description?: string;
  variants?: IndexedProductManifestVariantItem[];
}

function embeddingToVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function asMetrics(input: unknown): StatusMetrics {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    discovered_urls: Number(record.discovered_urls ?? 0) || 0,
    crawled_urls: Number(record.crawled_urls ?? 0) || 0,
    sitemap_urls: Number(record.sitemap_urls ?? 0) || 0,
    skipped_unchanged: Number(record.skipped_unchanged ?? 0) || 0
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const mapped: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    const parsed = asString(entry);
    if (parsed) {
      mapped[key] = parsed;
    }
  }

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function toManifestVariants(value: unknown): IndexedProductManifestVariantItem[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const variants: IndexedProductManifestVariantItem[] = [];

  for (const raw of value) {
    const variant = asRecord(raw);
    if (!variant) {
      continue;
    }

    const mapped: IndexedProductManifestVariantItem = {
      ...(asString(variant.id) ? { id: asString(variant.id) } : {}),
      ...(asString(variant.title) ? { title: asString(variant.title) } : {}),
      ...(asString(variant.sku) ? { sku: asString(variant.sku) } : {}),
      ...(asFiniteNumber(variant.price_cents) !== undefined
        ? { price_cents: asFiniteNumber(variant.price_cents) }
        : {}),
      ...(asFiniteNumber(variant.compare_at_cents) !== undefined
        ? { compare_at_cents: asFiniteNumber(variant.compare_at_cents) }
        : {}),
      ...(asString(variant.currency) ? { currency: asString(variant.currency) } : {}),
      ...(asBoolean(variant.available) !== undefined ? { available: asBoolean(variant.available) } : {}),
      ...(asStringMap(variant.options) ? { options: asStringMap(variant.options) } : {})
    };

    variants.push(mapped);
  }

  return variants.length > 0 ? variants : undefined;
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  const safeSize = Math.max(1, size);
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += safeSize) {
    output.push(items.slice(index, index + safeSize));
  }
  return output;
}

export class Database {
  private readonly pool: Pool | null;

  constructor(databaseUrl: string | undefined) {
    this.pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  }

  isEnabled(): boolean {
    return this.pool !== null;
  }

  async healthcheck(): Promise<boolean> {
    if (!this.pool) {
      return true;
    }
    try {
      await this.pool.query("select 1");
      return true;
    } catch {
      return false;
    }
  }

  async upsertStore(slug: string, storeName: string, storeUrl: string, platform: Platform): Promise<void> {
    if (!this.pool) {
      return;
    }
    await this.pool.query(
      `
      insert into stores (slug, url, store_name, platform, indexed_at, updated_at)
      values ($1, $2, $3, $4, now(), now())
      on conflict (slug) do update set
        url = excluded.url,
        store_name = excluded.store_name,
        platform = excluded.platform,
        updated_at = now()
      `,
      [slug, storeUrl, storeName, platform]
    );
  }

  async getStore(slug: string): Promise<{ slug: string; store_name: string; url: string; platform: Platform } | null> {
    if (!this.pool) {
      return null;
    }
    const { rows } = await this.pool.query<{ slug: string; store_name: string; url: string; platform: Platform }>(
      "select slug, store_name, url, platform from stores where slug = $1 limit 1",
      [slug]
    );
    return rows[0] ?? null;
  }

  async createCrawlRun(slug: string, mode: CrawlRunMode): Promise<number | null> {
    if (!this.pool) {
      return null;
    }
    const { rows } = await this.pool.query<{ id: number }>(
      `
      insert into crawl_runs (store_slug, mode, status, started_at, updated_at)
      values ($1, $2, 'running', now(), now())
      returning id
      `,
      [slug, mode]
    );
    return rows[0]?.id ?? null;
  }

  async completeCrawlRun(
    slug: string,
    runId: number | null,
    status: "completed" | "failed",
    metrics: StatusMetrics,
    error?: string
  ): Promise<void> {
    if (!this.pool || runId === null) {
      return;
    }
    await this.pool.query(
      `
      update crawl_runs
      set status = $3,
          stats = $4::jsonb,
          error = $5,
          finished_at = now(),
          updated_at = now()
      where id = $1 and store_slug = $2
      `,
      [runId, slug, status, JSON.stringify(metrics), error ?? null]
    );
  }

  async upsertCrawlUrls(
    slug: string,
    runId: number | null,
    entries: CrawlUrlEntry[],
    batchSize = 500
  ): Promise<void> {
    if (!this.pool || runId === null || entries.length === 0) {
      return;
    }

    for (const batch of chunk(entries, batchSize)) {
      const urls = batch.map((entry) => entry.url);
      const urlNorms = batch.map((entry) => entry.url_norm);
      const sources = batch.map((entry) => entry.source);
      const candidateFlags = batch.map((entry) => entry.is_candidate_product);

      await this.pool.query(
        `
        insert into crawl_urls
          (store_slug, crawl_run_id, url, url_norm, source, is_candidate_product, metadata, status, last_seen_at, updated_at)
        select
          $1::text as store_slug,
          $2::bigint as crawl_run_id,
          input.url,
          input.url_norm,
          input.source,
          input.is_candidate_product,
          case
            when input.source = 'external' then '{"external_discovered":true}'::jsonb
            else '{}'::jsonb
          end as metadata,
          'queued'::text as status,
          now() as last_seen_at,
          now() as updated_at
        from unnest(
          $3::text[],
          $4::text[],
          $5::text[],
          $6::boolean[]
        ) as input(url, url_norm, source, is_candidate_product)
        on conflict (store_slug, url_norm) do update set
          crawl_run_id = excluded.crawl_run_id,
          url = excluded.url,
          source = excluded.source,
          is_candidate_product = excluded.is_candidate_product,
          metadata = jsonb_build_object(
            'external_discovered',
            coalesce((crawl_urls.metadata->>'external_discovered')::boolean, false)
            or excluded.source = 'external'
          ),
          status = 'queued',
          last_seen_at = now(),
          updated_at = now()
        `,
        [slug, runId, urls, urlNorms, sources, candidateFlags]
      );
    }
  }

  async markCrawlUrl(slug: string, urlNorm: string, status: CrawlUrlStatus, httpStatus?: number, error?: string): Promise<void> {
    if (!this.pool) {
      return;
    }
    await this.pool.query(
      `
      update crawl_urls
      set status = $3,
          http_status = $4,
          error = $5,
          last_crawled_at = now(),
          updated_at = now()
      where store_slug = $1 and url_norm = $2
      `,
      [slug, urlNorm, status, httpStatus ?? null, error ?? null]
    );
  }

  async getFetchState(storeSlug: string, urls: string[]): Promise<Map<string, ProductFetchState>> {
    const states = new Map<string, ProductFetchState>();
    if (!this.pool || urls.length === 0) {
      return states;
    }

    const { rows } = await this.pool.query<{ url: string; etag: string | null; last_modified: string | null }>(
      `
      select url, etag, last_modified
      from products
      where store_slug = $1 and url = any($2::text[])
      `,
      [storeSlug, urls]
    );

    for (const row of rows) {
      states.set(row.url, {
        ...(row.etag ? { etag: row.etag } : {}),
        ...(row.last_modified ? { last_modified: row.last_modified } : {})
      });
    }
    return states;
  }

  async getProductHashesByHandle(storeSlug: string, handles: string[]): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    if (!this.pool || handles.length === 0) {
      return hashes;
    }

    const { rows } = await this.pool.query<{ handle: string; content_hash: string | null }>(
      `
      select handle, content_hash
      from products
      where store_slug = $1
        and handle = any($2::text[])
      `,
      [storeSlug, handles]
    );

    for (const row of rows) {
      if (row.content_hash) {
        hashes.set(row.handle, row.content_hash);
      }
    }
    return hashes;
  }

  async upsertProductsBatch(items: ProductUpsertInput[], batchSize = 200): Promise<void> {
    if (!this.pool || items.length === 0) {
      return;
    }

    for (const batch of chunk(items, batchSize)) {
      const storeSlugs = batch.map((item) => item.product.store_slug);
      const productIds = batch.map((item) => item.product.product_id);
      const handles = batch.map((item) => item.product.handle);
      const titles = batch.map((item) => item.product.title);
      const productTypes = batch.map((item) => item.product.product_type ?? null);
      const vendors = batch.map((item) => item.product.vendor ?? item.product.brand ?? null);
      const tagsJson = batch.map((item) => JSON.stringify(item.product.tags ?? []));
      const priceMins = batch.map((item) => item.product.price_min ?? null);
      const priceMaxes = batch.map((item) => item.product.price_max ?? null);
      const availableFlags = batch.map((item) => item.product.available);
      const urls = batch.map((item) => item.product.url);
      const imageUrls = batch.map((item) => item.product.image_url ?? null);
      const searchTexts = batch.map((item) => item.product.search_text);
      const payloads = batch.map((item) => JSON.stringify(item.product));
      const embeddings = batch.map((item) =>
        item.embedding && item.embedding.length > 0 ? embeddingToVectorLiteral(item.embedding) : null
      );
      const etags = batch.map((item) => item.product.etag ?? null);
      const lastModified = batch.map((item) => item.product.last_modified ?? null);
      const catalogFlags = batch.map((item) => item.product.is_catalog_product ?? true);
      const summaryShort = batch.map((item) => item.product.summary_short ?? null);
      const summaryLlm = batch.map((item) => item.product.summary_llm ?? null);
      const optionTokensJson = batch.map((item) => JSON.stringify(item.product.option_tokens ?? []));
      const contentHashes = batch.map((item) => item.product.content_hash ?? null);

      await this.pool.query(
        `
        insert into products (
          store_slug,
          product_id,
          handle,
          title,
          product_type,
          vendor,
          tags,
          price_min,
          price_max,
          available,
          url,
          image_url,
          search_text,
          data,
          embedding,
          etag,
          last_modified,
          is_catalog_product,
          summary_short,
          summary_llm,
          option_tokens,
          content_hash,
          updated_at
        )
        select
          input.store_slug,
          input.product_id,
          input.handle,
          input.title,
          input.product_type,
          input.vendor,
          case
            when input.tags_json is null then '{}'::text[]
            when jsonb_typeof(input.tags_json::jsonb) <> 'array' then '{}'::text[]
            else coalesce(array(select jsonb_array_elements_text(input.tags_json::jsonb)), '{}'::text[])
          end as tags,
          input.price_min,
          input.price_max,
          input.available,
          input.url,
          input.image_url,
          input.search_text,
          input.data::jsonb,
          case
            when input.embedding is null then null
            else input.embedding::vector
          end as embedding,
          input.etag,
          input.last_modified,
          input.is_catalog_product,
          input.summary_short,
          input.summary_llm,
          case
            when input.option_tokens_json is null then '{}'::text[]
            when jsonb_typeof(input.option_tokens_json::jsonb) <> 'array' then '{}'::text[]
            else coalesce(array(select jsonb_array_elements_text(input.option_tokens_json::jsonb)), '{}'::text[])
          end as option_tokens,
          input.content_hash,
          now()
        from unnest(
          $1::text[],
          $2::text[],
          $3::text[],
          $4::text[],
          $5::text[],
          $6::text[],
          $7::text[],
          $8::int[],
          $9::int[],
          $10::boolean[],
          $11::text[],
          $12::text[],
          $13::text[],
          $14::text[],
          $15::text[],
          $16::text[],
          $17::text[],
          $18::boolean[],
          $19::text[],
          $20::text[],
          $21::text[],
          $22::text[]
        ) as input(
          store_slug,
          product_id,
          handle,
          title,
          product_type,
          vendor,
          tags_json,
          price_min,
          price_max,
          available,
          url,
          image_url,
          search_text,
          data,
          embedding,
          etag,
          last_modified,
          is_catalog_product,
          summary_short,
          summary_llm,
          option_tokens_json,
          content_hash
        )
        on conflict (store_slug, handle) do update set
          product_id = excluded.product_id,
          handle = excluded.handle,
          title = excluded.title,
          product_type = excluded.product_type,
          vendor = excluded.vendor,
          tags = excluded.tags,
          price_min = excluded.price_min,
          price_max = excluded.price_max,
          available = excluded.available,
          url = excluded.url,
          image_url = excluded.image_url,
          search_text = excluded.search_text,
          data = excluded.data,
          embedding = case
            when excluded.content_hash is not distinct from products.content_hash then products.embedding
            when excluded.embedding is null then products.embedding
            else excluded.embedding
          end,
          etag = excluded.etag,
          last_modified = excluded.last_modified,
          is_catalog_product = excluded.is_catalog_product,
          summary_short = excluded.summary_short,
          summary_llm = case
            when excluded.content_hash is not distinct from products.content_hash then products.summary_llm
            when excluded.summary_llm is null then products.summary_llm
            else excluded.summary_llm
          end,
          option_tokens = excluded.option_tokens,
          content_hash = excluded.content_hash,
          updated_at = now()
        `,
        [
          storeSlugs,
          productIds,
          handles,
          titles,
          productTypes,
          vendors,
          tagsJson,
          priceMins,
          priceMaxes,
          availableFlags,
          urls,
          imageUrls,
          searchTexts,
          payloads,
          embeddings,
          etags,
          lastModified,
          catalogFlags,
          summaryShort,
          summaryLlm,
          optionTokensJson,
          contentHashes
        ]
      );
    }
  }

  async upsertProduct(product: NormalizedProduct, embedding: number[] | null): Promise<void> {
    await this.upsertProductsBatch([{ product, embedding }], 1);
  }

  async updateStoreIndexOutcome(
    slug: string,
    platform: Platform,
    productCount: number,
    error?: string
  ): Promise<void> {
    if (!this.pool) {
      return;
    }
    await this.pool.query(
      `
      update stores
      set platform = $2,
          indexed_at = now(),
          product_count = $3,
          last_error = $4,
          updated_at = now()
      where slug = $1
      `,
      [slug, platform, productCount, error ?? null]
    );
  }

  async getStoredStatus(slug: string): Promise<StoredStoreStatus | null> {
    if (!this.pool) {
      return null;
    }

    const { rows } = await this.pool.query<{
      slug: string;
      store_name: string;
      url: string;
      platform: Platform;
      product_count: number;
      indexed_at: Date | null;
      last_error: string | null;
      run_status: "queued" | "running" | "completed" | "failed" | null;
      run_stats: unknown;
    }>(
      `
      select
        s.slug,
        s.store_name,
        s.url,
        s.platform,
        s.product_count,
        s.indexed_at,
        s.last_error,
        cr.status as run_status,
        cr.stats as run_stats
      from stores s
      left join lateral (
        select status, stats
        from crawl_runs
        where store_slug = s.slug
        order by started_at desc
        limit 1
      ) cr on true
      where s.slug = $1
      limit 1
      `,
      [slug]
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      slug: row.slug,
      store_name: row.store_name,
      store_url: row.url,
      platform: row.platform,
      product_count: row.product_count ?? 0,
      indexed_at: row.indexed_at?.toISOString(),
      last_error: row.last_error ?? undefined,
      run_state: row.run_status ?? undefined,
      metrics: asMetrics(row.run_stats)
    };
  }

  async listStores(limit = 200, offset = 0): Promise<ListStoresResult> {
    if (!this.pool) {
      return { total: 0, stores: [] };
    }

    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const safeOffset = Math.max(0, offset);

    const countResult = await this.pool.query<{ count: string }>("select count(*)::bigint as count from stores");
    const total = Number(countResult.rows[0]?.count ?? 0);

    const { rows } = await this.pool.query<{
      slug: string;
      store_name: string;
      url: string;
      platform: Platform;
      product_count: number;
      indexed_at: Date | null;
      created_at: Date | null;
      updated_at: Date | null;
      last_error: string | null;
      run_status: "queued" | "running" | "completed" | "failed" | null;
      run_stats: unknown;
      run_error: string | null;
      run_started_at: Date | null;
      run_finished_at: Date | null;
    }>(
      `
      select
        s.slug,
        s.store_name,
        s.url,
        s.platform,
        s.product_count,
        s.indexed_at,
        s.created_at,
        s.updated_at,
        s.last_error,
        cr.status as run_status,
        cr.stats as run_stats,
        cr.error as run_error,
        cr.started_at as run_started_at,
        cr.finished_at as run_finished_at
      from stores s
      left join lateral (
        select status, stats, error, started_at, finished_at
        from crawl_runs
        where store_slug = s.slug
        order by started_at desc
        limit 1
      ) cr on true
      order by coalesce(s.updated_at, s.indexed_at, s.created_at) desc, s.slug asc
      limit $1
      offset $2
      `,
      [safeLimit, safeOffset]
    );

    return {
      total,
      stores: rows.map((row) => {
        const status = row.run_status ?? (row.last_error ? "failed" : "completed");
        return {
          slug: row.slug,
          store_name: row.store_name,
          store_url: row.url,
          platform: row.platform,
          product_count: row.product_count ?? 0,
          status,
          metrics: asMetrics(row.run_stats),
          indexed_at: row.indexed_at?.toISOString(),
          created_at: row.created_at?.toISOString(),
          updated_at: row.updated_at?.toISOString(),
          run_started_at: row.run_started_at?.toISOString(),
          run_finished_at: row.run_finished_at?.toISOString(),
          last_error: row.last_error ?? row.run_error ?? undefined
        };
      })
    };
  }

  async listIndexedProducts(storeSlug: string, limit = 100, offset = 0): Promise<IndexedProductListItem[]> {
    if (!this.pool) {
      return [];
    }

    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const safeOffset = Math.max(0, offset);
    const { rows } = await this.pool.query<{
      title: string;
      price: number | null;
      description: string | null;
      url: string;
    }>(
      `
      select
        title,
        coalesce(price_min, price_max) as price,
        data->>'description' as description,
        url
      from products
      where store_slug = $1
        and coalesce(is_catalog_product, true) = true
      order by updated_at desc, id desc
      limit $2
      offset $3
      `,
      [storeSlug, safeLimit, safeOffset]
    );

    return rows.map((row) => ({
      title: row.title,
      ...(typeof row.price === "number" ? { price: row.price } : {}),
      ...(row.description ? { description: row.description } : {}),
      url: row.url
    }));
  }

  async listIndexedProductManifest(
    storeSlug: string,
    limit = 1000,
    offset = 0
  ): Promise<IndexedProductManifestItem[]> {
    if (!this.pool) {
      return [];
    }

    const safeLimit = Math.max(1, Math.min(limit, 5000));
    const safeOffset = Math.max(0, offset);
    const { rows } = await this.pool.query<{
      title: string;
      handle: string;
      category: string | null;
      price_min: number | null;
      price_max: number | null;
      available: boolean;
      variant_count: number;
      source: string | null;
      url: string;
      description: string | null;
      variants: unknown;
    }>(
      `
      select
        title,
        handle,
        nullif(product_type, '') as category,
        price_min,
        price_max,
        available,
        case
          when jsonb_typeof(data->'variants') = 'array' then jsonb_array_length(data->'variants')
          else 0
        end as variant_count,
        nullif(data->>'source', '') as source,
        url,
        data->>'description' as description,
        data->'variants' as variants
      from products
      where store_slug = $1
        and coalesce(is_catalog_product, true) = true
      order by title asc, id asc
      limit $2
      offset $3
      `,
      [storeSlug, safeLimit, safeOffset]
    );

    return rows.map((row) => {
      const variants = toManifestVariants(row.variants);
      return {
        title: row.title,
        handle: row.handle,
        category: row.category ?? "uncategorized",
        ...(typeof row.price_min === "number" ? { price_min: row.price_min } : {}),
        ...(typeof row.price_max === "number" ? { price_max: row.price_max } : {}),
        available: row.available,
        variant_count: Number.isFinite(row.variant_count) ? Number(row.variant_count) : 0,
        source: row.source ?? "unknown",
        url: row.url,
        ...(row.description ? { description: row.description } : {}),
        ...(variants ? { variants } : {})
      };
    });
  }

  async listExternalDiscoveredUrls(storeSlug: string): Promise<string[]> {
    if (!this.pool) {
      return [];
    }

    const { rows } = await this.pool.query<{ url_norm: string }>(
      `
      select distinct url_norm
      from crawl_urls
      where store_slug = $1
        and (
          source = 'external'
          or coalesce((metadata->>'external_discovered')::boolean, false)
        )
      order by url_norm asc
      `,
      [storeSlug]
    );

    return rows.map((row) => row.url_norm).filter((value) => value.length > 0);
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

export function toStoreStatus(stored: StoredStoreStatus): StoreStatus {
  const stateMap: Record<string, StoreStatus["state"]> = {
    queued: "queued",
    running: "running",
    completed: "completed",
    failed: "failed"
  };

  return {
    slug: stored.slug,
    store_name: stored.store_name,
    store_url: stored.store_url,
    platform: stored.platform,
    state: stateMap[stored.run_state ?? "completed"] ?? "completed",
    metrics: stored.metrics ?? {
      discovered_urls: 0,
      crawled_urls: 0,
      sitemap_urls: 0,
      skipped_unchanged: 0
    },
    indexed_products: stored.product_count,
    product_count: stored.product_count,
    endpoint: "http://localhost:8000/mcp/sse",
    last_indexed: stored.indexed_at,
    error: stored.last_error
  };
}
