"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { parseSlugFromResponse, slugify } from "@/lib/utils";
import styles from "@/components/MerchantLanding.module.css";

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

export default function MerchantLanding(): JSX.Element {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inferredName = useMemo(() => deriveStoreName(url), [url]);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!url.trim()) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const normalizedUrl = normalizeInputUrl(url);
      const storeName = inferredName || "Store";

      const response = await fetch("/api/index", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          store_name: storeName,
          url: normalizedUrl
        })
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof payload?.error === "string" ? payload.error : `Index request failed (${response.status})`;
        throw new Error(message);
      }

      const fallbackSlug = slugify(storeName || normalizedUrl) || "store";
      const slug = parseSlugFromResponse(payload, fallbackSlug);
      router.push(`/ops/${encodeURIComponent(slug)}`);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Unable to submit";
      setError(message);
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
  }

  return (
    <div className={styles.shell}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>ShopMCP</p>
        <h1 className={styles.title}>Index your store for MCP</h1>
        <p className={styles.subtitle}>
          Enter your storefront URL. You will be redirected to ops with slug, coverage analysis, and indexed products.
        </p>

        <form className={styles.form} onSubmit={onSubmit}>
          <input
            type="text"
            className={styles.input}
            placeholder="https://your-store.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            aria-label="Store URL"
            required
          />
          <button className={styles.button} type="submit" disabled={submitting}>
            {submitting ? "Indexing..." : "Index Store"}
          </button>
        </form>

        {error ? <p className={styles.error}>{error}</p> : null}
      </section>
    </div>
  );
}
