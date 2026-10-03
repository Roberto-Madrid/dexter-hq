/**
 * G1 CEO path spike, path B.
 * Never reads or prints ~/.codex/auth.json.
 * Run: node --experimental-strip-types scripts/spikes/ceo-path.ts
 */
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { runCeo, type CeoEffort } from "../../gateway/client.ts";

const EVIDENCE = ".agent-work/evidence/G1";
const CODEX = process.env.CODEX_BIN ?? join(process.env.HOME ?? "", ".dexter/codex/node_modules/.bin/codex");
const SCHEMA = join(process.cwd(), EVIDENCE, "classify.schema.json");

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const text = readFileSync(".env.local", "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loginKind(): string {
  const result = spawnSync(CODEX, ["login", "status"], { encoding: "utf8" });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (text.includes("ChatGPT")) return "chatgpt";
  if (text.toLowerCase().includes("api key")) return "api_key";
  return "unknown";
}

function resolveSol(): { model: string; efforts: string[] } {
  const result = spawnSync(CODEX, ["debug", "models"], { encoding: "utf8", maxBuffer: 20_000_000 });
  const raw = result.stdout ?? "";
  const start = raw.indexOf("{");
  const parsed = JSON.parse(raw.slice(start)) as { models?: { slug?: string; supported_reasoning_levels?: { effort?: string }[] }[] };
  const candidates = (parsed.models ?? [])
    .map((item) => item.slug ?? "")
    .filter((slug) => /^gpt-[\d.]+-sol$/.test(slug) && !/(^|[-.])(fast|max|preview)([-.]|$)/i.test(slug));
  candidates.sort((a, b) => {
    const av = [...a.matchAll(/\d+/g)].map((m) => Number(m[0]));
    const bv = [...b.matchAll(/\d+/g)].map((m) => Number(m[0]));
    const n = Math.max(av.length, bv.length);
    for (let i = 0; i < n; i += 1) {
      const diff = (av[i] ?? 0) - (bv[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  const model = candidates.at(-1);
  if (!model) throw new Error("no_gpt_sol");
  const row = (parsed.models ?? []).find((item) => item.slug === model);
  const efforts = (row?.supported_reasoning_levels ?? []).map((item) => item.effort ?? "").filter(Boolean);
  return { model, efforts };
}

type CallResult = {
  effort: CeoEffort;
  model: string;
  firstTokenMs: number | null;
  exitCode: number;
  text: string;
  usage: Record<string, number> | null;
  schemaKind?: string;
};

function callRoute(port: number, body: unknown): Promise<CallResult> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: "/ceo", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const events = raw.split("\n\n").map((block) => block.replace(/^data: /, "")).filter((line) => line.startsWith("{"));
          const last = events.at(-1);
          if (!last) reject(new Error("empty_stream"));
          else resolve(JSON.parse(last) as CallResult);
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function main() {
  const env = loadEnv();
  if (env.CEO_PATH !== "B") {
    console.log("CEO_PATH is not B");
    process.exit(2);
  }
  if (process.env.OPENAI_API_KEY) {
    console.log("OPENAI_API_KEY is set; refusing so this cannot be an API bill");
    process.exit(2);
  }
  const login = loginKind();
  if (login !== "chatgpt") {
    console.log("codex_login", login);
    process.exit(1);
  }
  const resolved = resolveSol();
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(
    SCHEMA,
    JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { type: "string", enum: ["question", "task", "status"] } },
    }),
  );

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/ceo") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: { effort: CeoEffort; prompt: string; schema?: boolean };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { effort: CeoEffort; prompt: string; schema?: boolean };
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    try {
    const outputPath = join(process.cwd(), EVIDENCE, body.schema ? "ceo-low-output.json" : "ceo-medium-output.txt");
    let firstTokenMs: number | null = null;
    let text = "";
    let usage: Record<string, number> | null = null;
    res.writeHead(200, { "content-type": "text/event-stream" });
    await runCeo(
      {
        model: resolved.model,
        effort: body.effort,
        prompt: body.prompt,
        schemaPath: body.schema ? SCHEMA : undefined,
        outputPath,
        codexBin: CODEX,
      },
      (event, atMs) => {
        if (firstTokenMs === null && event.text) firstTokenMs = atMs;
        if (event.text) text = event.text;
        if (event.usage) usage = event.usage;
        res.write(`data: ${JSON.stringify({ type: event.type, atMs })}\n\n`);
      },
      { deadline: Date.now() + 290_000 },
    );
    const exitCode = 0;
    if (!text) {
      try {
        text = readFileSync(outputPath, "utf8").trim();
      } catch {
        text = "";
      }
    }
    const result: CallResult = { effort: body.effort, model: resolved.model, firstTokenMs, exitCode, text: text.slice(0, 500), usage };
    if (body.schema) {
      const parsed = JSON.parse(readFileSync(outputPath, "utf8")) as { kind?: string };
      result.schemaKind = parsed.kind;
    }
    res.write(`data: ${JSON.stringify(result)}\n\n`);
    res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed";
      const safe = message.replace(/eyJ[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 200);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(safe);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const medium = await callRoute(port, { effort: "medium", prompt: "Reply with exactly the word pong." });
  const low = await callRoute(port, {
    effort: "low",
    schema: true,
    prompt: "Classify the user text as question, task, or status. User text: what time is it?",
  });
  server.close();

  const mediumOk = medium.exitCode === 0 && /pong/i.test(medium.text) && medium.firstTokenMs !== null;
  const lowOk = low.exitCode === 0 && ["question", "task", "status"].includes(low.schemaKind ?? "");
  const evidence = {
    path: "B",
    login: "chatgpt",
    openai_api_key_set: false,
    model: resolved.model,
    efforts: resolved.efforts,
    medium: { firstTokenMs: medium.firstTokenMs, text: medium.text, usage: medium.usage, ok: mediumOk },
    low: { schemaKind: low.schemaKind, usage: low.usage, ok: lowOk },
  };
  writeFileSync(join(EVIDENCE, "ceo-path.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ model: resolved.model, mediumOk, lowOk, firstTokenMs: medium.firstTokenMs, kind: low.schemaKind }));
  if (!mediumOk || !lowOk) process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "failed";
  console.log("fatal", message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 200));
  process.exit(1);
});
