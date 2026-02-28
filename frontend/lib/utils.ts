import type { CoverageMetrics } from "@/lib/types";

type AnyRecord = Record<string, unknown>;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80);
}

export function toIsoNow(): string {
  return new Date().toISOString();
}

export function formatDate(iso?: string): string {
  if (!iso) {
    return "-";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString();
}

export function asRecord(value: unknown): AnyRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as AnyRecord;
}

function readPath(input: unknown, path: string[]): unknown {
  let current: unknown = input;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record || !(segment in record)) {
      return undefined;
    }
    current = record[segment];
  }
  return current;
}

function firstString(input: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const value = readPath(input, path);
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function firstNumber(input: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    const value = readPath(input, path);
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

export function extractStatus(payload: unknown): string {
  const status = firstString(payload, [
    ["status"],
    ["state"],
    ["job", "status"],
    ["crawl", "status"],
    ["data", "status"]
  ]);
  return status ?? "unknown";
}

function extractCoverage(payload: unknown): number | undefined {
  const discovered = firstNumber(payload, [
    ["metrics", "discovered_urls"],
    ["discovered_urls"],
    ["crawl", "discovered_urls"]
  ]);
  const crawled = firstNumber(payload, [
    ["metrics", "crawled_urls"],
    ["crawled_urls"],
    ["crawl", "crawled_urls"]
  ]);
  if (discovered !== null && crawled !== null && discovered > 0) {
    return (Math.min(crawled, discovered) / discovered) * 100;
  }

  const raw = firstNumber(payload, [
    ["coverage"],
    ["metrics", "coverage"],
    ["metrics", "coverage_pct"],
    ["crawl", "coverage"],
    ["crawl", "coverage_pct"],
    ["data", "coverage"]
  ]);
  if (raw === null) {
    return undefined;
  }
  return raw > 1 ? raw : raw * 100;
}

export function extractStoreName(payload: unknown, fallbackSlug: string): string {
  const name = firstString(payload, [
    ["store_name"],
    ["name"],
    ["store", "name"],
    ["metadata", "name"],
    ["data", "store_name"]
  ]);
  return name ?? fallbackSlug;
}

export function extractStoreUrl(payload: unknown): string | null {
  return firstString(payload, [
    ["url"],
    ["store_url"],
    ["store", "url"],
    ["metadata", "url"],
    ["data", "url"]
  ]);
}

export function extractCoverageMetrics(payload: unknown): CoverageMetrics {
  const discovered = firstNumber(payload, [
    ["metrics", "discovered_urls"],
    ["metrics", "discovered"],
    ["crawl", "discovered"],
    ["stats", "discovered"],
    ["data", "metrics", "discovered"]
  ]);

  const indexed = firstNumber(payload, [
    ["product_count"],
    ["indexed_products"],
    ["metrics", "crawled_urls"],
    ["metrics", "indexed"],
    ["crawl", "indexed"],
    ["stats", "indexed"],
    ["data", "metrics", "indexed"]
  ]);

  const failed = firstNumber(payload, [
    ["metrics", "skipped_unchanged"],
    ["metrics", "failed"],
    ["crawl", "failed"],
    ["stats", "failed"],
    ["data", "metrics", "failed"]
  ]);

  const coverageRaw = extractCoverage(payload);
  return {
    discovered,
    indexed,
    failed,
    coverage: coverageRaw ?? null
  };
}

export function parseSlugFromResponse(payload: unknown, fallback: string): string {
  const slug = firstString(payload, [["slug"], ["store", "slug"], ["data", "slug"]]);
  return slug ?? (slugify(fallback) || "store");
}
