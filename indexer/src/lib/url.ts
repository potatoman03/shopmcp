const TRACKING_PARAM_PATTERN = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i;
const SHOPIFY_LOCALE_PRODUCT_PATH_PATTERN = /^\/(?:[a-z]{2}(?:-[a-z]{2})?|undefined-undefined)\/(products?\/.+)$/i;

export function normalizeUrl(input: string, base?: string): string | null {
  let parsed: URL;

  try {
    parsed = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }

  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return null;
  }

  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();

  if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) {
    parsed.port = "";
  }

  const keptParams: Array<[string, string]> = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    if (!TRACKING_PARAM_PATTERN.test(key)) {
      keptParams.push([key, value]);
    }
  }

  keptParams.sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey === bKey) {
      return aValue.localeCompare(bValue);
    }
    return aKey.localeCompare(bKey);
  });

  parsed.search = "";
  for (const [key, value] of keptParams) {
    parsed.searchParams.append(key, value);
  }

  let pathname = parsed.pathname.replace(/\/+/g, "/");
  if (pathname !== "/") {
    pathname = pathname.replace(/\/+$/, "");
  }
  const localeProductMatch = pathname.match(SHOPIFY_LOCALE_PRODUCT_PATH_PATTERN);
  if (localeProductMatch) {
    pathname = `/${localeProductMatch[1]}`;
  }
  parsed.pathname = pathname;

  const lowerPath = parsed.pathname.toLowerCase();
  if (lowerPath.includes("/products/") || lowerPath.includes("/product/")) {
    // Product URLs should collapse option/filter query variants into one canonical URL.
    parsed.search = "";
  }

  return parsed.toString();
}

export function productUrlScore(candidateUrl: string): number {
  let score = 0;
  let parsed: URL;

  try {
    parsed = new URL(candidateUrl);
  } catch {
    return score;
  }

  const pathname = parsed.pathname.toLowerCase();

  if (pathname.includes("/products/")) {
    score += 100;
  }
  if (pathname.includes("/product/")) {
    score += 80;
  }
  if (pathname.includes("/collections/")) {
    score += 8;
  }
  if (pathname.includes("item") || pathname.includes("sku")) {
    score += 15;
  }

  if (parsed.searchParams.has("product") || parsed.searchParams.has("sku")) {
    score += 20;
  }

  if (/\b(variant|color|size)=/i.test(parsed.search)) {
    score += 5;
  }

  return score;
}

export function prioritizeUrls(urls: string[]): string[] {
  return [...urls].sort((left, right) => {
    const scoreDelta = productUrlScore(right) - productUrlScore(left);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return left.localeCompare(right);
  });
}
