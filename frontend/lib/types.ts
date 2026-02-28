export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];

export interface StoreRow {
  slug: string;
  store_name: string;
  url: string;
  status: string;
  created_at: string;
  last_checked?: string;
  coverage?: number;
}

export interface CoverageMetrics {
  discovered: number | null;
  indexed: number | null;
  failed: number | null;
  coverage: number | null;
}
