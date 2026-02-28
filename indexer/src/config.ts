import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional()
);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: optionalNonEmptyString,
  OPENAI_API_KEY: optionalNonEmptyString,
  OPENAI_EMBED_MODEL: z.string().min(1).default("text-embedding-3-small"),
  EXA_API_KEY: optionalNonEmptyString,
  EXA_BASE_URL: z.string().min(1).default("https://api.exa.ai"),
  EXA_MAX_RESULTS: z.coerce.number().int().positive().max(100).default(25),
  EXA_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  READER_PROXY_ENABLED: z.coerce.boolean().default(true),
  READER_PROXY_BASE_URL: z.string().min(1).default("https://r.jina.ai/http://"),
  CRAWL_CONCURRENCY: z.coerce.number().int().positive().default(6),
  CRAWL_MAX_URLS: z.coerce.number().int().positive().default(500),
  LARGE_STORE_URL_THRESHOLD: z.coerce.number().int().positive().default(1200),
  LARGE_STORE_CRAWL_MAX_URLS: z.coerce.number().int().positive().default(250),
  LARGE_STORE_CRAWL_CONCURRENCY: z.coerce.number().int().positive().default(12),
  SHOPIFY_NO_FEED_CRAWL_CONCURRENCY: z.coerce.number().int().positive().default(12),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  EMBED_BATCH_SIZE: z.coerce.number().int().positive().default(64),
  UPSERT_CONCURRENCY: z.coerce.number().int().positive().default(12),
  UPSERT_BATCH_SIZE: z.coerce.number().int().positive().default(200),
  CRAWL_URL_UPSERT_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  SUMMARY_LLM_ENABLED: z.coerce.boolean().default(false),
  SUMMARY_LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  SUMMARY_LLM_MAX_CHARS: z.coerce.number().int().positive().default(220),
  USER_AGENT: z.string().min(1).default("ShopMCPIndexer/0.1 (+https://shopmcp.local)"),
  LOG_LEVEL: z.string().min(1).default("info")
});

export type AppConfig = z.infer<typeof EnvSchema>;

export const config: AppConfig = EnvSchema.parse(process.env);
