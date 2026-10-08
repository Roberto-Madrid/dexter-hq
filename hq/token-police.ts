// Token police, part A: connector-side gates. The rules and numbers come from agent-brake's
// token_police/checks.py (gate_exit, diffstat, secret_filename, skill_budget); the code is HQ's,
// because cloud agent VMs do not have agent-brake and the connector is the one place every bot passes.
import type { ConnectorAuth, ConnectorEvent, ConnectorRequest } from "./connector-store.ts";
import type { ConnectorDeps } from "./connector.ts";
import { PINNED_CHECKS, checkerPassedCurrentSha, requestIsBound, type CompareFile } from "./checker.ts";
import { BLOCKED_KIND, scrubSecrets, stableId } from "./board-notes.ts";

/** The first fail plus two retries; the third failed Checker run blocks the request. */
export const GATE_FAIL_LIMIT = 3;
export const BLOCKED_LOG_LINES = 5;
/** The fixed last part of every BLOCKED board post. */
export const BLOCKED_NEXT_STEP = "no more Checker runs on this request; Dexter re-plans it (new approach or new request) or asks the owner.";
const BLOCKED_LINE_CHARS = 200;
/** agent-brake `diffstat(path_cap=20)`. */
export const DIFF_PATH_CAP = 20;
/** agent-brake `skill_budget(max_words=349)`. */
export const SKILL_MAX_WORDS = 349;

