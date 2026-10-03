import { emailFromCookie, postChat } from "../../generated/hq.js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!emailFromCookie(request.headers.get("cookie"))) return new Response("unauthorized", { status: 401 });
  const body = (await request.json()) as { text?: string };
  if (!body.text?.trim()) return new Response("bad request", { status: 400 });
  const result = await postChat(body.text);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: result.text })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: result })}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
