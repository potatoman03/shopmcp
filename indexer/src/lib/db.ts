import { Pool } from "pg";
import { NormalizedProduct } from "../types";
import { Platform } from "./platform";
import { StatusMetrics, StoreStatus } from "./status";

export interface ProductFetchState {
  etag?: string;
  last_modified?: string;
}

export type CrawlRunMode = "index" | "refresh";
export type CrawlUrlStatus = "queued" | "crawled" | "indexed" | "excluded" | "error";
export type CrawlUrlSource = "sitemap" | "shopify_json" | "html_link" | "external";

export interface CrawlUrlEntry {
  url: string;
  url_norm: string;
  source: CrawlUrlSource;
  is_candidate_product: boolean;
}

export interface StoredStoreStatus {
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

export interface IndexedProductListItem {
  title: string;
  price?: number;
  description?: string;
  url: string;
}

export interface IndexedProductManifestItem {
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

  async upsertCrawlUrls(slug: string, runId: number | null, entries: CrawlUrlEntry[]): Promise<void> {
    if (!this.pool || runId === null || entries.length === 0) {
      return;
    }
    for (const entry of entries) {
      await this.pool.query(
        `
        insert into crawl_urls
          (store_slug, crawl_run_id, url, url_norm, source, is_candidate_product, metadata, status, last_seen_at, updated_at)
        values
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            case when $5 = 'external' then '{"external_discovered":true}'::jsonb else '{}'::jsonb end,
            'queued',
            now(),
            now()
          )
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
        [slug, runId, entry.url, entry.url_norm, entry.source, entry.is_candidate_product]
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

  async upsertProduct(product: NormalizedProduct, embedding: number[] | null): Promise<void> {
    if (!this.pool) {
      return;
    }

    const values = [
      product.store_slug,
      product.product_id,
      product.handle,
      product.title,
      product.product_type ?? null,
      product.vendor ?? product.brand ?? null,
      product.tags,
      product.price_min ?? null,
      product.price_max ?? null,
      product.available,
      product.url,
      product.image_url ?? null,
      product.search_text,
      JSON.stringify(product),
      embedding && embedding.length > 0 ? embeddingToVectorLiteral(embedding) : null,
      product.etag ?? null,
      product.last_modified ?? null
    ];

    await this.pool.query(
      `
      insert into products (
        store_slug, product_id, handle, title, product_type, vendor, tags, price_min, price_max,
        available, url, image_url, search_text, data, embedding, etag, last_modified, updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11, $12, $13, $14::jsonb, $15::vector, $16, $17, now()
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
        embedding = excluded.embedding,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        updated_at = now()
      `,
      values
    );
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
        and (
          url ilike '%/products/%'
          or price_min is not null
          or price_max is not null
        )
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
        data->>'description' as description
      from products
      where store_slug = $1
        and (
          lower(url) like '%/products/%'
          or lower(url) like '%/product/%'
          or price_min is not null
          or price_max is not null
          or (
            jsonb_typeof(data->'variants') = 'array'
            and jsonb_array_length(data->'variants') > 0
          )
        )
      order by title asc, id asc
      limit $2
      offset $3
      `,
      [storeSlug, safeLimit, safeOffset]
    );

    return rows.map((row) => ({
      title: row.title,
      handle: row.handle,
      category: row.category ?? "uncategorized",
      ...(typeof row.price_min === "number" ? { price_min: row.price_min } : {}),
      ...(typeof row.price_max === "number" ? { price_max: row.price_max } : {}),
      available: row.available,
      variant_count: Number.isFinite(row.variant_count) ? Number(row.variant_count) : 0,
      source: row.source ?? "unknown",
      url: row.url,
      ...(row.description ? { description: row.description } : {})
    }));
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
    endpoint: `http://localhost:8000/mcp/${stored.slug}/sse`,
    last_indexed: stored.indexed_at,
    error: stored.last_error
  };
}
