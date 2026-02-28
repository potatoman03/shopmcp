import { NextResponse } from "next/server";
import { jsonRequestInit, parseBody, parseUpstream, requireBaseUrl } from "@/lib/proxy";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const baseUrl = requireBaseUrl("INDEXER_BASE_URL");
    const payload = parseBody(await request.json().catch(() => ({})));

    const upstream = await fetch(`${baseUrl}/index`, jsonRequestInit("POST", payload));
    const data = await parseUpstream(upstream);
    return NextResponse.json(data, { status: upstream.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Index proxy failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
