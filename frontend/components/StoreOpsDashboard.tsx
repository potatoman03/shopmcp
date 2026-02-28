"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  asRecord,
  extractCoverageMetrics,
  extractStatus,
  extractStoreName,
  extractStoreUrl,
  formatDate,
  toIsoNow
} from "@/lib/utils";

type ManifestProductRow = {
  title: string;
  handle: string;
  category: string;
  priceMin: number | null;
  priceMax: number | null;
  available: boolean;
  variantCount: number;
  url: string;
};

type ManifestSummary = {
  indexedProducts: number;
  availableProducts: number;
  unavailableProducts: number;
  totalVariants: number;
  avgVariantsPerProduct: number;
  categories: Record<string, number>;
};

function toStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toBooleanValue(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["1", "true", "yes", "available", "in stock", "instock"].includes(normalized);
  }
  if (typeof value === "number") {
    return value > 0;
  }
  return false;
}

function parseCountMap(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }

  const mapped: Record<string, number> = {};
  for (const [key, count] of Object.entries(record)) {
    const parsed = toNumberValue(count);
    if (parsed !== null) {
      mapped[key] = parsed;
    }
  }
  return mapped;
}

function formatCents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

function formatPriceRange(min: number | null, max: number | null): string {
  if (min === null && max === null) {
    return "-";
  }
  if (min !== null && max !== null && min === max) {
    return formatCents(min);
  }
  if (min === null && max !== null) {
    return `<= ${formatCents(max)}`;
  }
  if (min !== null && max === null) {
    return `>= ${formatCents(min)}`;
  }
  return `${formatCents(min ?? 0)} - ${formatCents(max ?? 0)}`;
}

function extractManifestProducts(payload: unknown): ManifestProductRow[] {
  const root = asRecord(payload);
  const rows = root?.products;
  if (!Array.isArray(rows)) {
    return [];
  }

  const parsed: ManifestProductRow[] = [];
  for (const raw of rows) {
    const product = asRecord(raw);
    if (!product) {
      continue;
    }

    const title = toStringValue(product.title);
    const url = toStringValue(product.url);
    if (!title || !url) {
      continue;
    }

    parsed.push({
      title,
      handle: toStringValue(product.handle) ?? "-",
      category: toStringValue(product.category) ?? "uncategorized",
      priceMin: toNumberValue(product.price_min),
      priceMax: toNumberValue(product.price_max),
      available: toBooleanValue(product.available),
      variantCount: toNumberValue(product.variant_count) ?? 0,
      url
    });
  }

  return parsed;
}

function extractManifestSummary(payload: unknown, fallbackCount: number): ManifestSummary {
  const root = asRecord(payload);
  const summary = asRecord(root?.summary);
  return {
    indexedProducts: toNumberValue(summary?.indexed_products) ?? fallbackCount,
    availableProducts: toNumberValue(summary?.available_products) ?? 0,
    unavailableProducts: toNumberValue(summary?.unavailable_products) ?? 0,
    totalVariants: toNumberValue(summary?.total_variants) ?? 0,
    avgVariantsPerProduct: toNumberValue(summary?.avg_variants_per_product) ?? 0,
    categories: parseCountMap(summary?.categories)
  };
}

function statusTone(status: string): "pill-ok" | "pill-error" | "pill-warn" | "pill-neutral" {
  const value = status.toLowerCase();
  if (/done|ready|complete|indexed|success/.test(value)) {
    return "pill-ok";
  }
  if (/fail|error|invalid/.test(value)) {
    return "pill-error";
  }
  if (/queue|pending|crawl|running|index/.test(value)) {
    return "pill-warn";
  }
  return "pill-neutral";
}

interface Props {
  slug: string;
}

