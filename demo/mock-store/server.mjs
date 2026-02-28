#!/usr/bin/env node
import http from "node:http";
import { URL } from "node:url";

const PORT = Number.parseInt(process.env.PORT ?? "4300", 10) || 4300;
const HOST = process.env.HOST ?? "127.0.0.1";
const STORE_NAME = process.env.STORE_NAME ?? "Mock Demo Store";
const PRODUCT_COUNT = Math.max(1, Number.parseInt(process.env.PRODUCT_COUNT ?? "24", 10) || 24);

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toPriceCents(i) {
  return 1200 + i * 137;
}

function toMoneyString(cents) {
  return (cents / 100).toFixed(2);
}

function buildProducts() {
  const products = [];
  for (let i = 1; i <= PRODUCT_COUNT; i += 1) {
    const id = 100000 + i;
    const handle = `demo-product-${i}`;
    const priceCents = toPriceCents(i);
    const available = i % 5 !== 0;

    products.push({
      id,
      handle,
      title: `Demo Product ${i}`,
      body_html: `<p>Arbitrary product ${i} for indexer validation.</p>`,
      vendor: "DemoCo",
      product_type: i % 2 === 0 ? "Accessory" : "Footwear",
      tags: `demo,generated,batch-${(i % 4) + 1}`,
      url: `/products/${handle}`,
      options: [{ name: "Size", values: ["S", "M", "L"] }],
      variants: [
        {
          id: id * 10 + 1,
          title: "Default Title",
          sku: `SKU-${i}`,
          price: toMoneyString(priceCents),
          compare_at_price: toMoneyString(priceCents + 300),
          available,
          option1: "M"
        }
      ],
      images: [{ id: id * 100, src: `/images/${handle}.jpg` }]
    });
  }
  return products;
}

const PRODUCTS = buildProducts();

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(body);
}

function absoluteBase(req) {
  const host = req.headers.host ?? `${HOST}:${PORT}`;
  return `http://${host}`;
}

function productPageHtml(req, product) {
  const base = absoluteBase(req);
  const productUrl = `${base}/products/${product.handle}`;
  const imageUrl = `${base}${product.images[0].src}`;
  const variant = product.variants[0];
  const availability = variant.available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    productID: String(product.id),
    name: product.title,
    description: `Arbitrary product ${product.id} for indexing validation`,
    url: productUrl,
    image: imageUrl,
    brand: { "@type": "Brand", name: product.vendor },
    category: product.product_type,
    offers: {
      "@type": "Offer",
      sku: variant.sku,
      price: variant.price,
      priceCurrency: "USD",
      availability
    }
  };

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(product.title)}</title>
    <meta name="description" content="${escapeHtml(product.body_html.replace(/<[^>]+>/g, " ").trim())}" />
    <meta property="og:title" content="${escapeHtml(product.title)}" />
    <meta property="og:image" content="${escapeHtml(imageUrl)}" />
    <meta property="product:price:amount" content="${escapeHtml(variant.price)}" />
    <meta property="product:availability" content="${variant.available ? "in stock" : "out of stock"}" />
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  </head>
  <body>
    <h1>${escapeHtml(product.title)}</h1>
    <p>SKU: ${escapeHtml(variant.sku)}</p>
    <p class="price">$${escapeHtml(variant.price)}</p>
    <p>${escapeHtml(product.body_html.replace(/<[^>]+>/g, " ").trim())}</p>
  </body>
</html>`;
}

function collectionPageHtml(req) {
  const items = PRODUCTS.map(
    (product) => `<li><a href="/products/${encodeURIComponent(product.handle)}">${escapeHtml(product.title)}</a></li>`
  ).join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(STORE_NAME)} - All Products</title>
  </head>
  <body>
    <h2>${escapeHtml(STORE_NAME)} / All Products</h2>
    <ul>${items}</ul>
  </body>
</html>`;
}

function homepageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(STORE_NAME)}</title>
  </head>
  <body>
    <h2>${escapeHtml(STORE_NAME)}</h2>
    <p>Generated products: ${PRODUCT_COUNT}</p>
    <a href="/collections/all">Browse products</a>
  </body>
</html>`;
}

function buildSitemap(req) {
  const base = absoluteBase(req);
  const urls = [
    `${base}/`,
    `${base}/collections/all`,
    ...PRODUCTS.map((product) => `${base}/products/${product.handle}`)
  ];

  const entries = urls
    .map((url) => `  <url><loc>${escapeHtml(url)}</loc><lastmod>2026-02-28</lastmod></url>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;
}

function robotsTxt(req) {
  const base = absoluteBase(req);
  return `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`;
}

function listShopifyProducts(reqUrl) {
  const limit = Math.max(1, Math.min(250, Number.parseInt(reqUrl.searchParams.get("limit") ?? "250", 10) || 250));
  const sinceId = Number.parseInt(reqUrl.searchParams.get("since_id") ?? "0", 10) || 0;
  const filtered = PRODUCTS.filter((product) => product.id > sinceId).slice(0, limit);

  return {
    products: filtered
  };
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    send(res, 400, "Bad Request");
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  const path = reqUrl.pathname;

  if (path === "/" || path === "") {
    send(res, 200, homepageHtml(), "text/html; charset=utf-8");
    return;
  }

  if (path === "/robots.txt") {
    send(res, 200, robotsTxt(req), "text/plain; charset=utf-8");
    return;
  }

  if (path === "/sitemap.xml" || path === "/sitemap_products.xml") {
    send(res, 200, buildSitemap(req), "application/xml; charset=utf-8");
    return;
  }

  if (path === "/collections/all") {
    send(res, 200, collectionPageHtml(req), "text/html; charset=utf-8");
    return;
  }

  if (path === "/products.json") {
    send(res, 200, JSON.stringify(listShopifyProducts(reqUrl)), "application/json; charset=utf-8");
    return;
  }

  if (path.startsWith("/products/")) {
    const handle = decodeURIComponent(path.slice("/products/".length));
    const product = PRODUCTS.find((entry) => entry.handle === handle);
    if (!product) {
      send(res, 404, "Not Found");
      return;
    }
    send(res, 200, productPageHtml(req, product), "text/html; charset=utf-8");
    return;
  }

  if (path.startsWith("/images/")) {
    // 1x1 transparent gif
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
    res.writeHead(200, {
      "content-type": "image/gif",
      "content-length": String(gif.length),
      "cache-control": "no-store"
    });
    res.end(gif);
    return;
  }

  send(res, 404, "Not Found");
});

server.listen(PORT, HOST, () => {
  console.log(`mock-store listening on http://${HOST}:${PORT}`);
  console.log(`store_name=${STORE_NAME}`);
  console.log(`product_count=${PRODUCT_COUNT}`);
});
