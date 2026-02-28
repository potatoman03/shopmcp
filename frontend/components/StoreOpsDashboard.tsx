"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import styles from "@/components/StoreOpsDashboard.module.css";
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
  variants: ManifestVariantRow[];
  url: string;
};

type ManifestVariantRow = {
  id: string | null;
  title: string | null;
  sku: string | null;
  priceCents: number | null;
  compareAtCents: number | null;
  currency: string | null;
  available: boolean | null;
  options: Record<string, string>;
};

type ManifestSummary = {
  indexedProducts: number;
  availableProducts: number;
  unavailableProducts: number;
  totalVariants: number;
  avgVariantsPerProduct: number;
  categories: Record<string, number>;
};

type Tone = "ok" | "error" | "warn" | "neutral";

type CompactResultRow = {
  rank: number;
  handle: string;
  title: string;
  priceMin: number | null;
  priceMax: number | null;
  available: boolean;
  url: string;
  summaryShort: string | null;
  whyMatch: string | null;
  fitSignals: string[];
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

function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "available", "in stock", "instock"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "unavailable", "out of stock", "outofstock"].includes(normalized)) {
      return false;
    }
  }
  if (typeof value === "number") {
    return value > 0;
  }
  return null;
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

function parseStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }

  const mapped: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      mapped[key] = entry.trim();
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

function extractCompactResults(payload: unknown): CompactResultRow[] {
  const root = asRecord(payload);
  const rows = root?.results;
  if (!Array.isArray(rows)) {
    return [];
  }

  const parsed: CompactResultRow[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) {
      continue;
    }

    const title = toStringValue(row.title);
    const handle = toStringValue(row.handle);
    const url = toStringValue(row.url);
    if (!title || !handle || !url) {
      continue;
    }

    parsed.push({
      rank: toNumberValue(row.rank) ?? parsed.length + 1,
      handle,
      title,
      priceMin: toNumberValue(row.price_min),
      priceMax: toNumberValue(row.price_max),
      available: toBooleanValue(row.available),
      url,
      summaryShort: toStringValue(row.summary_short),
      whyMatch: toStringValue(row.why_match),
      fitSignals: Array.isArray(row.fit_signals)
        ? row.fit_signals
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .map((item) => item.trim())
        : []
    });
  }

  return parsed;
}

function extractVariantRows(value: unknown): ManifestVariantRow[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const rows: ManifestVariantRow[] = [];
  for (const raw of value) {
    const variant = asRecord(raw);
    if (!variant) {
      continue;
    }

    rows.push({
      id: toStringValue(variant.id),
      title: toStringValue(variant.title),
      sku: toStringValue(variant.sku),
      priceCents: toNumberValue(variant.price_cents),
      compareAtCents: toNumberValue(variant.compare_at_cents),
      currency: toStringValue(variant.currency),
      available: toBooleanOrNull(variant.available),
      options: parseStringMap(variant.options)
    });
  }

  return rows;
}

