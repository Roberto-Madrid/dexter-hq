import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RoleSheet } from "../kernel/types.ts";
import type { DeployAttempt } from "./approval.ts";
import { bundledUpgradeTasks } from "./bundled-assets.ts";
import { callConnectorTool, PER_REQUEST_LAUNCH_CAP, type ConnectorDeps } from "./connector.ts";
import {
  COUNCIL_UPGRADE_ACTION,
  HQ_ONLY_APPROVAL_ACTIONS,
  MODEL_UPGRADE_ACTION,
  UPGRADE_BOT_NAME,
  UPGRADE_CHECK_DONE,
  UPGRADE_ROLLBACK_ACTION,
  type ConnectorAgent,
  type ConnectorApproval,
  type ConnectorAuth,
  type ConnectorEvent,
  type ConnectorRequest,
  type ConnectorStore,
  type ModelOutcomeRow,
  type PinSwitch,
} from "./connector-store.ts";
import { DESIGN_SKETCH_ROLES } from "./design-gate.ts";

export { COUNCIL_UPGRADE_ACTION, UPGRADE_CHECK_DONE, UPGRADE_ROLLBACK_ACTION };

/** `owner/name` of the private repo the saved tasks run in (seeded from workers/checker-sample). */
export const SANDBOX_ENV = "DEXTER_UPGRADE_SANDBOX_REPO";
/** Appended when the owner approves a `model_upgrade` card; its target is the check id (that card's id). */
export const UPGRADE_CHECK_STARTED = "upgrade_check_started";
/** Appended once when an open check cannot run yet (for example `sandbox_repo_missing`). */
export const UPGRADE_CHECK_WAITING = "upgrade_check_waiting";
export const UPGRADE_APPROVAL_ACTIONS = HQ_ONLY_APPROVAL_ACTIONS;

const TASKS_DIR = "config/upgrade-tasks";
const CAP_REFUSALS = new Set(["agent_cap", "surge_cap", "per_repo_cap", "request_cap"]);
const GRADED_STATUSES = new Set(["finished", "error", "cancelled", "expired"]);
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type UpgradeTask = { id: string; title: string; brief: string };

function tasksFrom(entries: [string, string][]): UpgradeTask[] {
  return entries
    .filter(([name]) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, text]) => ({
      id: name.replace(/\.md$/, ""),
      title: text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? name,
      brief: text.trim(),
    }));
}

/** The family's saved tasks from `config/upgrade-tasks/<family>/`, or from the bundle when the folder is not on disk. */
export function loadUpgradeTasks(family: string, dir = TASKS_DIR): UpgradeTask[] {
  if (!/^[a-z0-9-]+$/.test(family)) return [];
  const folder = join(dir, family);
  try {
    return tasksFrom(readdirSync(folder).map((name): [string, string] => [name, readFileSync(join(folder, name), "utf8")]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const bundled = bundledUpgradeTasks();
    if (!bundled) return [];
    const prefix = `${family}/`;
    return tasksFrom(
      Object.entries(bundled)
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, text]): [string, string] => [path.slice(prefix.length), text]),
    );
  }
}

