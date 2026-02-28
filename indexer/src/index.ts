import express, { NextFunction, Request, Response } from "express";
import { IndexerService } from "./crawlers/indexer";
import { config } from "./config";
import { Database } from "./lib/db";
import { EmbeddingService } from "./lib/embedder";
import { createDiscoveryPlugin } from "./lib/exa";
import { Logger } from "./lib/logger";
import { StatusRegistry } from "./lib/status";
import { createIndexerRouter } from "./routes/indexerRoutes";

const app = express();
app.use(express.json({ limit: "1mb" }));
const logger = new Logger("indexer.server", config.LOG_LEVEL);

const database = new Database(config.DATABASE_URL);
const embeddings = new EmbeddingService(config.OPENAI_API_KEY, config.OPENAI_EMBED_MODEL);
const statuses = new StatusRegistry();
const discoveryPlugin = createDiscoveryPlugin({
  exaApiKey: config.EXA_API_KEY,
  exaBaseUrl: config.EXA_BASE_URL,
  exaMaxResults: config.EXA_MAX_RESULTS,
  exaTimeoutMs: config.EXA_TIMEOUT_MS,
  logLevel: config.LOG_LEVEL
});

const indexer = new IndexerService(config, database, embeddings, statuses, discoveryPlugin);

app.use((request: Request, response: Response, next: NextFunction) => {
  const started = Date.now();
  response.on("finish", () => {
    logger.info("http_request", {
      method: request.method,
      path: request.path,
      status_code: response.statusCode,
      duration_ms: Date.now() - started
    });
  });
  next();
});

app.use("/", createIndexerRouter(indexer));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "internal server error";
  logger.error("unhandled_error", { error });
  response.status(500).json({ error: message });
});

const server = app.listen(config.PORT, () => {
  logger.info("server_started", {
    port: config.PORT,
    log_level: config.LOG_LEVEL,
    embeddings: config.OPENAI_API_KEY ? "enabled" : "disabled",
    exa_plugin: config.EXA_API_KEY ? "enabled" : "disabled",
    exa_base_url: config.EXA_BASE_URL,
    exa_max_results: config.EXA_MAX_RESULTS,
    crawl_concurrency: config.CRAWL_CONCURRENCY,
    crawl_max_urls: config.CRAWL_MAX_URLS,
    large_store_url_threshold: config.LARGE_STORE_URL_THRESHOLD,
    large_store_crawl_max_urls: config.LARGE_STORE_CRAWL_MAX_URLS,
    large_store_crawl_concurrency: config.LARGE_STORE_CRAWL_CONCURRENCY,
    shopify_no_feed_crawl_concurrency: config.SHOPIFY_NO_FEED_CRAWL_CONCURRENCY,
    embed_batch_size: config.EMBED_BATCH_SIZE,
    upsert_concurrency: config.UPSERT_CONCURRENCY,
    reader_proxy: config.READER_PROXY_ENABLED ? "enabled" : "disabled"
  });
});

const shutdown = async (): Promise<void> => {
  logger.info("shutdown_started");
  server.close();
  await database.close();
  logger.info("shutdown_completed");
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
