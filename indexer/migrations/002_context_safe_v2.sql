BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_catalog_product BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS summary_short TEXT,
  ADD COLUMN IF NOT EXISTS summary_llm TEXT,
  ADD COLUMN IF NOT EXISTS option_tokens TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_products_store_catalog_available
  ON products (store_slug, is_catalog_product, available);

CREATE INDEX IF NOT EXISTS idx_products_store_catalog_price
  ON products (store_slug, is_catalog_product, price_min, price_max);

CREATE INDEX IF NOT EXISTS idx_products_option_tokens
  ON products USING gin (option_tokens);

COMMIT;
