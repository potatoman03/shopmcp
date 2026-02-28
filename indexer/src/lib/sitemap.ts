import { gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { normalizeUrl } from "./url";

interface ParsedSitemap {
  sitemaps: string[];
  urls: string[];
}

interface SitemapCollectionResult {
  urls: string[];
  sitemapUrls: number;
  visitedSitemaps: number;
}

interface SitemapQueueItem {
  url: string;
  depth: number;
}

interface CollectSitemapArgs {
  seedSitemaps: string[];
  baseUrl: string;
  fetchSitemap: (url: string) => Promise<Buffer | null>;
  maxDepth?: number;
  maxSitemaps?: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function extractSitemapUrlsFromRobots(robotsTxt: string, baseUrl: string): string[] {
  const discovered = new Set<string>();

  for (const line of robotsTxt.split(/\r?\n/)) {
    const match = line.match(/^\s*sitemap\s*:\s*(.+)$/i);
    if (!match) {
      continue;
    }

    const normalized = normalizeUrl(match[1], baseUrl);
    if (normalized) {
      discovered.add(normalized);
    }
  }

  return [...discovered];
}

export function fallbackSitemapUrls(baseUrl: string): string[] {
  const paths = ["/sitemap.xml", "/sitemap_index.xml", "/sitemap_products.xml", "/sitemap_products_1.xml"];
  const discovered = new Set<string>();

  for (const path of paths) {
    const normalized = normalizeUrl(path, baseUrl);
    if (normalized) {
      discovered.add(normalized);
    }
  }

  return [...discovered];
}

export function decodeSitemapBody(body: Buffer): string {
  const isGzip = body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
  if (isGzip) {
    return gunzipSync(body).toString("utf8");
  }

  return body.toString("utf8");
}

export function parseSitemapXml(xml: string): ParsedSitemap {
  const sitemaps: string[] = [];
  const urls: string[] = [];

  try {
    const parsed = parser.parse(xml) as Record<string, unknown>;

    const sitemapIndex = parsed.sitemapindex as { sitemap?: unknown } | undefined;
    if (sitemapIndex) {
      for (const sitemapNode of asArray(sitemapIndex.sitemap)) {
        if (typeof sitemapNode === "object" && sitemapNode !== null) {
          const loc = asTrimmedString((sitemapNode as Record<string, unknown>).loc);
          if (loc) {
            sitemaps.push(loc);
          }
        }
      }
    }

    const urlSet = parsed.urlset as { url?: unknown } | undefined;
    if (urlSet) {
      for (const urlNode of asArray(urlSet.url)) {
        if (typeof urlNode === "object" && urlNode !== null) {
          const loc = asTrimmedString((urlNode as Record<string, unknown>).loc);
          if (loc) {
            urls.push(loc);
          }
        }
      }
    }
  } catch {
    // Ignore XML parse errors and fall through to plain-text fallback.
  }

  if (sitemaps.length === 0 && urls.length === 0) {
    for (const line of xml.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (/^https?:\/\//i.test(trimmed)) {
        urls.push(trimmed);
      }
    }
  }

  return { sitemaps, urls };
}

export async function collectSitemapUrls({
  seedSitemaps,
  baseUrl,
  fetchSitemap,
  maxDepth = 5,
  maxSitemaps = 500
}: CollectSitemapArgs): Promise<SitemapCollectionResult> {
  const visitedSitemaps = new Set<string>();
  const discoveredUrls = new Set<string>();
  const queue: SitemapQueueItem[] = [];

  for (const seed of seedSitemaps) {
    const normalized = normalizeUrl(seed, baseUrl);
    if (normalized) {
      queue.push({ url: normalized, depth: 0 });
    }
  }

  while (queue.length > 0 && visitedSitemaps.size < maxSitemaps) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    if (current.depth > maxDepth || visitedSitemaps.has(current.url)) {
      continue;
    }

    visitedSitemaps.add(current.url);

    const body = await fetchSitemap(current.url);
    if (!body) {
      continue;
    }

    let xml: string;
    try {
      xml = decodeSitemapBody(body);
    } catch {
      continue;
    }

    const parsed = parseSitemapXml(xml);

    for (const nestedSitemap of parsed.sitemaps) {
      const normalized = normalizeUrl(nestedSitemap, baseUrl);
      if (normalized && !visitedSitemaps.has(normalized)) {
        queue.push({ url: normalized, depth: current.depth + 1 });
      }
    }

    for (const discovered of parsed.urls) {
      const normalized = normalizeUrl(discovered, baseUrl);
      if (normalized) {
        discoveredUrls.add(normalized);
      }
    }
  }

  return {
    urls: [...discoveredUrls],
    sitemapUrls: discoveredUrls.size,
    visitedSitemaps: visitedSitemaps.size
  };
}
