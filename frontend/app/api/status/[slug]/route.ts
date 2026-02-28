import { NextResponse } from "next/server";
import { jsonRequestInit, parseUpstream, requireBaseUrl } from "@/lib/proxy";

interface Params {
  params: {
    slug: string;
  };
}

export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  try {
    const baseUrl = requireBaseUrl("INDEXER_BASE_URL");
    const slug = encodeURIComponent(params.slug);
    const query = new URL(request.url).searchParams.toString();
    const upstreamUrl = `${baseUrl}/status/${slug}${query ? `?${query}` : ""}`;
    const upstream = await fetch(upstreamUrl, jsonRequestInit("GET"));
    const data = await parseUpstream(upstream);
    return NextResponse.json(data, { status: upstream.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Status proxy failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
