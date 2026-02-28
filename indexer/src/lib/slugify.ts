import { createHash } from "node:crypto";

export function slugifyText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function slugifyStore(input: string): string {
  const trimmed = input.trim();
  let candidate = trimmed;

  try {
    const parsed = new URL(trimmed);
    candidate = parsed.hostname;
  } catch {
    candidate = trimmed;
  }

  candidate = candidate.replace(/^www\./i, "").toLowerCase();

  if (candidate.endsWith(".myshopify.com")) {
    const [shop] = candidate.split(".");
    if (shop) {
      candidate = shop;
    }
  }

  const slug = slugifyText(candidate);
  if (slug.length > 0) {
    return slug;
  }

  const digest = createHash("sha1").update(trimmed).digest("hex").slice(0, 8);
  return `store-${digest}`;
}