/** One run per family, version and task: the launch idempotency key. */
export function upgradeRunKey(family: string, version: string, taskId: string): string {
  return `upgrade:${family}:${version}:${taskId}`;
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Deterministic uuid (v5 layout), so a second write of the same card, post, or request hits its primary key. */
export function stableUuid(seed: string): string {
  const h = sha(`dexter-hq:${seed}`);
  const variant = ((parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A branch per run, so runs of the same task on two versions never push to one branch. The name carries no model. */
export function upgradeBranch(taskId: string, key: string): string {
  return `upgrade-check/${taskId}-${sha(key).slice(0, 8)}`;
}

export type UpgradeGrade = { passed: boolean; checksFailed: number };
/** Returns null while the run is not finished yet. */
export type UpgradeGrader = (agent: ConnectorAgent) => Promise<UpgradeGrade | null> | UpgradeGrade | null;

/**
 * dexter-shortcut: a run passes when Cursor reports FINISHED (weaker grading: it does not run the task's done-command);
 * upgrade path: dispatch the pinned Checker on the run's pushed branch and grade on its conclusion.
 */
export async function defaultUpgradeGrader(agent: ConnectorAgent): Promise<UpgradeGrade | null> {
  if (!GRADED_STATUSES.has(agent.status)) return null;
  return agent.status === "finished" ? { passed: true, checksFailed: 0 } : { passed: false, checksFailed: 1 };
}

export type UpgradeRun = {
  auth: ConnectorAuth;
  role: string;
  brief: string;
  idempotencyKey: string;
  requestId: string;
  repo: string;
  modelId: string;
};
export type UpgradeRunner = (run: UpgradeRun) => Promise<{ status: string; reason?: string }>;

/** The default runner: the normal connector launch (caps, STOP, idempotency, events) with the trusted model override. */
export function connectorUpgradeRunner(deps: ConnectorDeps): UpgradeRunner {
  return async (run) => {
    const result = await callConnectorTool(
      deps,
      run.auth,
      "launch_agent",
      { role: run.role, brief: run.brief, idempotencyKey: run.idempotencyKey, requestId: run.requestId, repo: run.repo },
      { modelOverride: run.modelId },
    );
    const body = result.structuredContent;
    return { status: String(body.status ?? "error"), ...(typeof body.reason === "string" ? { reason: body.reason } : {}) };
  };
}

/** The role a family's saved tasks launch as: the sheet's first non-design role on that family, else the CEO seat. */
export function upgradeRoleFor(sheet: RoleSheet, family: string): string | null {
  for (const [role, row] of Object.entries(sheet.roles)) {
    if (row.family === family && !DESIGN_SKETCH_ROLES.has(role)) return role;
  }
  return sheet.ceo.family === family ? "ceo" : null;
}

/** Worker families switch on a pass (with a rollback card); the CEO family waits for the owner (role sheet policy). */
export function ownerTapFamily(sheet: RoleSheet, family: string): boolean {
  return sheet.ceo.family === family;
}

export type UpgradeCheckStatus =
  | "stopped"
  | "sandbox_repo_missing"
  | "not_configured"
  | "running"
  | "adopted"
  | "awaiting_owner"
  | "kept"
  | "cancelled"
  | "pin_moved"
  | "already_pinned"
  | "no_current_pin"
  | "no_saved_tasks"
  | "launch_refused";

export type UpgradeCheckSummary = {
  checkId: string;
  family: string;
  incoming: string;
  current: string | null;
  status: UpgradeCheckStatus;
  launched: number;
  graded: number;
  reason?: string;
};

export type UpgradeTickResult = { checks: UpgradeCheckSummary[] };

type OpenCheck = { checkId: string; ownerId: string; family: string; incoming: string; current: string | null };

function openCheckFrom(event: ConnectorEvent): OpenCheck | null {
  const result = event.result ?? {};
  if (typeof result.family !== "string" || typeof result.incoming !== "string") return null;
  return {
    checkId: event.target,
    ownerId: event.ownerId,
    family: result.family,
    incoming: result.incoming,
    current: typeof result.current === "string" && result.current ? result.current : null,
  };
}

type Side = "incoming" | "baseline";
type PlannedRun = { side: Side; version: string; task: UpgradeTask; key: string; agent: ConnectorAgent | null; outcome: ModelOutcomeRow | null };
type Tally = { version: string; passed: number; total: number };

function tally(runs: PlannedRun[], side: Side, version: string): Tally {
  const mine = runs.filter((run) => run.side === side);
  return { version, passed: mine.filter((run) => run.outcome?.passed).length, total: mine.length };
}

function requestIdFor(check: OpenCheck, side: Side): string {
  return stableUuid(`upgrade-request:${check.checkId}:${side}`);
}

async function savePostOnce(store: ConnectorStore, ownerId: string, seed: string, body: string): Promise<boolean> {
  const id = stableUuid(`upgrade-post:${seed}`);
  if (await store.getPost(id)) return false;
  await store.savePost({ id, ownerId, type: "alert", author: "hq", body, repo: null, verified: true });
  return true;
}

type AdvanceContext = {
  deps: ConnectorDeps;
  at: string;
  sandbox: string | null;
  stopped: boolean;
  runner: UpgradeRunner | null;
  grader: UpgradeGrader;
  tasks: (family: string) => UpgradeTask[];
};

/**
 * One tick of every open upgrade check (started by the owner's tap, not done yet). Grades runs that finished, then
 * launches the runs still missing through the capped connector path, then decides once every run has an outcome.
 * Nothing here calls Cursor directly: launches go through the connector and reconcile closes the runs.
 */
export async function advanceUpgradeChecks(input: {
  deps: ConnectorDeps;
  env?: Record<string, string | undefined> | NodeJS.ProcessEnv;
  runner?: UpgradeRunner;
  grader?: UpgradeGrader;
  tasks?: (family: string) => UpgradeTask[];
  /** Only these owners' checks (tests share one database). */
  ownerIds?: string[];
}): Promise<UpgradeTickResult> {
  const { deps } = input;
  const events = await deps.store.listEventsByAction([UPGRADE_CHECK_STARTED, UPGRADE_CHECK_DONE]);
  const done = new Set(events.filter((event) => event.action === UPGRADE_CHECK_DONE).map((event) => event.target));
  const seen = new Set<string>();
  const open: OpenCheck[] = [];
  for (const event of events) {
    if (event.action !== UPGRADE_CHECK_STARTED || done.has(event.target) || seen.has(event.target)) continue;
    if (input.ownerIds && !input.ownerIds.includes(event.ownerId)) continue;
    const check = openCheckFrom(event);
    if (!check) continue;
    seen.add(check.checkId);
    open.push(check);
  }
  if (open.length === 0) return { checks: [] };
  const env = input.env ?? process.env;
  const raw = env[SANDBOX_ENV]?.trim() ?? "";
  const ctx: AdvanceContext = {
    deps,
    at: (deps.now ?? (() => new Date().toISOString()))(),
    sandbox: REPO_RE.test(raw) ? raw : null,
    stopped: await deps.store.stopped(),
    runner: input.runner ?? (deps.cursorConfigured && deps.cursor ? connectorUpgradeRunner(deps) : null),
    grader: input.grader ?? defaultUpgradeGrader,
    tasks: input.tasks ?? ((family) => loadUpgradeTasks(family)),
  };
  const checks: UpgradeCheckSummary[] = [];
  for (const check of open) checks.push(await advanceOne(ctx, check));
  return { checks };
}

async function advanceOne(ctx: AdvanceContext, check: OpenCheck): Promise<UpgradeCheckSummary> {
  const { store } = ctx.deps;
  const base = { checkId: check.checkId, family: check.family, incoming: check.incoming, current: check.current, launched: 0, graded: 0 };
  // STOP ALL: the check neither launches nor decides. The connector would refuse the launches anyway.
  if (ctx.stopped) return { ...base, status: "stopped" };
  if (!check.current) return finish(ctx, check, base, { status: "no_current_pin" });
  if (check.current === check.incoming) return finish(ctx, check, base, { status: "already_pinned" });
  if (!ctx.sandbox) {
    const posted = await savePostOnce(
      store,
      check.ownerId,
      `${check.checkId}:sandbox_repo_missing`,
      `Upgrade check for ${check.incoming} (${check.family}) is waiting: sandbox_repo_missing. Set ${SANDBOX_ENV} to the private sandbox repo (owner/name); the check starts on the next tick after that. The pin stays ${check.current}.`,
    );
    if (posted) {
      await store.appendEvent({ ownerId: check.ownerId, actor: "hq", action: UPGRADE_CHECK_WAITING, target: check.checkId, result: { reason: "sandbox_repo_missing" }, at: ctx.at });
    }
    return { ...base, status: "sandbox_repo_missing" };
  }
  if (!ctx.runner) return { ...base, status: "not_configured" };
  // dexter-shortcut: at most PER_REQUEST_LAUNCH_CAP tasks per side, so one request per side always fits its cap; upgrade path: split sides into more requests if a family ever needs more than 5 saved tasks.
  const tasks = ctx.tasks(check.family).slice(0, PER_REQUEST_LAUNCH_CAP);
  const role = upgradeRoleFor(ctx.deps.sheet, check.family);
  if (tasks.length === 0 || !role) return finish(ctx, check, base, { status: "no_saved_tasks" });

  const bot = await store.ensureInternalBot({ ownerId: check.ownerId, name: UPGRADE_BOT_NAME, kind: "other", repos: [ctx.sandbox], at: ctx.at });
  const requests = await Promise.all((["incoming", "baseline"] as const).map((side) => store.getRequest(requestIdFor(check, side))));
  // STOP ALL cancels open requests; a check whose request was cancelled ends here and keeps the pin.
  if (requests.some((row) => row?.status === "cancelled")) return finish(ctx, check, base, { status: "cancelled" }, bot.id);

  const mine = (await store.listAgents()).filter((agent) => agent.botId === bot.id);
  const outcomes = new Map((await store.listModelOutcomes(check.ownerId)).map((row) => [row.runId, row]));
  const resolutions = await store.listModelResolutions(check.ownerId);
  const rowIdFor = (version: string) =>
    resolutions.filter((row) => row.family === check.family && row.version === version && row.id).at(-1)?.id ?? null;
  const runs: PlannedRun[] = [];
  for (const [side, version] of [["incoming", check.incoming], ["baseline", check.current]] as const) {
    for (const task of tasks) {
      const key = upgradeRunKey(check.family, version, task.id);
      const agent = mine.find((row) => row.idempotencyKey === key) ?? null;
      runs.push({ side, version, task, key, agent, outcome: agent ? (outcomes.get(agent.id) ?? null) : null });
    }
  }

  // 1. Grade runs that finished since the last tick (one outcome per run, even across overlapping ticks).
  let graded = 0;
  for (const run of runs) {
    if (!run.agent || run.outcome) continue;
    const grade = await ctx.grader(run.agent);
    if (!grade) continue;
    const row = { ownerId: check.ownerId, runId: run.agent.id, modelRowId: rowIdFor(run.version), passed: grade.passed, checksFailed: grade.checksFailed, at: ctx.at };
    if (await store.recordModelOutcome(row)) graded += 1;
    run.outcome = { ...row, id: "" };
  }
  if (runs.every((run) => run.outcome)) return decide(ctx, check, { ...base, graded }, runs, bot.id);

  // 2. Launch what is still missing, new version first. A cap refusal waits for the next tick.
  const auth: ConnectorAuth = { ...bot, scopes: ["launch_agent"], suspended: false };
  let launched = 0;
  for (const run of runs) {
    if (run.agent && run.agent.status !== "launch_failed") continue;
    const requestId = await ensureRequest(store, check, run.side, run.version, bot.id, ctx.sandbox, tasks.length, requests);
    const brief = run.task.brief.replaceAll("{{branch}}", upgradeBranch(run.task.id, run.key));
    const result = await ctx.runner({ auth, role, brief, idempotencyKey: run.key, requestId, repo: ctx.sandbox, modelId: run.version });
    if (result.status === "launched") {
      launched += 1;
      continue;
    }
    if (result.status === "stopped" || CAP_REFUSALS.has(result.reason ?? "")) break;
    if (result.status === "not-configured") return { ...base, graded, launched, status: "not_configured" };
    // A replay or an in-flight launch from an overlapping tick; a failed launch retries next tick with the same key.
    if (result.status === "idempotent" || result.reason === "launch_in_progress" || result.status === "error") continue;
    return finish(ctx, check, { ...base, graded, launched }, { status: "launch_refused", reason: result.reason ?? result.status }, bot.id);
  }
  await store.heartbeat(bot.id, `upgrade check ${check.family} ${check.incoming}`, ctx.at);
  return { ...base, graded, launched, status: "running" };
}

async function ensureRequest(
  store: ConnectorStore,
  check: OpenCheck,
  side: Side,
  version: string,
  botId: string,
  repo: string,
  taskCount: number,
  known: (ConnectorRequest | null)[],
): Promise<string> {
  const id = requestIdFor(check, side);
  if (known.some((row) => row?.id === id) || (await store.getRequest(id))) return id;
  const what = side === "incoming" ? "new version" : "current pin baseline";
  const row: ConnectorRequest = {
    id,
    ownerId: check.ownerId,
    goal: `Upgrade check ${check.family}: ${version} (${what}), ${taskCount} saved tasks`,
    status: "running",
    card: {
      crew: "upgrade_check",
      tier: "T1",
      definitionOfDone: `Every saved ${check.family} task has a graded run on ${version}.`,
      newScreen: false,
      requiresDesignApproval: false,
    },
    evidence: [],
    assignedBotId: botId,
    repo,
    notices: [],
  };
  await store.saveRequest(row);
  known.push(row);
  return id;
}

async function decide(ctx: AdvanceContext, check: OpenCheck, base: Omit<UpgradeCheckSummary, "status">, runs: PlannedRun[], botId: string) {
  const incoming = tally(runs, "incoming", check.incoming);
  const current = tally(runs, "baseline", check.current ?? "");
  // Pass rate at least the current pin's: incoming.passed/incoming.total >= current.passed/current.total.
  const passed = incoming.total > 0 && incoming.passed * Math.max(current.total, 1) >= current.passed * incoming.total;
  if (!passed) return finish(ctx, check, base, { status: "kept", incoming, current }, botId);
  return finish(ctx, check, base, { status: ownerTapFamily(ctx.deps.sheet, check.family) ? "awaiting_owner" : "adopted", incoming, current }, botId);
}

type Verdict = { status: UpgradeCheckStatus; reason?: string; incoming?: Tally; current?: Tally };

function score(row?: Tally): string {
  return row ? `${row.passed}/${row.total}` : "-";
}

function noticeFor(check: OpenCheck, verdict: Verdict): string {
  const from = check.current ?? "none";
  const scores = `${check.incoming} passed ${score(verdict.incoming)}, ${from} passed ${score(verdict.current)}`;
  switch (verdict.status) {
    case "adopted":
      return `Upgraded ${check.family} to ${check.incoming}: its check passed (${scores}). Launches now use ${check.incoming}. Tap Roll back on the Needs-you card to restore ${from}.`;
    case "awaiting_owner":
      return `Upgrade check for ${check.family} passed (${scores}). ${check.family} is the CEO family, so ${from} stays pinned until you approve the council_upgrade card.`;
    case "kept":
      return `Upgrade check for ${check.family}: ${scores}; kept ${from}.`;
    case "pin_moved":
      return `Upgrade check for ${check.family} passed (${scores}), but the pin moved off ${from} during the check; nothing switched.`;
    case "cancelled":
      return `Upgrade check for ${check.family} ${check.incoming} was cancelled (STOP ALL); kept ${from}.`;
    default:
      return `Upgrade check for ${check.family} ${check.incoming} ended: ${verdict.status}${verdict.reason ? ` (${verdict.reason})` : ""}; kept ${from}.`;
  }
}

/** Writes the decision once (pin switch + card + done event together), then the notice and the request states. */
async function finish(
  ctx: AdvanceContext,
  check: OpenCheck,
  base: Omit<UpgradeCheckSummary, "status">,
  verdict: Verdict,
  botId?: string,
): Promise<UpgradeCheckSummary> {
  const { store } = ctx.deps;
  const from = check.current ?? "";
  let pin: PinSwitch | undefined;
  let approval: ConnectorApproval | undefined;
  if (verdict.status === "adopted") {
    pin = { family: check.family, from, to: check.incoming, reason: `upgrade: check ${check.checkId} passed ${score(verdict.incoming)} vs ${score(verdict.current)}` };
    approval = rollbackCard(check.ownerId, check.checkId, check.family, check.incoming, from);
  } else if (verdict.status === "awaiting_owner") {
    approval = {
      id: stableUuid(`council_upgrade:${check.checkId}`),
      ownerId: check.ownerId,
      action: COUNCIL_UPGRADE_ACTION,
      target: `${check.family}:${from}->${check.incoming}`,
      status: "pending",
      requestId: null,
    };
  }
  let final = verdict;
  const result = (row: Verdict) => ({
    outcome: row.status,
    family: check.family,
    incomingVersion: check.incoming,
    currentVersion: check.current,
    ...(row.incoming ? { incoming: { passed: row.incoming.passed, total: row.incoming.total } } : {}),
    ...(row.current ? { current: { passed: row.current.passed, total: row.current.total } } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(approval && row === verdict ? { approvalId: approval.id } : {}),
  });
  let applied = await store.applyUpgradeDecision({ ownerId: check.ownerId, checkId: check.checkId, at: ctx.at, event: { actor: "hq", result: result(verdict) }, pin, approval });
  if (!applied.applied && applied.reason === "pin_moved") {
    final = { ...verdict, status: "pin_moved" };
    applied = await store.applyUpgradeDecision({ ownerId: check.ownerId, checkId: check.checkId, at: ctx.at, event: { actor: "hq", result: result(final) } });
  }
  // Another tick decided first: it owns the notice and the request states.
  if (!applied.applied) return { ...base, status: final.status, ...(final.reason ? { reason: final.reason } : {}) };
  await store.savePost({ id: stableUuid(`upgrade-post:${check.checkId}:done`), ownerId: check.ownerId, type: "alert", author: "hq", body: noticeFor(check, final), repo: null, verified: true });
  const ended = final.status === "adopted" || final.status === "awaiting_owner" ? "done" : "failed";
  for (const side of ["incoming", "baseline"] as const) {
    const row = await store.getRequest(requestIdFor(check, side));
    if (row && row.status === "running") await store.saveRequest({ ...row, status: ended });
  }
  if (botId) await store.heartbeat(botId, null, ctx.at);
  return { ...base, status: final.status, ...(final.reason ? { reason: final.reason } : {}) };
}

function rollbackCard(ownerId: string, seed: string, family: string, from: string, to: string): ConnectorApproval {
  return {
    id: stableUuid(`upgrade_rollback:${seed}`),
    ownerId,
    action: UPGRADE_ROLLBACK_ACTION,
    target: `${family}:${from}->${to}`,
    status: "pending",
    requestId: null,
  };
}

/** `family:version` (model_upgrade) or `family:from->to` (rollback, council). */
function parseTarget(target: string): { family: string; from: string | null; to: string } | null {
  const at = target.indexOf(":");
  if (at <= 0) return null;
  const family = target.slice(0, at);
  const rest = target.slice(at + 1);
  const arrow = rest.indexOf("->");
  if (arrow < 0) return rest ? { family, from: null, to: rest } : null;
  const from = rest.slice(0, arrow);
  const to = rest.slice(arrow + 2);
  return from && to ? { family, from, to } : null;
}

/**
 * Runs an approved upgrade card. `model_upgrade` starts the check (the tick advances it); `upgrade_rollback` restores the
 * previous pin; `council_upgrade` adopts the CEO family's new version and raises its rollback card. A pin that moved
 * since the card was raised is left alone.
 */
export async function executeUpgradeApproval(store: ConnectorStore, row: ConnectorApproval, at: string): Promise<DeployAttempt> {
  const target = parseTarget(row.target);
  if (!target) return { status: "error", reason: "bad_target", ran: false };
  if (row.action === MODEL_UPGRADE_ACTION) {
    const current = (await store.currentPins(row.ownerId)).find((pin) => pin.family === target.family)?.version ?? null;
    await store.appendEvent({
      ownerId: row.ownerId,
      actor: "owner",
      action: UPGRADE_CHECK_STARTED,
      target: row.id,
      result: { family: target.family, incoming: target.to, current },
      at,
    });
    return { status: "ok", reason: "upgrade_check_started", ran: true };
  }
  if (!target.from) return { status: "error", reason: "bad_target", ran: false };
  // Only a version this family has actually seen in the catalog can become the pin.
  const known = (await store.listModelResolutions(row.ownerId)).some((item) => item.family === target.family && item.version === target.to);
  if (!known) return { status: "error", reason: "unknown_version", ran: false };
  const reason =
    row.action === UPGRADE_ROLLBACK_ACTION
      ? `rollback: ${target.from} -> ${target.to} (owner tap ${row.id})`
      : `upgrade: owner tap ${row.id} after check passed`;
  const switched = await store.switchPin({ ownerId: row.ownerId, family: target.family, from: target.from, to: target.to, reason, at });
  if (!switched.switched) {
    await savePostOnce(store, row.ownerId, `${row.id}:pin_moved`, `Did not change ${target.family}: its pin is now ${switched.current ?? "unset"}, not ${target.from}.`);
    return { status: "error", reason: "pin_moved", ran: false };
  }
  if (row.action === UPGRADE_ROLLBACK_ACTION) {
    await savePostOnce(store, row.ownerId, `${row.id}:done`, `Rolled back ${target.family} to ${target.to} (was ${target.from}). Launches now use ${target.to}.`);
    return { status: "ok", reason: "rolled_back", ran: true };
  }
  const card = rollbackCard(row.ownerId, row.id, target.family, target.to, target.from);
  if (!(await store.getApproval(card.id))) await store.saveApproval(card);
  await savePostOnce(
    store,
    row.ownerId,
    `${row.id}:done`,
    `Upgraded ${target.family} to ${target.to} on your tap. Launches now use ${target.to}. Tap Roll back on the Needs-you card to restore ${target.from}.`,
  );
  return { status: "ok", reason: "adopted", ran: true };
}
