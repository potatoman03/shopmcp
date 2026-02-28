import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRawProduct, toAvailabilityBoolean, toIntegerCents } from "./normalize";

test("toIntegerCents converts string prices to integer cents", () => {
  assert.equal(toIntegerCents("$19.99"), 1999);
  assert.equal(toIntegerCents(12), 1200);
});

test("toAvailabilityBoolean maps schema.org strings", () => {
  assert.equal(toAvailabilityBoolean("https://schema.org/InStock"), true);
  assert.equal(toAvailabilityBoolean("https://schema.org/OutOfStock"), false);
});

test("normalizeRawProduct omits nullable optional fields", () => {
  const normalized = normalizeRawProduct(
    {
      id: "123",
      title: "Test Product",
      url: "https://example.com/products/test-product",
      handle: "test-product",
      tags: "foo,bar",
      price: "10.50",
      availability: "InStock",
      description: null,
      brand: null,
      image_url: null,
      variants: [
        {
          id: "1",
          sku: "SKU-1",
          price: "10.50",
          available: true
        }
      ],
      source: "html"
    },
    "example",
    "https://example.com"
  );

  assert.ok(normalized);
  assert.equal(normalized?.price_min, 1050);
  assert.equal(normalized?.price_max, 1050);
  assert.equal(normalized?.available, true);
  assert.equal("description" in (normalized ?? {}), false);
  assert.equal("brand" in (normalized ?? {}), false);
  assert.equal("image_url" in (normalized ?? {}), false);
});
