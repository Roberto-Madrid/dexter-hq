import { handleMcpHttp } from "../../../hq/mcp";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleMcpHttp(request);
}

export async function POST(request: Request) {
  return handleMcpHttp(request);
}

export async function DELETE(request: Request) {
  return handleMcpHttp(request);
}
