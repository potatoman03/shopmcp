"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState, type CSSProperties } from "react";
import { formatDate, parseSlugFromResponse, slugify } from "@/lib/utils";
import styles from "@/components/MerchantLanding.module.css";
import SiteHeader from "@/components/SiteHeader";

function normalizeInputUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function deriveStoreName(urlValue: string): string {
  const normalized = normalizeInputUrl(urlValue);
  try {
    const hostname = new URL(normalized).hostname.replace(/^www\./i, "");
    const label = hostname.split(".")[0] ?? "Store";
    return label
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(" ");
  } catch {
    return "Store";
  }
}

type HeroStatus = "hidden" | "scanning" | "parsing" | "indexing" | "complete" | "existing" | "error";

interface ExistingStoreStatus {
  slug: string;
  status: string;
  productCount: number;
  lastIndexed?: string;
}

interface PendingIndexRequest {
  slug: string;
  normalizedUrl: string;
  storeName: string;
}

interface TileSpec {
  delay: number;
  shapeStyle: CSSProperties;
}

const TILE_SPECS: TileSpec[] = [
  { delay: 0.1, shapeStyle: { background: "var(--accent-pink)", clipPath: "circle(100% at 0 0)" } },
  {
    delay: 0.2,
    shapeStyle: {
      background: "linear-gradient(to bottom, var(--accent-purple), transparent)",
      clipPath: "inset(0)"
    }
  },
  { delay: 0.3, shapeStyle: { background: "var(--accent-faded)", clipPath: "circle(100% at 100% 100%)" } },
  {
    delay: 0.4,
    shapeStyle: {
      background: "var(--accent-pink)",
      opacity: 0.3,
      clipPath: "circle(80% at 50% 50%)",
      border: "1px solid var(--accent-pink)"
    }
  },
  { delay: 0.5, shapeStyle: { background: "var(--accent-purple)", opacity: 0.4, borderRadius: "50%" } },
  { delay: 0.6, shapeStyle: { background: "var(--accent-pink)", clipPath: "circle(100% at 100% 0)" } },
  {
    delay: 0.7,
    shapeStyle: { background: "transparent", border: "2px solid var(--accent-purple)", borderRadius: "50%" }
  },
  {
    delay: 0.8,
    shapeStyle: { background: "var(--accent-purple)", clipPath: "polygon(0 0, 0% 100%, 100% 0)" }
  },
  { delay: 0.9, shapeStyle: { background: "var(--accent-faded)", clipPath: "circle(100% at 0 100%)" } },
  {
    delay: 1.0,
    shapeStyle: {
      background: "var(--accent-pink)",
      opacity: 0.2,
      clipPath: "inset(10% round 10%)",
      border: "1px solid var(--accent-pink)"
    }
  },
  { delay: 1.1, shapeStyle: { background: "var(--accent-pink)", clipPath: "circle(100% at 0 0)" } },
  { delay: 1.2, shapeStyle: { background: "linear-gradient(45deg, var(--accent-purple), transparent)" } },
  {
    delay: 1.3,
    shapeStyle: { background: "transparent", border: "2px solid var(--accent-pink)", clipPath: "circle(100% at 100% 100%)" }
  },
  { delay: 1.4, shapeStyle: { background: "var(--accent-purple)", opacity: 0.6, clipPath: "circle(100% at 50% 100%)" } },
  { delay: 1.5, shapeStyle: { background: "var(--accent-pink)", clipPath: "circle(60% at 50% 50%)" } },
  { delay: 1.6, shapeStyle: { background: "var(--accent-faded)", clipPath: "circle(100% at 100% 0)" } }
];

const STATUS_LABELS: Record<Exclude<HeroStatus, "hidden">, string> = {
  scanning: "Scanning schema...",
  parsing: "Parsing products...",
  indexing: "Indexing to MCP...",
  complete: "Index ready",
  existing: "Store already indexed",
  error: "Index request failed"
};

