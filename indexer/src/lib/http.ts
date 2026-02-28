import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface FetchRuntimeConfig {
  timeoutMs: number;
  userAgent: string;
  readerProxyEnabled?: boolean;
  readerProxyBaseUrl?: string;
}

const execFileAsync = promisify(execFile);
const CURL_FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_READER_PROXY_BASE_URL = "https://r.jina.ai/http://";

function isChallengeResponse(response: Response): boolean {
  if (response.status === 403 || response.status === 429 || response.status === 503) {
    return true;
  }
  const mitigated = response.headers.get("cf-mitigated")?.toLowerCase() ?? "";
  return mitigated.includes("challenge");
}

function isJsonRequest(url: string, headers: Headers): boolean {
  const accept = headers.get("accept")?.toLowerCase() ?? "";
  if (accept.includes("application/json")) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return parsed.pathname.endsWith(".json");
  } catch {
    return false;
  }
}

function htmlReturnedForJson(response: Response, headers: Headers): boolean {
  const accept = headers.get("accept")?.toLowerCase() ?? "";
  const expectsJson = accept.includes("application/json");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return expectsJson && contentType.includes("text/html");
}

function buildReaderProxyUrl(targetUrl: string, configuredBase: string | undefined): string {
  const base = (configuredBase ?? DEFAULT_READER_PROXY_BASE_URL).trim();
  if (base.includes("{url}")) {
    return base.replace("{url}", encodeURIComponent(targetUrl));
  }
  if (base.endsWith("://")) {
    return `${base}${targetUrl.replace(/^https?:\/\//i, "")}`;
  }
  if (base.endsWith("/")) {
    return `${base}${targetUrl}`;
  }
  return `${base}/${targetUrl}`;
}

function extractJsonFromReaderProxy(body: string): string | null {
  let text = body.trim();
  const marker = "Markdown Content:";
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) {
    text = text.slice(markerIndex + marker.length).trim();
  }

  // Some proxy responses wrap payload in fenced blocks.
  if (text.startsWith("```")) {
    const firstBreak = text.indexOf("\n");
    const lastFence = text.lastIndexOf("```");
    if (firstBreak !== -1 && lastFence > firstBreak) {
      text = text.slice(firstBreak + 1, lastFence).trim();
    }
  }

  const arrayStart = text.indexOf("[");
  const objectStart = text.indexOf("{");
  let start = -1;
  if (arrayStart >= 0 && objectStart >= 0) {
    start = Math.min(arrayStart, objectStart);
  } else {
    start = Math.max(arrayStart, objectStart);
  }
  if (start < 0) {
    return null;
  }

  const candidate = text.slice(start).trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (end < 0) {
      return null;
    }
    const trimmed = candidate.slice(0, end + 1);
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return null;
    }
  }
}

function parseCurlRawResponse(raw: string): Response {
  const normalized = raw.replace(/\r\n/g, "\n");
  const headerStarts: number[] = [];
  const lines = normalized.split("\n");

  let cursor = 0;
  for (const line of lines) {
    if (line.startsWith("HTTP/")) {
      headerStarts.push(cursor);
    }
    cursor += line.length + 1;
  }

  if (headerStarts.length === 0) {
    return new Response(normalized, { status: 200 });
  }

  const lastHeaderStart = headerStarts[headerStarts.length - 1];
  const headerAndBody = normalized.slice(lastHeaderStart);
  const separator = headerAndBody.indexOf("\n\n");
  if (separator === -1) {
    return new Response(normalized, { status: 200 });
  }

  const headerText = headerAndBody.slice(0, separator);
  const body = headerAndBody.slice(separator + 2);
  const headerLines = headerText.split("\n").filter((line) => line.length > 0);
  const statusLine = headerLines[0] ?? "HTTP/1.1 200";
  const statusParts = statusLine.split(" ");
  const status = Number.parseInt(statusParts[1] ?? "200", 10) || 200;

  const headers = new Headers();
  for (const line of headerLines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) {
      headers.append(key, value);
    }
  }

  return new Response(body, { status, headers });
}

async function curlFetch(url: string, init: RequestInit, runtime: FetchRuntimeConfig): Promise<Response> {
  const args: string[] = ["-sS", "-L", "-D", "-", "--max-time", String(Math.ceil(runtime.timeoutMs / 1000))];
  const method = (init.method ?? "GET").toUpperCase();

  if (method !== "GET") {
    args.push("-X", method);
  }

  const headers = new Headers(init.headers);
  // Use a browser-like UA for curl fallback. Some storefront edges block custom bot-like UAs.
  headers.set("user-agent", CURL_FALLBACK_USER_AGENT);
  if (!headers.has("accept-language")) {
    headers.set("accept-language", "en-US,en;q=0.9");
  }
  headers.forEach((value, key) => {
    args.push("-H", `${key}: ${value}`);
  });

  args.push(url);
  const { stdout } = await execFileAsync("curl", args, { maxBuffer: 25 * 1024 * 1024, encoding: "utf8" });
  return parseCurlRawResponse(stdout);
}

async function readerProxyJsonFetch(url: string, runtime: FetchRuntimeConfig): Promise<Response | null> {
  if (!runtime.readerProxyEnabled) {
    return null;
  }

  const proxyUrl = buildReaderProxyUrl(url, runtime.readerProxyBaseUrl);
  try {
    const response = await fetch(proxyUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": CURL_FALLBACK_USER_AGENT,
        "accept-language": "en-US,en;q=0.9",
        accept: "text/plain,application/json;q=0.9,*/*;q=0.8"
      }
    });
    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    const jsonPayload = extractJsonFromReaderProxy(text);
    if (!jsonPayload) {
      return null;
    }

    return new Response(jsonPayload, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-shopmcp-fetch-source": "reader_proxy",
        "x-shopmcp-fetch-proxy": proxyUrl
      }
    });
  } catch {
    return null;
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  runtime: FetchRuntimeConfig
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtime.timeoutMs);
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) {
    headers.set("user-agent", runtime.userAgent);
  }

  try {
    let response = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal
    });

    if ((isChallengeResponse(response) || htmlReturnedForJson(response, headers)) && method === "GET") {
      try {
        response = await curlFetch(url, { ...init, headers }, runtime);
      } catch {
        // keep original response
      }
    }

    if ((isChallengeResponse(response) || htmlReturnedForJson(response, headers)) && method === "GET" && isJsonRequest(url, headers)) {
      const proxyResponse = await readerProxyJsonFetch(url, runtime);
      if (proxyResponse) {
        return proxyResponse;
      }
    }

    return response;
  } catch (error) {
    if (method === "GET") {
      try {
        let response = await curlFetch(url, { ...init, headers }, runtime);
        if ((isChallengeResponse(response) || htmlReturnedForJson(response, headers)) && isJsonRequest(url, headers)) {
          const proxyResponse = await readerProxyJsonFetch(url, runtime);
          if (proxyResponse) {
            return proxyResponse;
          }
        }
        return response;
      } catch {
        throw error;
      }
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
