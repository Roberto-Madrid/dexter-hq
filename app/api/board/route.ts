import { emailFromCookie, getBoard, getFleetView } from "../../generated/hq.js";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const cookie = request.headers.get("cookie");
  if (!emailFromCookie(cookie)) return new Response("unauthorized", { status: 401 });
  const params = new URL(request.url).searchParams;
  if (params.get("view") === "fleet") {
    const view = await getFleetView(cookie, params.get("week"));
    return Response.json(view.body, { status: view.status });
  }
  return Response.json(await getBoard());
}