export const SECRET_NAMES = new Set([".env", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials.json", "secrets.json"]);
export const SECRET_SUFFIXES = [".pem", ".p12", ".pfx", ".key"] as const;
// The repo convention: `.env.example` lists variable names only (AGENTS.md), so it is not a secret file.
const SECRET_NAME_ALLOWED = new Set([".env.example"]);

/** Approval kinds that need a passing gate verdict. */
export const GATED_APPROVAL_ACTIONS = new Set(["deploy", "merge", "stage_exit", "pr", "draft_pr", "open_pr", "pr_ready"]);
/** Of those, the PR and merge kinds also get the diff cap and the secret-filename scan. */
export const DIFF_GATED_ACTIONS = new Set(["merge", "pr", "draft_pr", "open_pr", "pr_ready"]);
const DEFAULT_BASE = "main";
const BASE_NAME = /^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

export type GateVerdict = {
  verdict: "pass" | "fail";
  sha: string | null;
  commands: { name: string; verdict: "pass" | "not_passed" | "missing" }[];
};

export type Diffstat = {
  filesChanged: number;
  insertions: number;
  deletions: number;
  shortstat: string;
  pathCap: number;
  verdict: "ok" | "over_cap";
};

export type Refusal = Record<string, unknown> & { status: "refused"; reason: string };

export function normalizeAction(action: string): string {
  return action.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function isSecretFilename(path: string): boolean {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (!name || SECRET_NAME_ALLOWED.has(name)) return false;
  return SECRET_NAMES.has(name) || name.startsWith(".env.") || SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Secret-shaped paths a diff adds or keeps. Deleting one is the fix, so removed files pass. */
export function secretFilenames(files: readonly CompareFile[]): string[] {
  return files.filter((file) => file.status !== "removed" && isSecretFilename(file.filename)).map((file) => file.filename);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `git diff --shortstat` numbers from the changed-file list. Counts paths, never reads a patch. */
export function diffstat(files: readonly CompareFile[], pathCap = DIFF_PATH_CAP): Diffstat {
  const insertions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return {
    filesChanged: files.length,
    insertions,
    deletions,
    shortstat: `${plural(files.length, "file changed", "files changed")}, ${plural(insertions, "insertion(+)", "insertions(+)")}, ${plural(deletions, "deletion(-)", "deletions(-)")}`,
    pathCap,
    verdict: files.length > pathCap ? "over_cap" : "ok",
  };
}

/** Whitespace-split word count, like agent-brake. Over means more than `maxWords`. */
export function skillBudget(text: string, maxWords = SKILL_MAX_WORDS): { words: number; maxWords: number; over: boolean } {
  const words = text.split(/\s+/).filter(Boolean).length;
  return { words, maxWords, over: words > maxWords };
}

/**
 * gate_exit for each named done-command. The named commands are the Checker's pinned checks, and the pinned
 * run's conclusion is their exit code: success means every one exited 0.
 */
export function gateVerdict(request: ConnectorRequest): GateVerdict {
  const run = request.checkRun ?? null;
  const passed = Boolean(run && checkerPassedCurrentSha(request) && run.repo === request.repo);
  const each = passed ? ("pass" as const) : run ? ("not_passed" as const) : ("missing" as const);
  return {
    verdict: passed ? "pass" : "fail",
    sha: run?.sha ?? null,
    commands: PINNED_CHECKS.map((name) => ({ name, verdict: each })),
  };
}

type GateState = { fails: number; blocked: boolean; blockedRecorded: boolean };

/** Distinct failed Checker runs (by nonce) since the request's last pass. Re-polling one failed run counts once. */
function gateState(events: readonly ConnectorEvent[], requestId: string, current?: string): GateState {
  const failed = new Set<string>();
  let blockedRecorded = false;
  for (const event of events) {
    if (event.target !== requestId) continue;
    if (event.action === "blocked") blockedRecorded = true;
    if (event.action !== "request_checks") continue;
    const status = event.result?.status;
    if (status === "ready") failed.clear();
    if (status === "failed" && typeof event.result?.nonce === "string") failed.add(event.result.nonce);
  }
  if (current) failed.add(current);
  return { fails: failed.size, blocked: blockedRecorded || failed.size >= GATE_FAIL_LIMIT, blockedRecorded };
}

// dexter-shortcut: reads the whole event log to count a request's fails; upgrade path: a target-filtered store query.
async function stateFor(deps: Pick<ConnectorDeps, "store">, requestId: string, current?: string): Promise<GateState> {
  return gateState(await deps.store.listEvents(), requestId, current);
}

export async function gateBlockedRefusal(deps: Pick<ConnectorDeps, "store">, requestId: string): Promise<Refusal | null> {
  const state = await stateFor(deps, requestId);
  if (!state.blocked) return null;
  return { status: "refused", reason: "gate_blocked", requestId, fails: state.fails, limit: GATE_FAIL_LIMIT };
}

/** The retry budget after a failed Checker run, counting this run. */
export async function gateAfterFail(
  deps: Pick<ConnectorDeps, "store">,
  requestId: string,
  nonce: string,
): Promise<{ fails: number; limit: number; retriesLeft: number }> {
  const state = await stateFor(deps, requestId, nonce);
  return { fails: state.fails, limit: GATE_FAIL_LIMIT, retriesLeft: Math.max(0, GATE_FAIL_LIMIT - state.fails) };
}

function blockedLog(evidence: readonly string[]): string[] {
  const failing = evidence.filter((line) => /:fail$|^checker:conclusion:|^checker:url:/.test(line));
  const rest = evidence.filter((line) => !failing.includes(line) && !line.startsWith("checker:workflow:") && !line.startsWith("checker:host:"));
  return [...failing, ...rest].slice(0, BLOCKED_LOG_LINES).map((line) => line.slice(0, BLOCKED_LINE_CHARS));
}

/** The BLOCKED board post's id: one per request, so a block posts once however often it is recorded. */
export function blockedPostId(ownerId: string, requestId: string): string {
  return stableId(`blocked:${ownerId}:${requestId}`);
}

/** Fixed template: `BLOCKED: <what failed>. Last check run: <run> on <sha12>. Next step: <BLOCKED_NEXT_STEP>` */
export function blockedPostBody(input: {
  repo: string | null;
  fails: number;
  limit: number;
  evidence: readonly string[];
  githubRunId?: string | null;
  nonce?: string | null;
  sha: string;
}): string {
  const failing = [...new Set(input.evidence.map((line) => /^checker:([a-z0-9_-]+):fail$/i.exec(line)?.[1]).filter((name): name is string => Boolean(name)))];
  const what = `Checker gate failed ${input.fails} of ${input.limit} runs on ${input.repo ?? "its repo"} (${failing.length > 0 ? failing.join(", ") : "conclusion failure"})`;
  const run = input.githubRunId ? input.githubRunId : input.nonce ? `nonce ${input.nonce.slice(0, 8)}` : "unknown";
  return `BLOCKED: ${what}. Last check run: ${run} on ${input.sha.slice(0, 12)}. Next step: ${BLOCKED_NEXT_STEP}`;
}

function checkerLink(evidence: readonly string[]): string | null {
  for (const line of evidence) {
    if (!line.startsWith("checker:url:")) continue;
    const value = line.slice("checker:url:".length);
    try {
      const url = new URL(value);
      if ((url.protocol === "https:" || url.protocol === "http:") && value.length <= 500) return value;
    } catch {
      // not a url; skip
    }
  }
  return null;
}

/** One board post per block (type alert, author hq, the request's mission scope). Safe to repeat. */
async function writeBlockedPost(
  deps: Pick<ConnectorDeps, "store" | "now">,
  request: ConnectorRequest,
  failure: { sha: string; evidence: readonly string[]; githubRunId?: string | null; nonce?: string | null },
  fails: number,
): Promise<void> {
  const id = blockedPostId(request.ownerId, request.id);
  if (await deps.store.getPost(id)) return;
  const body = scrubSecrets(
    blockedPostBody({ repo: request.repo, fails: Math.max(fails, GATE_FAIL_LIMIT), limit: GATE_FAIL_LIMIT, evidence: failure.evidence, githubRunId: failure.githubRunId, nonce: failure.nonce, sha: failure.sha }),
  );
  await deps.store.savePost({
    id,
    ownerId: request.ownerId,
    type: "alert",
    author: "hq",
    body,
    repo: request.repo,
    verified: false,
    authorId: null,
    status: null,
    verifiedBy: null,
    scope: "mission",
    requestId: request.id,
    runId: failure.githubRunId ?? null,
    sha: /^[0-9a-f]{7,40}$/i.test(failure.sha) ? failure.sha.toLowerCase() : null,
    link: checkerLink(failure.evidence),
    kind: BLOCKED_KIND,
    createdAt: (deps.now ?? (() => new Date().toISOString()))(),
  });
}

/**
 * Third fail: one `blocked` event (actor hq) with at most five log lines, and the request moves to blocked.
 * Safe to repeat: a second call finds the event and writes nothing.
 */
export async function recordGateBlocked(
  deps: Pick<ConnectorDeps, "store" | "now">,
  auth: ConnectorAuth,
  request: ConnectorRequest,
  failure: { sha: string; evidence: readonly string[]; githubRunId?: string | null; nonce?: string | null },
): Promise<Refusal> {
  const state = await stateFor(deps, request.id);
  const log = blockedLog(failure.evidence);
  const refusal: Refusal = { status: "refused", reason: "gate_blocked", requestId: request.id, fails: state.fails, limit: GATE_FAIL_LIMIT, log };
  if (state.blockedRecorded) {
    // The event is the block; the post follows it. A post lost to a crash is restored on the next record.
    await writeBlockedPost(deps, request, failure, state.fails);
    return refusal;
  }
  await deps.store.appendEvent({
    ownerId: request.ownerId,
    actor: "hq",
    action: "blocked",
    target: request.id,
    result: {
      status: "blocked",
      reason: "gate_failed",
      line: `BLOCKED: request ${request.id} failed its Checker gate ${state.fails} times (${GATE_FAIL_LIMIT - 1} retries used), last sha ${failure.sha.slice(0, 12)}.`,
      requestId: request.id,
      botId: auth.id,
      bot: auth.name,
      repo: request.repo,
      sha: failure.sha,
      fails: state.fails,
      limit: GATE_FAIL_LIMIT,
      log,
    },
    at: (deps.now ?? (() => new Date().toISOString()))(),
  });
  await writeBlockedPost(deps, request, failure, state.fails);
  const fresh = await deps.store.getRequest(request.id);
  if (fresh && fresh.status !== "done" && fresh.status !== "cancelled") await deps.store.saveRequest({ ...fresh, status: "blocked" });
  return refusal;
}

function safeDetail(error: unknown): string {
  const message = error instanceof Error ? `${error.name === "TimeoutError" ? "timeout " : ""}${error.message}` : "compare_failed";
  return message.replace(/[^A-Za-z0-9_ .:-]/g, "").slice(0, 80);
}

function text(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Runs before a deploy, merge, stage-exit or PR approval is saved. Fails closed: no request, no passing Checker
 * run on the current PR head, an unreadable diff, a diff over 20 paths, or a secret-shaped file all refuse.
 */
export async function approvalGate(
  deps: ConnectorDeps,
  args: Record<string, unknown>,
): Promise<{ ok: true; police: Record<string, unknown> | null } | { ok: false; body: Refusal }> {
  const action = normalizeAction(text(args, "action") ?? "");
  if (!GATED_APPROVAL_ACTIONS.has(action)) return { ok: true, police: null };
  const requestId = text(args, "requestId") ?? text(args, "request_id");
  const refuse = (reason: string, extra: Record<string, unknown> = {}) =>
    ({ ok: false, body: { status: "refused", reason, action, requestId, ...extra } }) as const;
  const row = requestId ? await deps.store.getRequest(requestId) : null;
  if (!row) return refuse("gate_request_required");
  const blocked = await gateBlockedRefusal(deps, row.id);
  if (blocked) return { ok: false, body: { ...blocked, action } };
  const gate = gateVerdict(row);
  if (gate.verdict !== "pass" || !gate.sha) return refuse("gate_not_passed", { gate });
  if (!requestIsBound(row) || !row.repo) return refuse("gate_requires_binding", { gate });
  if (!deps.checker?.head) return refuse("head_lookup_unavailable");
  let head: string | null;
  try {
    head = await deps.checker.head({ repo: row.repo, pullRequest: row.pullRequest ?? null, branch: row.branch ?? null });
  } catch {
    head = null;
  }
  if (!head) return refuse("head_lookup_failed");
  if (head.toLowerCase() !== gate.sha.toLowerCase()) return refuse("gate_stale_head", { head, checkedSha: gate.sha });
  if (!DIFF_GATED_ACTIONS.has(action)) return { ok: true, police: { gate } };

  // dexter-shortcut: compares against `main` (or a supplied `base`), not the PR's own base branch; upgrade path: read base.ref from the pulls API.
  const requestedBase = text(args, "base");
  const base = requestedBase && BASE_NAME.test(requestedBase) ? requestedBase : DEFAULT_BASE;
  if (!deps.checker.compare) return refuse("diffstat_unavailable", { detail: "not_configured" });
  let compared: Awaited<ReturnType<NonNullable<typeof deps.checker.compare>>>;
  try {
    compared = await deps.checker.compare({ repo: row.repo, base, head: gate.sha });
  } catch (error) {
    return refuse("diffstat_unavailable", { detail: safeDetail(error) });
  }
  const stat = diffstat(compared.files);
  if (stat.verdict === "over_cap" || compared.truncated) {
    return refuse("diff_too_large", { filesChanged: stat.filesChanged, pathCap: stat.pathCap, shortstat: stat.shortstat, truncated: compared.truncated });
  }
  const secrets = secretFilenames(compared.files);
  if (secrets.length > 0) return refuse("secret_filename", { files: secrets.slice(0, 10) });
  return { ok: true, police: { gate, diffstat: { ...stat, base } } };
}
