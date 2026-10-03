/**
 * G1 runner spike. Dispatches the workers workflows, cancels one run, and
 * downloads artifacts. Never prints tokens, job logs, or the Codex login.
 * Run: node --experimental-strip-types scripts/spikes/gh-runner-lifecycle.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EVIDENCE = ".agent-work/evidence/G1/runner";
const WORK = join(tmpdir(), "dexter-runner");
const REPO = "Roberto-Madrid/dexter-workers";

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

async function gh(token: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
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
      parsed = null;
    }
  }
  return { status: response.status, body: parsed };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function dispatch(token: string, workflow: string, inputs: Record<string, string>) {
  const result = await gh(token, "POST", `/repos/${REPO}/actions/workflows/${workflow}/dispatches`, {
    ref: "main",
    inputs,
  });
  if (result.status !== 204) throw new Error(`dispatch_${workflow}_${result.status}`);
}

async function findRun(token: string, workflow: string, title: string) {
  const started = Date.now();
  while (Date.now() - started < 3 * 60 * 1000) {
    const listed = await gh(token, "GET", `/repos/${REPO}/actions/workflows/${workflow}/runs?per_page=20`);
    const runs = (asRecord(listed.body).workflow_runs ?? []) as Record<string, unknown>[];
    const found = runs.find((run) => run.display_title === title || run.name === title);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`run_not_found_${title}`);
}

async function waitRun(token: string, id: number) {
  const started = Date.now();
  while (Date.now() - started < 25 * 60 * 1000) {
    const got = await gh(token, "GET", `/repos/${REPO}/actions/runs/${id}`);
    const run = asRecord(got.body);
    const status = String(run.status ?? "");
    if (status === "completed") return run;
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error(`run_timeout_${id}`);
}

async function download(token: string, url: string, dest: string) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`download_${response.status}`);
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
}

function secretHits(text: string): number {
  const patterns = [/eyJ[A-Za-z0-9_-]{10,}/, /sk-[A-Za-z0-9]{10,}/, /github_pat_/, /ghp_[A-Za-z0-9]{10,}/, /BEGIN AGE/, /age-encryption\.org/];
  return patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
}

function dossierOk(path: string): boolean {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const strings = (item: unknown) => Array.isArray(item) && item.every((entry) => typeof entry === "string");
  return (
    value.status === "done" &&
    strings(value.done) &&
    strings(value.verified) &&
    strings(value.unverified) &&
    Array.isArray(value.findings) &&
    Array.isArray(value.dead_ends) &&
    typeof value.next_action === "string"
  );
}

async function main() {
  const env = loadEnv();
  const token = env.GH_HQ_TOKEN;
  if (!token) {
    console.log("GH_HQ_TOKEN empty");
    process.exit(2);
  }
  mkdirSync(EVIDENCE, { recursive: true });
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const stamp = Date.now().toString(36);
  const checkerId = `checker-${stamp}`;
  const cancelId = `cancel-${stamp}`;
  const codexId = `codex-${stamp}`;

  await dispatch(token, "checker.yml", { run_id: checkerId });
  await dispatch(token, "agent-run.yml", {
    run_id: cancelId,
    spec_url: "repo:specs/sleep.json",
    runtime: "script",
    target_repo: "",
    target_ref: "main",
    provider: "opencode-go",
    model: "",
  });
  const checker = await findRun(token, "checker.yml", `checker-${checkerId}`);
  const sleeper = await findRun(token, "agent-run.yml", `dexter-${cancelId}`);
  const sleeperRunId = Number(sleeper.id);
  const polls = [String(sleeper.status)];
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const again = await gh(token, "GET", `/repos/${REPO}/actions/runs/${sleeperRunId}`);
  polls.push(String(asRecord(again.body).status ?? ""));
  const cancelled = await gh(token, "POST", `/repos/${REPO}/actions/runs/${sleeperRunId}/cancel`);
  const sleeperDone = await waitRun(token, sleeperRunId);

  await dispatch(token, "agent-run.yml", {
    run_id: codexId,
    spec_url: "repo:specs/codex.json",
    runtime: "codex",
    target_repo: "",
    target_ref: "main",
    provider: "opencode-go",
    model: "gpt-6.1-sol",
  });
  const codex = await findRun(token, "agent-run.yml", `dexter-${codexId}`);
  const checkerDone = await waitRun(token, Number(checker.id));
  const codexDone = await waitRun(token, Number(codex.id));

  const jobs = await gh(token, "GET", `/repos/${REPO}/actions/runs/${codex.id}/jobs`);
  let hits = 0;
  for (const job of (asRecord(jobs.body).jobs ?? []) as Record<string, unknown>[]) {
    const log = await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${job.id}/logs`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      redirect: "follow",
    });
    const text = await log.text();
    hits += secretHits(text);
  }

  const artifacts = await gh(token, "GET", `/repos/${REPO}/actions/runs/${codex.id}/artifacts`);
  const items = (asRecord(artifacts.body).artifacts ?? []) as Record<string, unknown>[];
  for (const item of items) {
    const name = String(item.name ?? "artifact");
    const dest = join(WORK, `${name}.zip`);
    await download(token, String(item.archive_download_url), dest);
    spawnSync("unzip", ["-o", dest, "-d", join(WORK, name)], { encoding: "utf8" });
  }
  const checkerArtifacts = await gh(token, "GET", `/repos/${REPO}/actions/runs/${checker.id}/artifacts`);
  const checkerItems = (asRecord(checkerArtifacts.body).artifacts ?? []) as Record<string, unknown>[];
  for (const item of checkerItems) {
    const name = String(item.name ?? "checker");
    const dest = join(WORK, `${name}.zip`);
    await download(token, String(item.archive_download_url), dest);
    spawnSync("unzip", ["-o", dest, "-d", join(WORK, name)], { encoding: "utf8" });
  }

  const dossierPath = join(WORK, `result-${codexId}`, "dossier.json");
  const agePath = join(WORK, `login-${codexId}`, "auth.json.age");
  const shot = join(WORK, `checker-${checkerId}`, "checker.png");
  let decryptOk = false;
  let decryptBytes = 0;
  if (statSync(agePath, { throwIfNoEntry: false })?.isFile()) {
    const header = readFileSync(agePath).subarray(0, 24).toString("utf8");
    const plain = join(tmpdir(), "dexter-runner-plain");
    const decoded = spawnSync("age", ["-d", "-i", join(process.env.HOME ?? "", ".dexter/hq-age.key"), "-o", plain, agePath], { encoding: "utf8" });
    if (decoded.status === 0 && statSync(plain).size > 0 && header.includes("age-encryption")) {
      decryptOk = true;
      decryptBytes = statSync(plain).size;
    }
    rmSync(plain, { force: true });
  }

  const report = {
    checker: { id: checker.id, conclusion: checkerDone.conclusion, shot: statSync(shot, { throwIfNoEntry: false })?.isFile() ?? false },
    cancel: { id: sleeperRunId, http: cancelled.status, polls, conclusion: sleeperDone.conclusion },
    codex: {
      id: codex.id,
      conclusion: codexDone.conclusion,
      dossier: statSync(dossierPath, { throwIfNoEntry: false })?.isFile() ? dossierOk(dossierPath) : false,
      login_persisted: decryptOk,
      login_bytes: decryptBytes,
      log_secret_hits: hits,
    },
    artifact_names: items.map((item) => item.name),
  };
  if (report.codex.dossier) copyFileSync(dossierPath, join(EVIDENCE, "dossier.json"));
  if (report.checker.shot) copyFileSync(shot, join(EVIDENCE, "checker.png"));
  rmSync(WORK, { recursive: true, force: true });
  writeFileSync(join(EVIDENCE, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  const ok =
    report.checker.conclusion === "success" &&
    report.checker.shot &&
    report.cancel.conclusion === "cancelled" &&
    report.codex.conclusion === "success" &&
    report.codex.dossier &&
    report.codex.login_persisted &&
    report.codex.log_secret_hits === 0;
  if (!ok) process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "failed";
  console.log("fatal", message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 200));
  process.exit(1);
});
