const JSON_HEADERS = {
  "Content-Type": "application/json"
};

export function requireBaseUrl(name: "INDEXER_BASE_URL" | "MCP_BASE_URL"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.replace(/\/+$/, "");
}

export function parseBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}

export async function parseUpstream(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export function jsonRequestInit(method: "GET" | "POST", body?: unknown): RequestInit {
  if (method === "GET") {
    return {
      method,
      headers: JSON_HEADERS,
      cache: "no-store"
    };
  }
  return {
    method,
    headers: JSON_HEADERS,
    body: JSON.stringify(body ?? {}),
    cache: "no-store"
  };
}