export default function MerchantLanding(): JSX.Element {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingStore, setExistingStore] = useState<ExistingStoreStatus | null>(null);
  const [pendingRequest, setPendingRequest] = useState<PendingIndexRequest | null>(null);
  const [heroStatus, setHeroStatus] = useState<HeroStatus>("hidden");

  const inferredName = useMemo(() => deriveStoreName(url), [url]);

  useEffect(() => {
    if (!submitting) {
      return;
    }

    setHeroStatus("scanning");
    const parsingTimer = window.setTimeout(() => {
      setHeroStatus((prev) => (prev === "scanning" ? "parsing" : prev));
    }, 1300);
    const indexingTimer = window.setTimeout(() => {
      setHeroStatus((prev) => (prev === "scanning" || prev === "parsing" ? "indexing" : prev));
    }, 2800);

    return () => {
      window.clearTimeout(parsingTimer);
      window.clearTimeout(indexingTimer);
    };
  }, [submitting]);

  useEffect(() => {
    if (heroStatus !== "complete" && heroStatus !== "existing" && heroStatus !== "error") {
      return;
    }
    const timer = window.setTimeout(() => {
      setHeroStatus("hidden");
    }, 2400);

    return () => {
      window.clearTimeout(timer);
    };
  }, [heroStatus]);

  async function submitIndex(
    normalizedUrl: string,
    storeName: string,
    fallbackSlug: string,
    forceReindex: boolean
  ): Promise<void> {
    try {
      const response = await fetch("/api/index", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          store_name: storeName,
          url: normalizedUrl,
          force_reindex: forceReindex
        })
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof payload?.error === "string" ? payload.error : `Index request failed (${response.status})`;
        throw new Error(message);
      }

      setHeroStatus("complete");
      const slug = parseSlugFromResponse(payload, fallbackSlug);
      router.push(`/ops/${encodeURIComponent(slug)}`);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Unable to submit";
      setHeroStatus("error");
      setError(message);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!url.trim()) {
      return;
    }

    setSubmitting(true);
    setError(null);
    setExistingStore(null);
    setPendingRequest(null);
    setHeroStatus("scanning");

    try {
      const normalizedUrl = normalizeInputUrl(url);
      const storeName = inferredName || "Store";
      const fallbackSlug = slugify(storeName || normalizedUrl) || "store";

      const statusResponse = await fetch(`/api/status/${encodeURIComponent(fallbackSlug)}`, {
        method: "GET",
        cache: "no-store"
      });
      const statusPayload = await statusResponse.json().catch(() => ({}));

      if (statusResponse.ok) {
        const resolvedSlug = parseSlugFromResponse(statusPayload, fallbackSlug);
        setExistingStore({
          slug: resolvedSlug,
          status: typeof statusPayload?.status === "string" ? statusPayload.status : "indexed",
          productCount: typeof statusPayload?.product_count === "number" ? statusPayload.product_count : 0,
          lastIndexed: typeof statusPayload?.last_indexed === "string" ? statusPayload.last_indexed : undefined
        });
        setPendingRequest({
          slug: resolvedSlug,
          normalizedUrl,
          storeName
        });
        setHeroStatus("existing");
        setSubmitting(false);
        return;
      }

      if (statusResponse.status !== 404 && typeof statusPayload?.error === "string") {
        throw new Error(statusPayload.error);
      }

      await submitIndex(normalizedUrl, storeName, fallbackSlug, false);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Unable to submit";
      setHeroStatus("error");
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  function onDismissExisting(): void {
    setExistingStore(null);
    setPendingRequest(null);
    setHeroStatus("hidden");
  }

  function onViewExisting(): void {
    if (!existingStore) {
      return;
    }
    router.push(`/ops/${encodeURIComponent(existingStore.slug)}`);
  }

  async function onForceReindex(): Promise<void> {
    if (!pendingRequest) {
      return;
    }
    setSubmitting(true);
    setError(null);
    setHeroStatus("scanning");
    await submitIndex(pendingRequest.normalizedUrl, pendingRequest.storeName, pendingRequest.slug, true);
    setSubmitting(false);
  }

  const showStatusBadge = heroStatus !== "hidden";
  const statusText = heroStatus === "hidden" ? "" : STATUS_LABELS[heroStatus];
  const isProcessing = submitting || heroStatus === "scanning" || heroStatus === "parsing" || heroStatus === "indexing";
  const isComplete = heroStatus === "complete";

  return (
    <div className={styles.shell}>
      <SiteHeader active="home" />

      <main className={styles.main}>
        <section className={styles.content}>
          <h1 className={styles.displayText}>
            Make your store
            <br />
            agent-ready in
            <br />
            one index run
          </h1>
          <p className={styles.bodyText}>
            ShopMCP converts storefront pages, sitemaps, and product structures into fast MCP-native tools. Agents can
            query products, variants, pricing, and stock without browser scraping.
          </p>

          <form className={styles.inputGroup} onSubmit={onSubmit}>
            <input
              type="url"
              placeholder="https://your-store.com"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                if (existingStore) {
                  setExistingStore(null);
                  setPendingRequest(null);
                }
              }}
              aria-label="Store URL"
              required
            />
            <button type="submit" className={styles.cta} disabled={submitting}>
              {submitting ? "Connecting..." : "Index Store"}
            </button>
          </form>

          <div className={styles.signalRow}>
            <span>• Sitemap-First Discovery</span>
            <span>• Variant-Level Availability</span>
            <span>• Hybrid Search Ready</span>
          </div>

          {existingStore ? (
            <section className={styles.existingBox}>
              <p className={styles.existingTitle}>Store already indexed</p>
              <p>
                <strong>Slug:</strong> {existingStore.slug}
              </p>
              <p>
                <strong>Status:</strong> {existingStore.status}
              </p>
              <p>
                <strong>Products:</strong> {existingStore.productCount}
              </p>
              <p>
                <strong>Last indexed:</strong> {formatDate(existingStore.lastIndexed)}
              </p>
              <div className={styles.existingActions}>
                <button type="button" className={styles.secondaryBtn} onClick={onViewExisting} disabled={submitting}>
                  View Existing
                </button>
                <button type="button" className={styles.cta} onClick={onForceReindex} disabled={submitting}>
                  {submitting ? "Reindexing..." : "Force Reindex"}
                </button>
                <button type="button" className={styles.ghostBtn} onClick={onDismissExisting} disabled={submitting}>
                  Cancel
                </button>
              </div>
            </section>
          ) : null}

          {error ? <p className={styles.errorBox}>{error}</p> : null}
        </section>

        <section className={styles.visualContainer} aria-hidden="true">
          {TILE_SPECS.map((tile, index) => (
            <div
              key={`tile-${index + 1}`}
              className={`${styles.tile} ${isProcessing ? styles.processing : ""} ${isComplete && index % 2 === 0 ? styles.complete : ""}`}
              style={{ animationDelay: `${tile.delay}s` }}
            >
              <div className={styles.shape} style={tile.shapeStyle} />
            </div>
          ))}

          <div className={`${styles.statusBadge} ${showStatusBadge ? styles.statusVisible : ""}`}>
            <div className={styles.statusDot} />
            <span>{statusText}</span>
          </div>
        </section>
      </main>

      <section className={styles.explainer}>
        <div className={styles.explainerIntro}>
          <h2>What ShopMCP does</h2>
          <p>
            ShopMCP turns storefronts into agent-accessible infrastructure. Instead of brittle browser automation, your
            catalog is normalized, indexed, and exposed through structured MCP tools.
          </p>
        </div>
        <div className={styles.explainerGrid}>
          <article className={styles.explainerCard}>
            <h3>Catalog Ingestion</h3>
            <p>
              Crawls sitemaps, public commerce feeds, and HTML product pages to capture products, prices, descriptions,
              variants, and availability.
            </p>
          </article>
          <article className={styles.explainerCard}>
            <h3>Context-Safe Indexing</h3>
            <p>
              Normalizes messy store data into one schema so agents can reliably query by category, budget, size,
              color, and stock state.
            </p>
          </article>
          <article className={styles.explainerCard}>
            <h3>MCP-Native Access</h3>
            <p>
              Publishes each store as an MCP endpoint so assistants can search, filter, and verify variant-level
              inventory in milliseconds.
            </p>
          </article>
          <article className={styles.explainerCard}>
            <h3>What It Aims To Achieve</h3>
            <p>
              Make every e-commerce store operable by AI agents with fast, auditable product retrieval and fewer
              hallucinations during shopping flows.
            </p>
          </article>
        </div>
      </section>
    </div>
  );
}
