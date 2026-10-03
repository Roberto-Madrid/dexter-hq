/**
 * G1 Cursor lifecycle spike.
 * Reads CURSOR_API_KEY from the environment or .env.local. Never prints it.
 * Run: node --experimental-strip-types scripts/spikes/cursor-lifecycle.ts
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const API = "https://api.cursor.com";
const EVIDENCE = ".agent-work/evidence/G1";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const i = line.indexOf("=");
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value && !env[key]) env[key] = value;
    }
  } catch {
    // The process environment is enough when the file is absent.
  }
  return env;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/https?:\/\/[^\s"']+/g, "[URL]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/key|token|secret|authorization|password/i.test(key)) {
        out[key] = item ? "[REDACTED]" : item;
      } else {
        out[key] = redact(item);
      }
    }
    return out;
  }
  return value;
}

type ModelItem = {
  id: string;
  displayName?: string;
  variants?: { id: string; values?: { value: string; displayName?: string }[] }[];
};

const FAMILIES: { family: string; test: (id: string) => boolean }[] = [
  { family: "grok", test: (id) => id.startsWith("grok-") },
  { family: "composer", test: (id) => id.startsWith("composer-") },
  { family: "claude-opus", test: (id) => id.startsWith("claude-opus-") },
  { family: "gpt-sol", test: (id) => /^gpt-[\d.]+-sol$/.test(id) },
];

function excludedVariant(id: string): boolean {
  return /(^|[-.])(fast|max|preview)([-.]|$)/i.test(id);
}

function versionKey(id: string): number[] {
  return [...id.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

function newer(a: string, b: string): number {
  const left = versionKey(a);
  const right = versionKey(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.localeCompare(b);
}

function resolveFamilies(items: ModelItem[]) {
  return FAMILIES.map(({ family, test }) => {
    const matches = items.map((item) => item.id).filter(test);
    const standard = matches.filter((id) => !excludedVariant(id)).sort(newer);
    const chosen = standard.at(-1) ?? null;
    return {
      family,
      chosen,
      excluded: matches.filter(excludedVariant),
      considered: standard,
    };
  });
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
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text.slice(0, 200);
    }
  }
  return { status: response.status, body: parsed };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function waitRun(key: string, agentId: string, runId: string, timeoutMs: number) {
  const started = Date.now();
  let last = "UNKNOWN";
  while (Date.now() - started < timeoutMs) {
    const got = await api(key, "GET", `/v1/agents/${agentId}/runs/${runId}`);
    const run = asRecord(asRecord(got.body).run ?? got.body);
    last = String(run.status ?? "UNKNOWN");
    if (["FINISHED", "ERROR", "CANCELLED", "EXPIRED"].includes(last)) {
      return { status: last, http: got.status };
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return { status: last, http: 0, timedOut: true };
}

async function main() {
  const env = loadEnv();
  const key = env.CURSOR_API_KEY;
  if (!key) {
    console.log("CURSOR_API_KEY empty");
    process.exit(2);
  }
  mkdirSync(EVIDENCE, { recursive: true });

  const models = await api(key, "GET", "/v1/models");
  if (models.status !== 200) {
    console.log("models_http", models.status);
    process.exit(1);
  }
  const items = (asRecord(models.body).items ?? []) as ModelItem[];
  writeFileSync(`${EVIDENCE}/cursor-models.json`, JSON.stringify(redact(models.body), null, 2));
  const resolved = resolveFamilies(items);
  writeFileSync(`${EVIDENCE}/role-resolution.json`, JSON.stringify({ resolved }, null, 2));
  console.log(
    "resolved",
    resolved.map((row) => `${row.family}=${row.chosen ?? "NONE"}`).join(" "),
  );

  const report: Record<string, unknown> = { resolved };

  const norepoId = `bc-${randomUUID()}`;
  const norepoBody = {
    agentId: norepoId,
    name: "dexter-g1-norepo",
    prompt: {
      text: "Create the file artifacts/spike.txt containing exactly the word ok. Do not use a repository. Do not call any other tool.",
    },
  };
  const created = await api(key, "POST", "/v1/agents", norepoBody);
  const createdAgent = asRecord(asRecord(created.body).agent);
  const createdRun = asRecord(asRecord(created.body).run);
  report.norepo = {
    http: created.status,
    clientAgentId: norepoId,
    agentId: createdAgent.id ?? null,
    runId: createdRun.id ?? null,
    initialStatus: createdRun.status ?? null,
  };
  console.log("norepo_http", created.status, "run", createdRun.status ?? "");

  const duplicate = await api(key, "POST", "/v1/agents", norepoBody);
  const duplicateBody = asRecord(duplicate.body);
  report.duplicate = {
    http: duplicate.status,
    code: duplicateBody.code ?? duplicateBody.error ?? null,
  };
  console.log("duplicate_http", duplicate.status);

  const agentId = String(createdAgent.id ?? norepoId);
  const runId = String(createdRun.id ?? "");
  if (created.status === 200 && runId) {
    report.norepoWait = await waitRun(key, agentId, runId, 8 * 60 * 1000);
    console.log("norepo_terminal", JSON.stringify(report.norepoWait));
    const usage = await api(key, "GET", `/v1/agents/${agentId}/usage?runId=${encodeURIComponent(runId)}`);
    const usageBody = asRecord(usage.body);
    report.usage = { http: usage.status, runCount: Array.isArray(usageBody.runs) ? usageBody.runs.length : 0 };
    console.log("usage_http", usage.status);
    const artifacts = await api(key, "GET", `/v1/agents/${agentId}/artifacts`);
    const list = asRecord(artifacts.body).artifacts ?? asRecord(artifacts.body).items ?? [];
    const paths = Array.isArray(list)
      ? list.map((item) => String(asRecord(item).path ?? "")).filter(Boolean)
      : [];
    report.artifacts = { http: artifacts.status, paths };
    console.log("artifact_paths", paths.join(",") || "none");
    const wanted = paths.find((path) => path.endsWith("spike.txt")) ?? paths[0];
    if (wanted) {
      const download = await api(
        key,
        "GET",
        `/v1/agents/${agentId}/artifacts/download?path=${encodeURIComponent(wanted)}`,
      );
      const url = String(asRecord(download.body).url ?? "");
      if (download.status === 200 && url.startsWith("https://")) {
        const file = await fetch(url);
        const bytes = Buffer.from(await file.arrayBuffer());
        const out = `${EVIDENCE}/spike.txt`;
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, bytes);
        report.download = { http: file.status, bytes: bytes.length, path: wanted };
        console.log("download_bytes", bytes.length);
      } else {
        report.download = { http: download.status, bytes: 0 };
        console.log("download_http", download.status);
      }
    }
  }

  const cancelId = `bc-${randomUUID()}`;
  const cancelCreate = await api(key, "POST", "/v1/agents", {
    agentId: cancelId,
    name: "dexter-g1-cancel",
    prompt: { text: "Think for a long time about the number one. Do not finish quickly." },
  });
  const cancelAgent = String(asRecord(asRecord(cancelCreate.body).agent).id ?? cancelId);
  const cancelRun = String(asRecord(asRecord(cancelCreate.body).run).id ?? "");
  let cancelResult: Record<string, unknown> = { createHttp: cancelCreate.status };
  if (cancelRun) {
    const cancel = await api(key, "POST", `/v1/agents/${cancelAgent}/runs/${cancelRun}/cancel`);
    const waited = await waitRun(key, cancelAgent, cancelRun, 3 * 60 * 1000);
    cancelResult = { createHttp: cancelCreate.status, cancelHttp: cancel.status, ...waited };
  }
  report.cancel = cancelResult;
  console.log("cancel", JSON.stringify(cancelResult));

  const planId = `bc-${randomUUID()}`;
  const planCreate = await api(key, "POST", "/v1/agents", {
    agentId: planId,
    name: "dexter-g1-plan",
    mode: "plan",
    prompt: { text: "Write a five-line plan for a one-page static site. Do not edit a repository." },
  });
  const planAgent = String(asRecord(asRecord(planCreate.body).agent).id ?? planId);
  const planRun = String(asRecord(asRecord(planCreate.body).run).id ?? "");
  let planResult: Record<string, unknown> = { http: planCreate.status };
  if (planCreate.status === 200 && planRun) {
    planResult = { http: planCreate.status, ...(await waitRun(key, planAgent, planRun, 8 * 60 * 1000)) };
  }
  report.plan = planResult;
  console.log("plan", JSON.stringify(planResult));

  writeFileSync(`${EVIDENCE}/cursor-lifecycle.json`, JSON.stringify(redact(report), null, 2));
  const familiesOk = resolved.every((row) => row.chosen);
  const norepoOk = asRecord(report.norepoWait).status === "FINISHED";
  const duplicateOk = duplicate.status === 409;
  const cancelOk = asRecord(report.cancel).status === "CANCELLED";
  const planOk = asRecord(report.plan).status === "FINISHED";
  console.log(
    "summary",
    JSON.stringify({ familiesOk, norepoOk, duplicateOk, cancelOk, planOk }),
  );
  if (!familiesOk || !norepoOk || !duplicateOk || !cancelOk || !planOk) process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "failed";
  console.log("fatal", message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 200));
  process.exit(1);
});
