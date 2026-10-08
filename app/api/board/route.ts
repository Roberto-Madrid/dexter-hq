import { emailFromCookie, getBoard, venturesHttp } from "../../generated/hq.js";

export const runtime = "nodejs";

// Ventures share this route to keep the function count flat: GET ?view=ventures lists them and POST
// adds a venture or rotates a lead token. venturesHttp checks the owner session itself.
export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("view") === "ventures") return venturesHttp(request);
  if (!emailFromCookie(request.headers.get("cookie"))) return new Response("unauthorized", { status: 401 });
  return Response.json(await getBoard());
}

export async function POST(request: Request) {
  return venturesHttp(request);
}