export default function StoreOpsDashboard({ slug }: Props): JSX.Element {
  const [statusPayload, setStatusPayload] = useState<unknown>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusCheckedAt, setStatusCheckedAt] = useState<string | null>(null);

  const [productsPayload, setProductsPayload] = useState<unknown>(null);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [productsCheckedAt, setProductsCheckedAt] = useState<string | null>(null);

  const pullStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/status/${encodeURIComponent(slug)}`, {
        method: "GET",
        cache: "no-store"
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : `Status request failed (${response.status})`;
        throw new Error(message);
      }

      setStatusPayload(payload);
      setStatusError(null);
      setStatusCheckedAt(toIsoNow());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Status unavailable";
      setStatusError(message);
      setStatusCheckedAt(toIsoNow());
    }
  }, [slug]);

  const pullProducts = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/products/${encodeURIComponent(slug)}?view=manifest&limit=1000&offset=0`,
        {
          method: "GET",
          cache: "no-store"
        }
      );

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : `Products request failed (${response.status})`;
        throw new Error(message);
      }

      setProductsPayload(payload);
      setProductsError(null);
      setProductsCheckedAt(toIsoNow());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Products unavailable";
      setProductsError(message);
      setProductsCheckedAt(toIsoNow());
    }
  }, [slug]);

  useEffect(() => {
    void pullStatus();
    void pullProducts();

    const timer = window.setInterval(() => {
      void pullStatus();
      void pullProducts();
    }, 6000);

    return () => {
      window.clearInterval(timer);
    };
  }, [pullProducts, pullStatus]);

  const metrics = useMemo(() => extractCoverageMetrics(statusPayload), [statusPayload]);
  const statusLabel = useMemo(() => extractStatus(statusPayload), [statusPayload]);
  const storeName = useMemo(() => extractStoreName(statusPayload, slug), [statusPayload, slug]);
  const storeUrl = useMemo(() => extractStoreUrl(statusPayload), [statusPayload]);

  const manifestProducts = useMemo(() => extractManifestProducts(productsPayload), [productsPayload]);
  const manifestSummary = useMemo(
    () => extractManifestSummary(productsPayload, manifestProducts.length),
    [productsPayload, manifestProducts.length]
  );
  const categoryRows = useMemo(
    () =>
      Object.entries(manifestSummary.categories).sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
      ),
    [manifestSummary.categories]
  );

  return (
    <div className="page-shell">
      <header className="page-header">
        <h1>{storeName} Ops</h1>
        <p>
          <Link href="/" className="btn-link">
            Index another store
          </Link>
        </p>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>Coverage Analysis</h2>
          <span className={`pill ${statusTone(statusLabel)}`}>{statusLabel}</span>
        </div>

        {statusError ? <p className="error-box">{statusError}</p> : null}

        <div className="inline-meta">
          <span>
            <strong>Slug:</strong> {slug}
          </span>
          <span>
            <strong>URL:</strong> {storeUrl ?? "-"}
          </span>
          <span>
            <strong>Last check:</strong> {formatDate(statusCheckedAt ?? undefined)}
          </span>
        </div>

        <div className="cards" style={{ marginTop: "0.85rem" }}>
          <article className="stat-card">
            <p className="stat-label">Discovered Pages</p>
            <p className="stat-value">{metrics.discovered ?? "-"}</p>
          </article>
          <article className="stat-card">
            <p className="stat-label">Indexed Pages</p>
            <p className="stat-value">{metrics.indexed ?? "-"}</p>
          </article>
          <article className="stat-card">
            <p className="stat-label">Failed Pages</p>
            <p className="stat-value">{metrics.failed ?? "-"}</p>
          </article>
          <article className="stat-card">
            <p className="stat-label">Coverage</p>
            <p className="stat-value">
              {typeof metrics.coverage === "number" ? `${metrics.coverage.toFixed(1)}%` : "-"}
            </p>
          </article>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Indexed Products</h2>
          <span className="muted">{manifestProducts.length} rows</span>
        </div>

        {productsError ? <p className="error-box">{productsError}</p> : null}

        <div className="inline-meta">
          <span>
            <strong>Last refresh:</strong> {formatDate(productsCheckedAt ?? undefined)}
          </span>
          <span>
            <strong>Categories:</strong> {categoryRows.length}
          </span>
        </div>

        <div className="cards" style={{ marginTop: "0.85rem" }}>
          <article className="stat-card">
            <p className="stat-label">Indexed Products</p>
            <p className="stat-value">{manifestSummary.indexedProducts}</p>
          </article>
          <article className="stat-card">
            <p className="stat-label">Available</p>
            <p className="stat-value">{manifestSummary.availableProducts}</p>
          </article>
          <article className="stat-card">
            <p className="stat-label">Unavailable</p>
            <p className="stat-value">{manifestSummary.unavailableProducts}</p>
          </article>
          <article className="stat-card">
            <p className="stat-label">Total Variants</p>
            <p className="stat-value">{manifestSummary.totalVariants}</p>
          </article>
          <article className="stat-card">
            <p className="stat-label">Avg Variants/Product</p>
            <p className="stat-value">{manifestSummary.avgVariantsPerProduct.toFixed(2)}</p>
          </article>
        </div>

        <div className="table-wrap" style={{ marginTop: "0.85rem" }}>
          <table className="stores-table products-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>URL</th>
                <th>Category</th>
                <th>Price</th>
                <th>Availability</th>
                <th>Variants</th>
                <th>Handle</th>
              </tr>
            </thead>
            <tbody>
              {manifestProducts.length === 0 ? (
                <tr>
                  <td colSpan={7}>No indexed products available yet.</td>
                </tr>
              ) : (
                manifestProducts.map((product) => (
                  <tr key={`${product.handle}-${product.url}`}>
                    <td>
                      <a className="table-link" href={product.url} target="_blank" rel="noreferrer">
                        {product.title}
                      </a>
                    </td>
                    <td className="mono">
                      <a className="table-link" href={product.url} target="_blank" rel="noreferrer">
                        {product.url}
                      </a>
                    </td>
                    <td>{product.category}</td>
                    <td>{formatPriceRange(product.priceMin, product.priceMax)}</td>
                    <td>
                      <span className={`pill ${product.available ? "pill-ok" : "pill-error"}`}>
                        {product.available ? "available" : "unavailable"}
                      </span>
                    </td>
                    <td>{product.variantCount}</td>
                    <td className="mono">{product.handle}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="table-wrap" style={{ marginTop: "0.85rem" }}>
          <table className="stores-table manifest-subtable">
            <thead>
              <tr>
                <th>Category</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {categoryRows.length === 0 ? (
                <tr>
                  <td colSpan={2}>No category data.</td>
                </tr>
              ) : (
                categoryRows.map(([name, count]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
