import { z } from "zod";

export const ProductSourceSchema = z.enum(["sitemap", "shopify_json", "html", "exa"]);

export const RawVariantSchema = z.object({
  id: z.union([z.string(), z.number()]).optional().nullable(),
  title: z.string().optional().nullable(),
  sku: z.string().optional().nullable(),
  price: z.union([z.string(), z.number()]).optional().nullable(),
  compare_at_price: z.union([z.string(), z.number()]).optional().nullable(),
  currency: z.string().optional().nullable(),
  available: z.union([z.boolean(), z.string()]).optional().nullable(),
  option1: z.string().optional().nullable(),
  option2: z.string().optional().nullable(),
  option3: z.string().optional().nullable(),
  options: z.record(z.string()).optional().nullable()
});

export const RawProductSchema = z.object({
  id: z.union([z.string(), z.number()]).optional().nullable(),
  url: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  handle: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  brand: z.string().optional().nullable(),
  vendor: z.string().optional().nullable(),
  product_type: z.string().optional().nullable(),
  image_url: z.string().optional().nullable(),
  tags: z.union([z.string(), z.array(z.string())]).optional().nullable(),
  price: z.union([z.string(), z.number()]).optional().nullable(),
  currency: z.string().optional().nullable(),
  availability: z.union([z.boolean(), z.string()]).optional().nullable(),
  variants: z.array(RawVariantSchema).optional().nullable(),
  options: z
    .array(
      z.object({
        name: z.string(),
        values: z.array(z.string()).optional().default([])
      })
    )
    .optional()
    .nullable(),
  source: ProductSourceSchema.optional().nullable(),
  etag: z.string().optional().nullable(),
  last_modified: z.string().optional().nullable()
});

export const NormalizedVariantSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  sku: z.string().optional(),
  price_cents: z.number().int().nonnegative().optional(),
  compare_at_cents: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  available: z.boolean().optional(),
  options: z.record(z.string()).optional()
});

export const NormalizedProductSchema = z.object({
  store_slug: z.string().min(1),
  product_id: z.string().min(1),
  title: z.string().min(1),
  handle: z.string().min(1),
  url: z.string().url(),
  tags: z.array(z.string()),
  search_text: z.string().min(1),
  available: z.boolean(),
  source: ProductSourceSchema,
  price_min: z.number().int().nonnegative().optional(),
  price_max: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  description: z.string().optional(),
  brand: z.string().optional(),
  vendor: z.string().optional(),
  product_type: z.string().optional(),
  image_url: z.string().url().optional(),
  variants: z.array(NormalizedVariantSchema).optional(),
  options: z
    .array(
      z.object({
        name: z.string(),
        values: z.array(z.string())
      })
    )
    .optional(),
  etag: z.string().optional(),
  last_modified: z.string().optional()
});

export type ProductSource = z.infer<typeof ProductSourceSchema>;
export type RawVariant = z.infer<typeof RawVariantSchema>;
export type RawProduct = z.infer<typeof RawProductSchema>;
export type NormalizedVariant = z.infer<typeof NormalizedVariantSchema>;
export type NormalizedProduct = z.infer<typeof NormalizedProductSchema>;
