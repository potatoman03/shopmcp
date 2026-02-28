"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { StoreRow } from "@/lib/types";
import {
  RECENT_STORES_KEY,
  extractCoverage,
  extractStatus,
  formatDate,
  parseSlugFromResponse,
  slugify,
  toIsoNow
} from "@/lib/utils";

function readStoredRows(): StoreRow[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = localStorage.getItem(RECENT_STORES_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((entry): entry is StoreRow => {
        return (
          entry &&
          typeof entry === "object" &&
          typeof entry.slug === "string" &&
          typeof entry.store_name === "string" &&
          typeof entry.url === "string" &&
          typeof entry.status === "string" &&
          typeof entry.created_at === "string"
        );
      })
      .slice(0, 20);
  } catch {
    return [];
  }
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

export default function HomeDashboard(): JSX.Element {
  const [storeName, setStoreName] = useState("");
  const [url, setUrl] = useState("");
  const [recent, setRecent] = useState<StoreRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recentRef = useRef<StoreRow[]>([]);

  useEffect(() => {
    setRecent(readStoredRows());
  }, []);

  useEffect(() => {
    recentRef.current = recent;
    if (typeof window !== "undefined") {
      localStorage.setItem(RECENT_STORES_KEY, JSON.stringify(recent.slice(0, 20)));
    }
  }, [recent]);

  const pollStatuses = useCallback(async (): Promise<void> => {
    const rows = recentRef.current;
    if (!rows.length) {
      return;
    }

    const patches = await Promise.all(
      rows.map(async (row) => {
        try {
          const response = await fetch(`/api/status/${encodeURIComponent(row.slug)}`, {
            method: "GET",
            cache: "no-store"
          });

          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            return {
              slug: row.slug,
              status: `error (${response.status})`,
              last_checked: toIsoNow()
            };
          }

          return {
            slug: row.slug,
            status: extractStatus(payload),
            coverage: extractCoverage(payload),
            last_checked: toIsoNow()
          };
        } catch {
          return {
            slug: row.slug,
            status: "offline",
            last_checked: toIsoNow()
          };
        }
      })
    );

    const patchMap = new Map(patches.map((patch) => [patch.slug, patch]));

    setRecent((prev) =>
      prev.map((row) => {
        const patch = patchMap.get(row.slug);
        return patch ? { ...row, ...patch } : row;
      })
    );
  }, []);

  useEffect(() => {
    void pollStatuses();
    const timer = window.setInterval(() => {
      void pollStatuses();
    }, 5000);

    return () => {
      window.clearInterval(timer);
    };
  }, [pollStatuses]);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/index", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          store_name: storeName,
          url
        })
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : `Index request failed (${response.status})`;
        throw new Error(message);
      }

      const fallback = slugify(storeName || url);
      const slug = parseSlugFromResponse(payload, fallback);
      const nextRow: StoreRow = {
        slug,
        store_name: storeName,
        url,
        status: extractStatus(payload),
        coverage: extractCoverage(payload),
        created_at: toIsoNow(),
        last_checked: toIsoNow()
      };

      setRecent((prev) => [nextRow, ...prev.filter((item) => item.slug !== slug)].slice(0, 20));
      setStoreName("");
      setUrl("");
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Unable to submit";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page-shell">
      <header className="page-header">
        <h1>ShopMCP Ops Dashboard</h1>
        <p>Queue store indexing jobs and monitor live crawl progress.</p>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>Add Store</h2>
        </div>
        <form className="stack-form" onSubmit={onSubmit}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="store_name">Store Name</label>
              <input
                id="store_name"
                value={storeName}
                onChange={(event) => setStoreName(event.target.value)}
                placeholder="Acme Outfitters"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="url">Store URL</label>
              <input
                id="url"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com"
                required
              />
            </div>
          </div>

          <div className="row-end">
            <button type="submit" disabled={submitting}>
              {submitting ? "Submitting..." : "Start Indexing"}
            </button>
          </div>

          {error ? <p className="error-box">{error}</p> : null}
        </form>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Recent Stores</h2>
          <span className="muted">Auto-refresh every 5 seconds</span>
        </div>

        <div className="table-wrap">
          <table className="stores-table">
            <thead>
              <tr>
                <th>Store</th>
                <th>Slug</th>
                <th>Status</th>
                <th>Coverage</th>
                <th>Created</th>
                <th>Last Check</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recent.length ? (
                recent.map((row) => (
                  <tr key={row.slug}>
                    <td>{row.store_name}</td>
                    <td>{row.slug}</td>
                    <td>
                      <span className={`pill ${statusTone(row.status)}`}>{row.status}</span>
                    </td>
                    <td>{typeof row.coverage === "number" ? `${row.coverage.toFixed(1)}%` : "-"}</td>
                    <td>{formatDate(row.created_at)}</td>
                    <td>{formatDate(row.last_checked)}</td>
                    <td>
                      <Link className="btn-link" href={`/stores/${encodeURIComponent(row.slug)}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="muted">
                    No stores yet. Submit one above to begin.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
