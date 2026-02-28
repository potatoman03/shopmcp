import { NextResponse } from "next/server";
import { jsonRequestInit, parseBody, parseUpstream, requireBaseUrl } from "@/lib/proxy";

interface Params {
  params: {
    slug: string;
    tool: string;
  };
}

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  try {
    const baseUrl = requireBaseUrl("MCP_BASE_URL");
    const requestBody = parseBody(await request.json().catch(() => ({})));
    const encodedSlug = encodeURIComponent(params.slug);
    const encodedTool = encodeURIComponent(params.tool);
    const payload = {
      arguments: (requestBody.arguments ?? requestBody) as unknown
    };

    const upstream = await fetch(
      `${baseUrl}/mcp/${encodedSlug}/tool/${encodedTool}`,
      jsonRequestInit("POST", payload)
    );
    const data = await parseUpstream(upstream);
    return NextResponse.json(data, { status: upstream.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP proxy failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
