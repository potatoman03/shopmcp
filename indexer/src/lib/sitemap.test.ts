import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { decodeSitemapBody, extractSitemapUrlsFromRobots, parseSitemapXml } from "./sitemap";

test("extractSitemapUrlsFromRobots parses Sitemap lines", () => {
  const robots = `
User-agent: *
Allow: /
Sitemap: https://example.com/sitemap.xml
Sitemap:https://example.com/sitemap_products.xml.gz
`;

  assert.deepEqual(extractSitemapUrlsFromRobots(robots, "https://example.com"), [
    "https://example.com/sitemap.xml",
    "https://example.com/sitemap_products.xml.gz"
  ]);
});

test("parseSitemapXml handles sitemap index", () => {
  const xml = `
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap_1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap_2.xml</loc></sitemap>
</sitemapindex>`;

  const parsed = parseSitemapXml(xml);
  assert.deepEqual(parsed.sitemaps, ["https://example.com/sitemap_1.xml", "https://example.com/sitemap_2.xml"]);
  assert.deepEqual(parsed.urls, []);
});

test("decodeSitemapBody handles gzip buffers", () => {
  const source = "<urlset><url><loc>https://example.com/products/a</loc></url></urlset>";
  const gzipped = gzipSync(Buffer.from(source, "utf8"));
  assert.equal(decodeSitemapBody(gzipped), source);
});
