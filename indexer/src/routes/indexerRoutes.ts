import { Router } from "express";
import { z } from "zod";
import { IndexerService } from "../crawlers/indexer";
import { Logger } from "../lib/logger";

const indexBodySchema = z.object({
  url: z.string().min(1),
  store_name: z.string().min(1),
  slug: z.string().min(1).optional(),
  force_reindex: z.boolean().optional()
});

const refreshBodySchema = z.object({
  force: z.boolean().optional(),
  force_reindex: z.boolean().optional()
});

const statusQuerySchema = z.object({
  include_products: z.coerce.boolean().optional().default(false),
  products_limit: z.coerce.number().int().positive().max(1000).optional().default(20)
});

const productsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
  view: z.enum(["summary", "manifest"]).default("summary")
});

function stripHtml(input: string): string {
  const noTags = input.replace(/<[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ");
  return decoded.replace(/\s+/g, " ").trim();
}

export function createIndexerRouter(indexer: IndexerService): Router {
  const router = Router();
  const logger = new Logger("indexer.routes", process.env.LOG_LEVEL);

  router.get("/health", async (_request, response) => {
    const health = await indexer.health();
    logger.debug("health_requested", health);
    response.status(health.ok ? 200 : 503).json({ ...health, timestamp: new Date().toISOString() });
  });

  router.post("/index", async (request, response) => {
    const parsed = indexBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      logger.warn("index_request_invalid", { errors: parsed.error.flatten() });
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    try {
      logger.info("index_requested", {
        url: parsed.data.url,
        store_name: parsed.data.store_name,
        slug: parsed.data.slug,
        force_reindex: parsed.data.force_reindex ?? false
      });
      const status = await indexer.startIndex({
        storeUrl: parsed.data.url,
        storeName: parsed.data.store_name,
        slug: parsed.data.slug,
        force: parsed.data.force_reindex
      });
      logger.info("index_queued", {
        slug: status.slug,
        store_name: status.store_name,
        endpoint: status.endpoint
      });

      response.status(202).json({
        slug: status.slug,
        store_name: status.store_name,
        url: status.store_url,
        endpoint: status.endpoint,
        status: status.state,
        product_count: status.product_count,
        discovered_urls: status.metrics.discovered_urls,
        crawled_urls: status.metrics.crawled_urls,
        sitemap_urls: status.metrics.sitemap_urls,
        skipped_unchanged: status.metrics.skipped_unchanged
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to start index";
      logger.error("index_request_failed", { error, message });
      response.status(409).json({ error: message });
    }
  });

  router.get("/status/:slug", async (request, response) => {
    const statusParsed = statusQuerySchema.safeParse(request.query ?? {});
    if (!statusParsed.success) {
      logger.warn("status_request_invalid", { slug: request.params.slug, errors: statusParsed.error.flatten() });
      response.status(400).json({ error: statusParsed.error.flatten() });
      return;
    }

    const status = await indexer.getStatus(request.params.slug);
    if (!status) {
      logger.warn("status_not_found", { slug: request.params.slug });
      response.status(404).json({ error: "slug not found" });
      return;
    }
    logger.debug("status_requested", {
      slug: status.slug,
      state: status.state,
      product_count: status.product_count
    });

    let productsPreview: Array<{ title: string; price?: number; description?: string; url: string }> | undefined;
    if (statusParsed.data.include_products) {
      const listed = await indexer.listIndexedProducts(request.params.slug, statusParsed.data.products_limit, 0);
      productsPreview = listed.products.map((product) => ({
        title: product.title,
        ...(product.price !== undefined ? { price: product.price } : {}),
        ...(product.description ? { description: stripHtml(product.description) } : {}),
        url: product.url
      }));
    }

    response.json({
      slug: status.slug,
      store_name: status.store_name,
      url: status.store_url,
      platform: status.platform,
      status: status.state,
      endpoint: status.endpoint,
      product_count: status.product_count,
      last_indexed: status.last_indexed ?? status.finished_at,
      metrics: status.metrics,
      started_at: status.started_at,
      finished_at: status.finished_at,
      error: status.error,
      ...(productsPreview ? { products: productsPreview } : {})
    });
  });

  router.post("/refresh/:slug", async (request, response) => {
    const parsed = refreshBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      logger.warn("refresh_request_invalid", { slug: request.params.slug, errors: parsed.error.flatten() });
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    try {
      const force = parsed.data.force ?? parsed.data.force_reindex;
      logger.info("refresh_requested", { slug: request.params.slug, force: force ?? false });
      const status = await indexer.refresh(request.params.slug, force);
      logger.info("refresh_queued", { slug: status.slug, state: status.state });
      response.status(202).json(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to refresh index";
      logger.error("refresh_request_failed", { slug: request.params.slug, error, message });
      response.status(404).json({ error: message });
    }
  });

  router.get("/products/:slug", async (request, response) => {
    const parsed = productsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      logger.warn("products_request_invalid", {
        slug: request.params.slug,
        errors: parsed.error.flatten()
      });
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const manifestView = parsed.data.view === "manifest";
    const manifest = manifestView
      ? await indexer.getIndexedProductManifest(request.params.slug, parsed.data.limit, parsed.data.offset)
      : null;
    const summaryView = manifestView
      ? null
      : await indexer.listIndexedProducts(request.params.slug, parsed.data.limit, parsed.data.offset);
    const status = manifestView ? manifest?.status : summaryView?.status;
    if (!status) {
      logger.warn("products_not_found", { slug: request.params.slug });
      response.status(404).json({ error: "slug not found" });
      return;
    }

    if (manifestView && manifest) {
      const output = manifest.products.map((product) => ({
        title: product.title,
        handle: product.handle,
        category: product.category,
        ...(product.price_min !== undefined ? { price_min: product.price_min } : {}),
        ...(product.price_max !== undefined ? { price_max: product.price_max } : {}),
        available: product.available,
        variant_count: product.variant_count,
        source: product.source,
        exa_matched: product.exa_matched,
        ...(product.description ? { description: stripHtml(product.description) } : {}),
        url: product.url
      }));

      logger.info("products_manifest_listed", {
        slug: request.params.slug,
        status: status.state,
        total_products: status.product_count,
        returned_products: output.length,
        limit: parsed.data.limit,
        offset: parsed.data.offset
      });
      response.json({
        slug: status.slug,
        status: status.state,
        total_products: status.product_count,
        returned_products: output.length,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        summary: manifest.summary,
        exa: manifest.exa,
        products: output
      });
      return;
    }

    const output = (summaryView?.products ?? []).map((product) => ({
      title: product.title,
      ...(product.price !== undefined ? { price: product.price } : {}),
      ...(product.description ? { description: stripHtml(product.description) } : {}),
      url: product.url
    }));

    logger.info("products_listed", {
      slug: request.params.slug,
      status: status.state,
      total_products: status.product_count,
      returned_products: output.length,
      limit: parsed.data.limit,
      offset: parsed.data.offset
    });
    response.json({
      slug: status.slug,
      status: status.state,
      total_products: status.product_count,
      returned_products: output.length,
      products: output
    });
  });

  return router;
}
