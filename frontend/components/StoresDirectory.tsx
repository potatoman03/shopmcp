"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDate, toIsoNow } from "@/lib/utils";
import styles from "@/components/StoresDirectory.module.css";
import SiteHeader from "@/components/SiteHeader";

type StatusTone = "ok" | "warn" | "error" | "neutral";

interface DirectoryStore {
  slug: string;
  storeName: string;
  url: string;
  platform: string;
  status: string;
  productCount: number;
  coverage: number | null;
  indexedAt?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function computeCoverage(metrics: unknown): number | null {
  const record = asRecord(metrics);
  if (!record) {
    return null;
  }

  const discovered = toNumberValue(record.discovered_urls);
  const crawled = toNumberValue(record.crawled_urls);
  if (discovered !== null && crawled !== null && discovered > 0) {
    return (Math.min(crawled, discovered) / discovered) * 100;
  }

  return null;
}

function parseStores(payload: unknown): { total: number; stores: DirectoryStore[] } {
  const root = asRecord(payload);
  const total = toNumberValue(root?.total) ?? 0;
  const rows = Array.isArray(root?.stores) ? root.stores : [];

  const stores: DirectoryStore[] = [];
  for (const raw of rows) {
    const store = asRecord(raw);
    if (!store) {
      continue;
    }

    const slug = toStringValue(store.slug);
    const storeName = toStringValue(store.store_name);
    const url = toStringValue(store.url);
    if (!slug || !storeName || !url) {
      continue;
    }

    stores.push({
      slug,
      storeName,
      url,
      platform: toStringValue(store.platform) ?? "unknown",
      status: toStringValue(store.status) ?? "unknown",
      productCount: toNumberValue(store.product_count) ?? 0,
      coverage: computeCoverage(store.metrics),
      indexedAt: toStringValue(store.indexed_at) ?? undefined
    });
  }

  return { total, stores };
}

function toneForStatus(status: string): StatusTone {
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

export default function StoresDirectory(): JSX.Element {
  const [stores, setStores] = useState<DirectoryStore[]>([]);
  const [total, setTotal] = useState(0);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pullStores = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/stores?limit=500&offset=0", {
        method: "GET",
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof payload?.error === "string" ? payload.error : `Stores request failed (${response.status})`;
        throw new Error(message);
      }

      const parsed = parseStores(payload);
      setStores(parsed.stores);
      setTotal(parsed.total);
      setError(null);
      setCheckedAt(toIsoNow());
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Unable to fetch stores";
      setError(message);
      setCheckedAt(toIsoNow());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void pullStores();
    const timer = window.setInterval(() => {
      void pullStores();
    }, 7000);

    return () => {
      window.clearInterval(timer);
    };
  }, [pullStores]);

  const stats = useMemo(() => {
    let running = 0;
    let completed = 0;
    let failed = 0;
    for (const store of stores) {
      const tone = toneForStatus(store.status);
      if (tone === "warn") {
        running += 1;
      } else if (tone === "ok") {
        completed += 1;
      } else if (tone === "error") {
        failed += 1;
      }
    }

    return { running, completed, failed };
  }, [stores]);

  return (
    <div className={styles.shell}>
      <SiteHeader active="stores" />
      <div className={styles.frame}>
        <header className={styles.hero}>
          <p className={styles.eyebrow}>ShopMCP Directory</p>
          <h1 className={styles.title}>Indexed Stores</h1>
          <div className={styles.metaRow}>
            <span>
              <strong>Total stores:</strong> {total}
            </span>
            <span>
              <strong>Running:</strong> {stats.running}
            </span>
            <span>
              <strong>Completed:</strong> {stats.completed}
            </span>
            <span>
              <strong>Failed:</strong> {stats.failed}
            </span>
            <span>
              <strong>Last check:</strong> {formatDate(checkedAt ?? undefined)}
            </span>
          </div>
          <div className={styles.actions}>
            <Link href="/" className={styles.primaryAction}>
              Index New Store
            </Link>
            <button type="button" className={styles.secondaryAction} onClick={() => void pullStores()}>
              Refresh
            </button>
          </div>
        </header>

        {error ? <p className={styles.errorBox}>{error}</p> : null}

        <section className={styles.listSection}>
          {loading && stores.length === 0 ? <p className={styles.muted}>Loading stores...</p> : null}
          {!loading && stores.length === 0 ? (
            <p className={styles.muted}>No indexed stores yet. Index one from the home page.</p>
          ) : null}

          <div className={styles.list}>
            {stores.map((store) => {
              const tone = toneForStatus(store.status);
              const toneClass =
                tone === "ok"
                  ? styles.pillOk
                  : tone === "warn"
                    ? styles.pillWarn
                    : tone === "error"
                      ? styles.pillError
                      : styles.pillNeutral;
              const coverageText =
                typeof store.coverage === "number" ? `${store.coverage.toFixed(1)}%` : "-";

              return (
                <article key={store.slug} className={styles.card}>
                  <div className={styles.cardTop}>
                    <div>
                      <h2 className={styles.storeName}>{store.storeName}</h2>
                      <p className={styles.storeMeta}>
                        <span className={styles.mono}>{store.slug}</span> • {store.platform}
                      </p>
                    </div>
                    <span className={`${styles.pill} ${toneClass}`}>{store.status}</span>
                  </div>

                  <p className={styles.urlRow}>
                    <a className={styles.inlineLink} href={store.url} target="_blank" rel="noreferrer">
                      {store.url}
                    </a>
                  </p>

                  <div className={styles.cardMetrics}>
                    <span>
                      <strong>Products:</strong> {store.productCount}
                    </span>
                    <span>
                      <strong>Coverage:</strong> {coverageText}
                    </span>
                    <span>
                      <strong>Last indexed:</strong> {formatDate(store.indexedAt)}
                    </span>
                  </div>

                  <div className={styles.cardActions}>
                    <Link href={`/ops/${encodeURIComponent(store.slug)}`} className={styles.cardAction}>
                      Open Ops
                    </Link>
                    <a
                      href={`http://localhost:8000/mcp/${encodeURIComponent(store.slug)}/sse`}
                      target="_blank"
                      rel="noreferrer"
                      className={styles.cardActionAlt}
                    >
                      MCP SSE
                    </a>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
