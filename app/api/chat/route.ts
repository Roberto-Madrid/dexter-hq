import { emailFromCookie, postChat } from "../../generated/hq.js";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!emailFromCookie(request.headers.get("cookie"))) return new Response("unauthorized", { status: 401 });
  const body = (await request.json()) as { text?: string };
  if (!body.text?.trim()) return new Response("bad request", { status: 400 });
  const text = body.text;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const result = await postChat(text, (delta) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
      });
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: result })}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
