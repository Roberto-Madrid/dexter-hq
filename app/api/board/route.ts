import { emailFromCookie, getBoard, getBoardNotes, venturesHttp } from "../../generated/hq.js";

export const runtime = "nodejs";

// Ventures share this route to keep the function count flat: GET ?view=ventures lists them and POST
// adds a venture or rotates a lead token. venturesHttp checks the owner session itself.
export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("view") === "ventures") return venturesHttp(request);
  if (url.searchParams.get("view") === "notes") {
    // Owner JSON read of the agent board (no screen yet). getBoardNotes checks the owner session itself.
    const notes = await getBoardNotes(request.headers.get("cookie"), url.searchParams);
    if (notes.status === 401) return new Response("unauthorized", { status: 401 });
    return Response.json(notes.body, { status: notes.status, headers: { "cache-control": "no-store" } });
  }
  if (!emailFromCookie(request.headers.get("cookie"))) return new Response("unauthorized", { status: 401 });
  return Response.json(await getBoard());
}

export async function POST(request: Request) {
  return venturesHttp(request);
}
