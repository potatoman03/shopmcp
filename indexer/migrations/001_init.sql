BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS stores (
  slug TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  store_name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'unknown',
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  product_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stores_slug_chk CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE TABLE IF NOT EXISTS crawl_runs (
  id BIGSERIAL PRIMARY KEY,
  store_slug TEXT NOT NULL REFERENCES stores(slug) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'index',
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crawl_runs_mode_chk CHECK (mode IN ('index', 'refresh')),
  CONSTRAINT crawl_runs_status_chk CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT crawl_runs_finished_chk CHECK (finished_at IS NULL OR finished_at >= started_at),
  UNIQUE (store_slug, id)
);

CREATE TABLE IF NOT EXISTS crawl_urls (
  id BIGSERIAL PRIMARY KEY,
  store_slug TEXT NOT NULL REFERENCES stores(slug) ON DELETE CASCADE,
  crawl_run_id BIGINT NOT NULL,
  url TEXT NOT NULL,
  url_norm TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'sitemap',
  lastmod TIMESTAMPTZ,
  priority NUMERIC(3, 2),
  changefreq TEXT,
  depth INT NOT NULL DEFAULT 0,
  is_candidate_product BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'queued',
  http_status INT,
  etag TEXT,
  last_modified TEXT,
  content_hash TEXT,
  last_crawled_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crawl_urls_run_fk
    FOREIGN KEY (store_slug, crawl_run_id)
    REFERENCES crawl_runs(store_slug, id)
    ON DELETE CASCADE,
  CONSTRAINT crawl_urls_status_chk
    CHECK (status IN ('queued', 'crawled', 'indexed', 'excluded', 'error')),
  CONSTRAINT crawl_urls_source_chk
    CHECK (source IN ('sitemap', 'shopify_json', 'html_link', 'external')),
  CONSTRAINT crawl_urls_depth_chk CHECK (depth >= 0),
  CONSTRAINT crawl_urls_http_status_chk CHECK (http_status IS NULL OR (http_status BETWEEN 100 AND 599)),
  UNIQUE (store_slug, url_norm)
);

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  store_slug TEXT NOT NULL REFERENCES stores(slug) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  title TEXT NOT NULL,
  product_type TEXT,
  vendor TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}'::text[],
  price_min INT,
  price_max INT,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  url TEXT NOT NULL,
  image_url TEXT,
  search_text TEXT NOT NULL,
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(search_text, ''))) STORED,
  data JSONB NOT NULL,
  embedding vector(1536),
  etag TEXT,
  last_modified TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT products_store_product_uniq UNIQUE (store_slug, product_id),
  CONSTRAINT products_store_handle_uniq UNIQUE (store_slug, handle),
  CONSTRAINT products_price_chk CHECK (
    (price_min IS NULL OR price_min >= 0) AND
    (price_max IS NULL OR price_max >= 0) AND
    (price_min IS NULL OR price_max IS NULL OR price_min <= price_max)
  )
);

CREATE INDEX IF NOT EXISTS idx_products_store_slug ON products (store_slug);
CREATE INDEX IF NOT EXISTS idx_products_store_slug_handle ON products (store_slug, handle);
CREATE INDEX IF NOT EXISTS idx_products_store_slug_available ON products (store_slug, available);
CREATE INDEX IF NOT EXISTS idx_products_store_slug_price ON products (store_slug, price_min, price_max);
CREATE INDEX IF NOT EXISTS idx_products_tags ON products USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_products_search_tsv ON products USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_products_data ON products USING gin (data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_products_embedding_hnsw
  ON products USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_crawl_urls_store_status ON crawl_urls (store_slug, status);
CREATE INDEX IF NOT EXISTS idx_crawl_urls_store_candidate ON crawl_urls (store_slug, is_candidate_product);
CREATE INDEX IF NOT EXISTS idx_crawl_urls_store_url_norm ON crawl_urls (store_slug, url_norm);
CREATE INDEX IF NOT EXISTS idx_crawl_urls_store_last_seen ON crawl_urls (store_slug, last_seen_at DESC);

COMMIT;
