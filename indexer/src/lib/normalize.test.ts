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
  assert.equal(toAvailabilityBoolean(1), true);
  assert.equal(toAvailabilityBoolean(0), false);
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

test("normalizeRawProduct keeps variant-level price and availability", () => {
  const normalized = normalizeRawProduct(
    {
      id: "v-test",
      title: "Variant Product",
      url: "https://example.com/products/variant-product",
      handle: "variant-product",
      variants: [
        {
          id: "va",
          title: "Size M / Black",
          price: "12.50",
          compare_at_price: "15.00",
          available: false,
          options: { Size: "M", Color: "Black" }
        },
        {
          id: "vb",
          title: "Size L / Black",
          price: "13.50",
          available: true,
          options: { Size: "L", Color: "Black" }
        }
      ],
      source: "shopify_json"
    },
    "example",
    "https://example.com"
  );

  assert.ok(normalized);
  assert.equal(normalized?.available, true);
  assert.equal(normalized?.price_min, 1250);
  assert.equal(normalized?.price_max, 1350);
  assert.equal(normalized?.variants?.length, 2);
  assert.equal(normalized?.variants?.[0]?.available, false);
  assert.equal(normalized?.variants?.[0]?.price_cents, 1250);
  assert.equal(normalized?.variants?.[0]?.compare_at_cents, 1500);
  assert.equal(normalized?.variants?.[1]?.available, true);
  assert.equal(normalized?.variants?.[1]?.price_cents, 1350);
});
