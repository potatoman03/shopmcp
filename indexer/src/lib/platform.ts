export type Platform = "shopify" | "html" | "unknown";

const SHOPIFY_MARKERS = [
  "cdn.shopify.com",
  "shopify-section",
  "Shopify.theme",
  "x-shopify-stage",
  "/products.json"
];

export function detectPlatformByHostname(storeUrl: string): Platform {
  try {
    const hostname = new URL(storeUrl).hostname.toLowerCase();
    if (hostname.endsWith(".myshopify.com")) {
      return "shopify";
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}

export async function detectPlatform(
  storeUrl: string,
  fetchHtml: (url: string) => Promise<string | null>
): Promise<Platform> {
  const byHost = detectPlatformByHostname(storeUrl);
  if (byHost === "shopify") {
    return byHost;
  }

  // Probe public Shopify catalog endpoint first.
  const productsProbe = await fetchHtml(`${storeUrl.replace(/\/+$/, "")}/products.json?limit=1`);
  if (productsProbe) {
    const normalized = productsProbe.trim().toLowerCase();
    if (normalized.startsWith("{") && normalized.includes("\"products\"")) {
      return "shopify";
    }
  }

  const html = await fetchHtml(storeUrl);
  if (!html) {
    return "unknown";
  }

  const haystack = html.toLowerCase();
  if (SHOPIFY_MARKERS.some((marker) => haystack.includes(marker.toLowerCase()))) {
    return "shopify";
  }

  return "html";
}
