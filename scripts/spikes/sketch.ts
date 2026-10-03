/**
 * G1 sketch spike. A no-repo Cursor agent writes static HTML. Screenshots are
 * taken locally. Never prints the API key.
 * Run: node --experimental-strip-types scripts/spikes/sketch.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const API = "https://api.cursor.com";
const EVIDENCE = ".agent-work/evidence/G1/sketch";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of readFileSync(".env.local", "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return env;
}

async function api(key: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function main() {
  const key = loadEnv().CURSOR_API_KEY;
  if (!key) {
    console.log("CURSOR_API_KEY empty");
    process.exit(2);
  }
  mkdirSync(EVIDENCE, { recursive: true });
  const agentId = `bc-${randomUUID()}`;
  const created = await api(key, "POST", "/v1/agents", {
    agentId,
    name: "dexter-g1-sketch",
    prompt: {
      text: [
        "Produce one static HTML file with inline CSS and SVG only. No application code, no repository, no pull request.",
        "It is a black-and-white wireframe of a one-screen booking page for a fictional shop named Northline.",
        "Use these references only for layout ideas: https://example.com, https://www.wikipedia.org, https://developer.mozilla.org, https://www.w3.org.",
        "Write the file to /opt/cursor/artifacts/wireframe.html.",
      ].join(" "),
    },
  });
  const runId = String(asRecord(asRecord(created.body).run).id ?? "");
  if (created.status < 200 || created.status >= 300 || !runId) {
    console.log("create_http", created.status);
    process.exit(1);
  }
  const started = Date.now();
  let status = "UNKNOWN";
  while (Date.now() - started < 8 * 60 * 1000) {
    const got = await api(key, "GET", `/v1/agents/${agentId}/runs/${runId}`);
    status = String(asRecord(asRecord(got.body).run ?? got.body).status ?? "UNKNOWN");
    if (["FINISHED", "ERROR", "CANCELLED", "EXPIRED"].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  let path = "";
  for (let attempt = 0; attempt < 12 && !path; attempt += 1) {
    const listed = await api(key, "GET", `/v1/agents/${agentId}/artifacts`);
    const items = (asRecord(listed.body).items ?? []) as Record<string, unknown>[];
    path = String(items.find((item) => String(item.path).endsWith("wireframe.html"))?.path ?? "");
    if (!path) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!path) {
    console.log(JSON.stringify({ status, artifact: "missing" }));
    process.exit(1);
  }
  const download = await api(key, "GET", `/v1/agents/${agentId}/artifacts/download?path=${encodeURIComponent(path)}`);
  const url = String(asRecord(download.body).url ?? "");
  const file = await fetch(url);
  const htmlPath = join(EVIDENCE, "wireframe.html");
  writeFileSync(htmlPath, Buffer.from(await file.arrayBuffer()));
  const shots = [
    ["390x844", "390,844"],
    ["1440x900", "1440,900"],
  ] as const;
  const written: string[] = [];
  for (const [name, size] of shots) {
    const out = join(EVIDENCE, `wireframe-${name}.png`);
    mkdirSync(dirname(out), { recursive: true });
    const shot = spawnSync(
      "google-chrome",
      ["--headless", "--disable-gpu", "--no-sandbox", `--window-size=${size}`, `--screenshot=${out}`, `file://${process.cwd()}/${htmlPath}`],
      { encoding: "utf8" },
    );
    if (shot.status === 0) written.push(name);
  }
  const report = { status, path, bytes: statSize(htmlPath), shots: written };
  writeFileSync(join(EVIDENCE, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (status !== "FINISHED" || written.length !== 2) process.exit(1);
}

function statSize(path: string): number {
  return readFileSync(path).length;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "failed";
  console.log("fatal", message.slice(0, 200));
  process.exit(1);
});