function formatVariantOptions(options: Record<string, string>): string | null {
  const entries = Object.entries(options);
  if (entries.length === 0) {
    return null;
  }
  return entries.map(([name, value]) => `${name}: ${value}`).join(" • ");
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
    const variants = extractVariantRows(product.variants);

    parsed.push({
      title,
      handle: toStringValue(product.handle) ?? "-",
      category: toStringValue(product.category) ?? "uncategorized",
      priceMin: toNumberValue(product.price_min),
      priceMax: toNumberValue(product.price_max),
      available: toBooleanValue(product.available),
      variantCount: toNumberValue(product.variant_count) ?? variants.length,
      variants,
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

function statusTone(status: string): Tone {
  const value = status.toLowerCase();
  if (/done|ready|complete|indexed|success/.test(value)) {
    return "ok";
  }
  if (/fail|error|invalid/.test(value)) {
    return "error";
  }
  if (/queue|pending|crawl|running|index/.test(value)) {
    return "warn";
  }
  return "neutral";
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
  const [expandedVariants, setExpandedVariants] = useState<Record<string, boolean>>({});
  const [v2Query, setV2Query] = useState("lip tint");
  const [v2Budget, setV2Budget] = useState("5000");
  const [v2SkinTone, setV2SkinTone] = useState("dark");
  const [v2Payload, setV2Payload] = useState<unknown>(null);
  const [v2Loading, setV2Loading] = useState(false);
  const [v2Error, setV2Error] = useState<string | null>(null);

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

  const runV2Search = useCallback(async () => {
    setV2Loading(true);
    setV2Error(null);
    try {
      const budgetMax = Number.parseInt(v2Budget, 10);
      const body = {
        arguments: {
          query: v2Query.trim(),
          slug,
          limit: 5,
          available_only: true,
          ...(Number.isFinite(budgetMax) ? { budget_max_cents: budgetMax } : {}),
          ...(v2SkinTone.trim().length > 0 ? { skin_tone: v2SkinTone.trim() } : {})
        }
      };

      const response = await fetch(`/api/mcp/${encodeURIComponent(slug)}/tool/search_products_v2`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        cache: "no-store",
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : `MCP v2 request failed (${response.status})`;
        throw new Error(message);
      }
      setV2Payload(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "MCP v2 request failed";
      setV2Error(message);
      setV2Payload(null);
    } finally {
      setV2Loading(false);
    }
  }, [slug, v2Budget, v2Query, v2SkinTone]);

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
  const statusClass = useMemo(() => {
    const tone = statusTone(statusLabel);
    const toneClass: Record<Tone, string> = {
      ok: styles.pillOk,
      error: styles.pillError,
      warn: styles.pillWarn,
      neutral: styles.pillNeutral
    };
    return `${styles.pill} ${toneClass[tone]}`;
  }, [statusLabel]);
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
  const compactResults = useMemo(() => extractCompactResults(v2Payload), [v2Payload]);
  const compactSummary = useMemo(() => {
    const root = asRecord(v2Payload);
    return toStringValue(root?.summary) ?? "Run a v2 search to preview compact ranked output.";
  }, [v2Payload]);
  const compactTruncated = useMemo(() => {
    const root = asRecord(v2Payload);
    return toBooleanValue(root?.truncated);
  }, [v2Payload]);
  const compactCacheHit = useMemo(() => {
    const root = asRecord(v2Payload);
    return toBooleanValue(root?.cache_hit);
  }, [v2Payload]);

  const toggleVariants = useCallback((key: string) => {
    setExpandedVariants((prev) => ({
      ...prev,
      [key]: !prev[key]
    }));
  }, []);

  return (
    <div className={styles.shell}>
      <div className={styles.frame}>
        <header className={styles.hero}>
          <div className={styles.heroTop}>
            <p className={styles.eyebrow}>ShopMCP Ops</p>
            <Link href="/" className={styles.backLink}>
              Index another store
            </Link>
          </div>

          <h1 className={styles.title}>{storeName}</h1>

          <div className={styles.metaRow}>
            <span>
              <strong>Slug:</strong> {slug}
            </span>
            <span>
              <strong>URL:</strong>{" "}
              {storeUrl ? (
                <a className={styles.inlineLink} href={storeUrl} target="_blank" rel="noreferrer">
                  {storeUrl}
                </a>
              ) : (
                "-"
              )}
            </span>
            <span>
              <strong>Last check:</strong> {formatDate(statusCheckedAt ?? undefined)}
            </span>
            <span className={statusClass}>{statusLabel}</span>
          </div>
        </header>

        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2>Coverage Analysis</h2>
          </div>

          {statusError ? <p className={styles.errorBox}>{statusError}</p> : null}

          <div className={styles.metricsGrid}>
            <article className={styles.metricCard}>
              <p className={styles.metricLabel}>Discovered Pages</p>
              <p className={styles.metricValue}>{metrics.discovered ?? "-"}</p>
            </article>
            <article className={styles.metricCard}>
              <p className={styles.metricLabel}>Indexed Pages</p>
              <p className={styles.metricValue}>{metrics.indexed ?? "-"}</p>
            </article>
            <article className={styles.metricCard}>
              <p className={styles.metricLabel}>Failed Pages</p>
              <p className={styles.metricValue}>{metrics.failed ?? "-"}</p>
            </article>
            <article className={styles.metricCard}>
              <p className={styles.metricLabel}>Coverage</p>
              <p className={styles.metricValue}>
                {typeof metrics.coverage === "number" ? `${metrics.coverage.toFixed(1)}%` : "-"}
              </p>
            </article>
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2>MCP v2 Quick Test</h2>
            <span className={styles.rowCount}>Compact top-5 output</span>
          </div>

          <div className={styles.v2Controls}>
            <label className={styles.v2Field}>
              Query
              <input
                value={v2Query}
                onChange={(event) => setV2Query(event.target.value)}
                placeholder="lip tint"
              />
            </label>
            <label className={styles.v2Field}>
              Budget max (cents)
              <input
                value={v2Budget}
                onChange={(event) => setV2Budget(event.target.value)}
                placeholder="5000"
              />
            </label>
            <label className={styles.v2Field}>
              Skin tone hint
              <input
                value={v2SkinTone}
                onChange={(event) => setV2SkinTone(event.target.value)}
                placeholder="dark"
              />
            </label>
            <button
              type="button"
              className={styles.v2Button}
              onClick={() => {
                void runV2Search();
              }}
              disabled={v2Loading || v2Query.trim().length === 0}
            >
              {v2Loading ? "Running..." : "Run v2 Search"}
            </button>
          </div>

          {v2Error ? <p className={styles.errorBox}>{v2Error}</p> : null}

          <p className={styles.v2Summary}>{compactSummary}</p>
          <div className={styles.metaRow}>
            <span>
              <strong>Results:</strong> {compactResults.length}
            </span>
            <span>
              <strong>Truncated:</strong> {compactTruncated ? "yes" : "no"}
            </span>
            <span>
              <strong>Cache hit:</strong> {compactCacheHit ? "yes" : "no"}
            </span>
          </div>

          <div className={styles.v2ResultGrid}>
            {compactResults.length === 0 ? (
              <p className={styles.muted}>No compact results yet.</p>
            ) : (
              compactResults.map((result) => (
                <article key={`${result.handle}-${result.rank}`} className={styles.v2Card}>
                  <p className={styles.v2CardTitle}>
                    #{result.rank}{" "}
                    <a className={styles.tableLink} href={result.url} target="_blank" rel="noreferrer">
                      {result.title}
                    </a>
                  </p>
                  <p className={styles.v2CardMeta}>
                    <strong>{formatPriceRange(result.priceMin, result.priceMax)}</strong> ·{" "}
                    {result.available ? "available" : "unavailable"} · {result.handle}
                  </p>
                  {result.summaryShort ? <p className={styles.v2CardMeta}>{result.summaryShort}</p> : null}
                  {result.whyMatch ? <p className={styles.v2CardMeta}>{result.whyMatch}</p> : null}
                  {result.fitSignals.length > 0 ? (
                    <p className={styles.v2CardSignals}>{result.fitSignals.join(" · ")}</p>
                  ) : null}
                </article>
              ))
            )}
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2>Indexed Products</h2>
            <span className={styles.rowCount}>{manifestProducts.length} rows</span>
          </div>

          {productsError ? <p className={styles.errorBox}>{productsError}</p> : null}

          <div className={styles.metaRow}>
            <span>
              <strong>Last refresh:</strong> {formatDate(productsCheckedAt ?? undefined)}
            </span>
            <span>
              <strong>Categories:</strong> {categoryRows.length}
            </span>
          </div>

          <div className={styles.summaryGrid}>
            <article className={styles.metricCard}>
              <p className={styles.metricLabel}>Indexed Products</p>
              <p className={styles.metricValue}>{manifestSummary.indexedProducts}</p>
            </article>
            <article className={styles.metricCard}>
              <p className={styles.metricLabel}>Available</p>
              <p className={styles.metricValue}>{manifestSummary.availableProducts}</p>
            </article>
            <article className={styles.metricCard}>
              <p className={styles.metricLabel}>Unavailable</p>
              <p className={styles.metricValue}>{manifestSummary.unavailableProducts}</p>
            </article>
            <article className={styles.metricCard}>
              <p className={styles.metricLabel}>Total Variants</p>
              <p className={styles.metricValue}>{manifestSummary.totalVariants}</p>
            </article>
            <article className={styles.metricCard}>
              <p className={styles.metricLabel}>Avg Variants/Product</p>
              <p className={styles.metricValue}>{manifestSummary.avgVariantsPerProduct.toFixed(2)}</p>
            </article>
          </div>

          <div className={styles.productsGrid}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <colgroup>
                  <col className={styles.colProduct} />
                  <col className={styles.colCategory} />
                  <col className={styles.colPrice} />
                  <col className={styles.colAvailability} />
                  <col className={styles.colVariants} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Category</th>
                    <th>Price</th>
                    <th>Availability</th>
                    <th>Variants</th>
                  </tr>
                </thead>
                <tbody>
                  {manifestProducts.length === 0 ? (
                    <tr>
                      <td colSpan={5} className={styles.emptyState}>
                        No indexed products available yet.
                      </td>
                    </tr>
                  ) : (
                    manifestProducts.map((product) => {
                      const rowKey = `${product.handle}-${product.url}`;
                      const isExpanded = expandedVariants[rowKey] === true;
                      const hasVariants = product.variants.length > 0;

                      return (
                        <Fragment key={rowKey}>
                          <tr>
                            <td className={styles.productCell}>
                              <a className={styles.tableLink} href={product.url} target="_blank" rel="noreferrer">
                                {product.title}
                              </a>
                              <p className={styles.productMeta}>
                                <strong>URL:</strong>{" "}
                                <a
                                  className={`${styles.tableLink} ${styles.urlLink}`}
                                  href={product.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {product.url}
                                </a>
                              </p>
                              <p className={`${styles.productMeta} ${styles.mono}`}>
                                <strong>Handle:</strong> {product.handle}
                              </p>
                            </td>
                            <td>{product.category}</td>
                            <td>{formatPriceRange(product.priceMin, product.priceMax)}</td>
                            <td>
                              <span
                                className={`${styles.pill} ${product.available ? styles.pillOk : styles.pillError}`}
                              >
                                {product.available ? "available" : "unavailable"}
                              </span>
                            </td>
                            <td>
                              {hasVariants ? (
                                <button
                                  type="button"
                                  className={`${styles.variantToggle} ${isExpanded ? styles.variantToggleActive : ""}`}
                                  onClick={() => toggleVariants(rowKey)}
                                >
                                  {isExpanded ? "Hide" : "Show"} {product.variantCount}{" "}
                                  {product.variantCount === 1 ? "variant" : "variants"}
                                </button>
                              ) : product.variantCount > 0 ? (
                                String(product.variantCount)
                              ) : (
                                "-"
                              )}
                            </td>
                          </tr>

                          {hasVariants && isExpanded ? (
                            <tr className={styles.variantExpandedRow}>
                              <td colSpan={5} className={styles.variantExpandedCell}>
                                <div className={styles.variantExpandedInner}>
                                  <p className={styles.variantExpandedTitle}>
                                    Variant details for <strong>{product.title}</strong>
                                  </p>
                                  <ul className={styles.variantList}>
                                    {product.variants.map((variant, index) => {
                                      const optionsText = formatVariantOptions(variant.options);
                                      const priceText =
                                        variant.priceCents !== null
                                          ? formatCents(variant.priceCents)
                                          : "price unavailable";
                                      const compareText =
                                        variant.compareAtCents !== null &&
                                        variant.priceCents !== null &&
                                        variant.compareAtCents > variant.priceCents
                                          ? formatCents(variant.compareAtCents)
                                          : null;
                                      const availabilityLabel =
                                        variant.available === null
                                          ? "availability unknown"
                                          : variant.available
                                            ? "available"
                                            : "unavailable";
                                      const availabilityClass =
                                        variant.available === null
                                          ? styles.pillNeutral
                                          : variant.available
                                            ? styles.pillOk
                                            : styles.pillError;

                                      return (
                                        <li key={`${product.handle}-${variant.id ?? index}`} className={styles.variantItem}>
                                          <div className={styles.variantTopRow}>
                                            <strong>{variant.title ?? `Variant ${index + 1}`}</strong>
                                            <span className={styles.variantPriceWrap}>
                                              <span>{priceText}</span>
                                              {compareText ? (
                                                <span className={styles.variantCompare}>{compareText}</span>
                                              ) : null}
                                            </span>
                                          </div>
                                          <div className={styles.variantMetaRow}>
                                            <span className={`${styles.pill} ${availabilityClass}`}>
                                              {availabilityLabel}
                                            </span>
                                            {variant.currency ? <span>{variant.currency}</span> : null}
                                            {variant.sku ? <span>SKU: {variant.sku}</span> : null}
                                          </div>
                                          {optionsText ? <p className={styles.variantOptions}>{optionsText}</p> : null}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <aside className={styles.categoryPanel}>
              <h3>Category Breakdown</h3>
              {categoryRows.length === 0 ? (
                <p className={styles.muted}>No category data.</p>
              ) : (
                <ul className={styles.categoryList}>
                  {categoryRows.map(([name, count]) => (
                    <li key={name} className={styles.categoryRow}>
                      <span className={styles.categoryName}>{name}</span>
                      <span className={styles.categoryCount}>{count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          </div>
        </section>
      </div>
    </div>
  );
}
