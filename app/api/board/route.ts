import { emailFromCookie, getBoard, getBoardNotes, getFleetView, venturesHttp } from "../../generated/hq.js";

export const runtime = "nodejs";

// Ventures share this route to keep the function count flat: GET ?view=ventures lists them and POST
// adds a venture or rotates a lead token. venturesHttp checks the owner session itself.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("view") === "ventures") return venturesHttp(request);
  const cookie = request.headers.get("cookie");
  if (!emailFromCookie(cookie)) return new Response("unauthorized", { status: 401 });
  // The weekly fleet report (U5) reads here too: GET ?view=fleet[&week=2026-W40], owner only.
  if (params.get("view") === "fleet") {
    const view = await getFleetView(cookie, params.get("week"));
    return Response.json(view.body, { status: view.status });
  }
  if (params.get("view") === "notes") {
    // Owner JSON read of the agent board (no screen yet): type, scope, repo, status, limit filters.
    const notes = await getBoardNotes(cookie, params);
    return Response.json(notes.body, { status: notes.status, headers: { "cache-control": "no-store" } });
  }
  return Response.json(await getBoard());
}

export async function POST(request: Request) {
  return venturesHttp(request);
}
