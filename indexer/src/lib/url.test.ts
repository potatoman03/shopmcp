import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUrl } from "./url";

test("normalizeUrl canonicalizes malformed Shopify locale product paths", () => {
  const normalized = normalizeUrl(
    "https://owalalife.com/undefined-undefined/products/freesip?Color=Sugar+High&Material=Stainless+Steel&Size=24oz&selectionType=local"
  );
  assert.equal(normalized, "https://owalalife.com/products/freesip");
});

test("normalizeUrl canonicalizes localized Shopify product URLs and drops query variants", () => {
  const normalized = normalizeUrl("https://owalalife.com/en-ca/products/replacement-lids?Size=24oz");
  assert.equal(normalized, "https://owalalife.com/products/replacement-lids");
});

test("normalizeUrl preserves non-product query params while removing tracking params", () => {
  const normalized = normalizeUrl("https://example.com/search?q=bottle&utm_source=ads");
  assert.equal(normalized, "https://example.com/search?q=bottle");
});
