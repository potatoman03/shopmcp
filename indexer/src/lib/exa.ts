import { Logger } from "./logger";
import { normalizeUrl } from "./url";

export interface ExternalDiscoveryPlugin {
  readonly name: string;
  discoverProductUrls(storeUrl: string): Promise<string[]>;
}

interface ExaConfig {
  apiKey: string;
  baseUrl: string;
  maxResults: number;
  timeoutMs: number;
  logLevel?: string;
}

interface ExaSearchResult {
  url?: string;
  score?: number;
}

interface ExaSearchResponse {
  results?: ExaSearchResult[];
}

function isLikelyProductUrl(url: string): boolean {
  const text = url.toLowerCase();
  return text.includes("/products/") || text.includes("/product/") || text.includes("?variant=");
}

function sanitizeHost(hostname: string): string {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

function buildExaSearchUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (/\/search\/?$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed.replace(/\/+$/, "")}/search`;
}

function asExaResponse(payload: unknown): ExaSearchResponse {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const direct = payload as { results?: unknown };
  if (Array.isArray(direct.results)) {
    return { results: direct.results as ExaSearchResult[] };
  }

  const wrapped = payload as { data?: { results?: unknown } };
  if (wrapped.data && Array.isArray(wrapped.data.results)) {
    return { results: wrapped.data.results as ExaSearchResult[] };
  }

  return {};
}

class ExaDiscoveryPlugin implements ExternalDiscoveryPlugin {
  readonly name = "exa";
  private readonly logger: Logger;
  private readonly searchUrl: string;

  constructor(private readonly config: ExaConfig) {
    this.logger = new Logger("indexer.exa", config.logLevel);
    this.searchUrl = buildExaSearchUrl(config.baseUrl);
  }

  private async search(query: string, includeDomain: string): Promise<string[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(this.searchUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-api-key": this.config.apiKey
        },
        body: JSON.stringify({
          query,
          type: "keyword",
          numResults: this.config.maxResults,
          includeDomains: [includeDomain]
        })
      });

      if (!response.ok) {
        this.logger.warn("search_http_error", {
          search_url: this.searchUrl,
          status: response.status,
          query
        });
        return [];
      }

      const payload = asExaResponse((await response.json()) as unknown);
      if (!Array.isArray(payload.results)) {
        this.logger.warn("search_payload_invalid", { query, search_url: this.searchUrl });
        return [];
      }

      return payload.results
        .map((result) => (typeof result.url === "string" ? result.url : undefined))
        .filter((url): url is string => Boolean(url));
    } catch (error) {
      this.logger.warn("search_failed", {
        search_url: this.searchUrl,
        query,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  async discoverProductUrls(storeUrl: string): Promise<string[]> {
    const canonicalStoreUrl = normalizeUrl(storeUrl);
    if (!canonicalStoreUrl) {
      return [];
    }

    let hostname: string;
    try {
      hostname = sanitizeHost(new URL(canonicalStoreUrl).hostname);
    } catch {
      return [];
    }

    const queries = [
      `site:${hostname} /products/`,
      `site:${hostname} inurl:/products/`,
      `site:${hostname} "add to cart" "products/"`,
      `site:${hostname} "variant="`
    ];

    const unique = new Set<string>();
    for (const query of queries) {
      const urls = await this.search(query, hostname);
      for (const rawUrl of urls) {
        const normalized = normalizeUrl(rawUrl, canonicalStoreUrl);
        if (!normalized) {
          continue;
        }
        const candidateHost = sanitizeHost(new URL(normalized).hostname);
        if (candidateHost !== hostname) {
          continue;
        }
        if (!isLikelyProductUrl(normalized)) {
          continue;
        }
        unique.add(normalized);
      }
    }

    const discovered = [...unique];
    this.logger.info("search_completed", {
      store_url: canonicalStoreUrl,
      query_count: queries.length,
      discovered_urls: discovered.length
    });
    return discovered;
  }
}

export function createDiscoveryPlugin(config: {
  exaApiKey?: string;
  exaBaseUrl: string;
  exaMaxResults: number;
  exaTimeoutMs: number;
  logLevel?: string;
}): ExternalDiscoveryPlugin | null {
  if (!config.exaApiKey) {
    return null;
  }

  return new ExaDiscoveryPlugin({
    apiKey: config.exaApiKey,
    baseUrl: config.exaBaseUrl,
    maxResults: config.exaMaxResults,
    timeoutMs: config.exaTimeoutMs,
    logLevel: config.logLevel
  });
}
