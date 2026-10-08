import {
  emailFromCookie,
  getArtifactView,
  getBoard,
  getBoardNotes,
  getFleetView,
  getJobScanView,
  getSelftestView,
  getUsageView,
  venturesHttp,
} from "../../generated/hq.js";

export const runtime = "nodejs";

// Ventures share this route to keep the function count flat: GET ?view=ventures lists them and POST
// adds a venture or rotates a lead token. venturesHttp checks the owner session itself.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("view") === "ventures") return venturesHttp(request);
  // Daily self-test (U6): GET ?view=selftest, owner only (getSelftestView checks the session).
  if (params.get("view") === "selftest") {
    const view = await getSelftestView(request.headers.get("cookie"));
    return Response.json(view.body, { status: view.status, headers: { "cache-control": "no-store" } });
  }
  const cookie = request.headers.get("cookie");
  if (!emailFromCookie(cookie)) return new Response("unauthorized", { status: 401 });
  // The weekly fleet report (U5) reads here too: GET ?view=fleet[&week=2026-W40], owner only.
  if (params.get("view") === "fleet") {
    const view = await getFleetView(cookie, params.get("week"));
    return Response.json(view.body, { status: view.status });
  }
  // The weekly job scan brief (Stage 4 C1): GET ?view=jobs[&week=2026-W40], owner only.
  if (params.get("view") === "jobs") {
    const view = await getJobScanView(cookie, params.get("week"));
    return Response.json(view.body, { status: view.status, headers: { "cache-control": "no-store" } });
  }
  if (params.get("view") === "notes") {
    // Owner JSON read of the agent board (no screen yet): type, scope, repo, status, limit filters.
    const notes = await getBoardNotes(cookie, params);
    return Response.json(notes.body, { status: notes.status, headers: { "cache-control": "no-store" } });
  }
  if (params.get("view") === "usage") {
    // Token police usage receipts (no screen): repo, requestId, status (all|recorded|unavailable), limit filters.
    const usage = await getUsageView(cookie, params);
    return Response.json(usage.body, { status: usage.status, headers: { "cache-control": "no-store" } });
  }
  if (params.get("view") === "artifact") {
    // Full tool output behind a board note's 200-char preview.
    const artifact = await getArtifactView(cookie, params.get("id"));
    return Response.json(artifact.body, { status: artifact.status, headers: { "cache-control": "no-store" } });
  }
  return Response.json(await getBoard());
}

export async function POST(request: Request) {
  return venturesHttp(request);
}
