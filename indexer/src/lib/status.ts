import { Platform } from "./platform";

export type IndexState = "queued" | "running" | "completed" | "failed";

export interface StatusMetrics {
  discovered_urls: number;
  crawled_urls: number;
  sitemap_urls: number;
  skipped_unchanged: number;
}

export interface StoreStatus {
  slug: string;
  store_name: string;
  store_url: string;
  platform: Platform;
  state: IndexState;
  metrics: StatusMetrics;
  indexed_products: number;
  product_count: number;
  endpoint: string;
  last_indexed?: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
}

const zeroMetrics = (): StatusMetrics => ({
  discovered_urls: 0,
  crawled_urls: 0,
  sitemap_urls: 0,
  skipped_unchanged: 0
});

export class StatusRegistry {
  private readonly statuses = new Map<string, StoreStatus>();
  private readonly stores = new Map<string, { url: string; storeName: string }>();

  registerStore(slug: string, storeUrl: string, storeName: string): void {
    this.stores.set(slug, { url: storeUrl, storeName });
  }

  getStore(slug: string): { url: string; storeName: string } | undefined {
    return this.stores.get(slug);
  }

  markQueued(slug: string, storeUrl: string, storeName: string): StoreStatus {
    const status: StoreStatus = {
      slug,
      store_name: storeName,
      store_url: storeUrl,
      platform: "unknown",
      state: "queued",
      metrics: zeroMetrics(),
      indexed_products: 0,
      product_count: 0,
      endpoint: "http://localhost:8000/mcp/sse"
    };

    this.statuses.set(slug, status);
    this.stores.set(slug, { url: storeUrl, storeName });
    return status;
  }

  markRunning(slug: string): StoreStatus | undefined {
    const current = this.statuses.get(slug);
    if (!current) {
      return undefined;
    }

    const next: StoreStatus = {
      ...current,
      state: "running",
      error: undefined,
      metrics: zeroMetrics(),
      indexed_products: 0,
      product_count: 0,
      started_at: new Date().toISOString(),
      finished_at: undefined
    };

    this.statuses.set(slug, next);
    return next;
  }

  setPlatform(slug: string, platform: Platform): void {
    const current = this.statuses.get(slug);
    if (!current) {
      return;
    }

    this.statuses.set(slug, { ...current, platform });
  }

  updateMetrics(slug: string, metrics: StatusMetrics): void {
    const current = this.statuses.get(slug);
    if (!current) {
      return;
    }

    this.statuses.set(slug, { ...current, metrics: { ...metrics } });
  }

  markCompleted(slug: string, metrics: StatusMetrics, indexedProducts: number): void {
    const current = this.statuses.get(slug);
    if (!current) {
      return;
    }

    this.statuses.set(slug, {
      ...current,
      state: "completed",
      metrics: { ...metrics },
      indexed_products: indexedProducts,
      product_count: indexedProducts,
      error: undefined,
      last_indexed: new Date().toISOString(),
      finished_at: new Date().toISOString()
    });
  }

  markFailed(slug: string, metrics: StatusMetrics, error: string): void {
    const current = this.statuses.get(slug);
    if (!current) {
      return;
    }

    this.statuses.set(slug, {
      ...current,
      state: "failed",
      metrics: { ...metrics },
      error,
      finished_at: new Date().toISOString()
    });
  }

  get(slug: string): StoreStatus | undefined {
    return this.statuses.get(slug);
  }

  isRunning(slug: string): boolean {
    return this.statuses.get(slug)?.state === "running";
  }
}
