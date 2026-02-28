import assert from "node:assert/strict";
import test from "node:test";
import { slugifyStore } from "./slugify";

test("slugifyStore removes protocol and www", () => {
  assert.equal(slugifyStore("https://www.Example-Store.com"), "example-store-com");
});

test("slugifyStore prefers shop name for myshopify domains", () => {
  assert.equal(slugifyStore("https://acme-demo.myshopify.com"), "acme-demo");
});
