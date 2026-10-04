import { handleMcpHttp, createLiveConnectorDeps } from "../../../hq/mcp";

export const runtime = "nodejs";

function deps() {
  return createLiveConnectorDeps();
}

export async function GET(request: Request) {
  return handleMcpHttp(request, deps());
}

export async function POST(request: Request) {
  return handleMcpHttp(request, deps());
}

export async function DELETE(request: Request) {
  return handleMcpHttp(request, deps());
}
