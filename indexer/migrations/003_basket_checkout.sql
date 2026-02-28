BEGIN;

CREATE TABLE IF NOT EXISTS baskets (
  basket_id TEXT PRIMARY KEY,
  store_slug TEXT NOT NULL REFERENCES stores(slug) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  checkout_url TEXT,
  checked_out_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT baskets_status_chk CHECK (status IN ('active', 'checked_out', 'abandoned'))
);

CREATE TABLE IF NOT EXISTS basket_items (
  basket_id TEXT NOT NULL REFERENCES baskets(basket_id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,
  product_handle TEXT NOT NULL,
  product_title TEXT NOT NULL,
  product_url TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '{}'::jsonb,
  unit_price INT NOT NULL DEFAULT 0,
  quantity INT NOT NULL,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT basket_items_qty_chk CHECK (quantity > 0),
  CONSTRAINT basket_items_price_chk CHECK (unit_price >= 0),
  PRIMARY KEY (basket_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_baskets_store_status_updated
  ON baskets (store_slug, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_basket_items_basket_updated
  ON basket_items (basket_id, updated_at DESC);

COMMIT;
