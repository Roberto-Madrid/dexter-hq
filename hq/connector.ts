import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createCursorCloud } from "../adapters/cursor-cloud.ts";
import { SHIPPED_CREWS } from "./crews.ts";
import { bundledRoleSheet } from "./bundled-assets.ts";
import { PlanCardSchema, VerdictSchema } from "../kernel/schemas.ts";
import { validatePlanCard } from "../kernel/plan-card.ts";
import { preflight } from "../kernel/preflight.ts";
import { SANDBOX_SLOT_CAP } from "../kernel/police.ts";
import { parseRoleSheet } from "../kernel/role-sheet.ts";
import { REQUEST_STATES, type PlanCard, type RoleSheet, type RunHandle, type Runtime, type Verdict } from "../kernel/types.ts";
import {
  CONNECTOR_TOOLS,
  createMemoryConnectorStore,
  isActiveAgent,
  withoutFollowupClaim,
  type ConnectorAgent,
  type ConnectorAuth,
  type ConnectorRequest,
  type ConnectorStore,
  type ConnectorToolName,
} from "./connector-store.ts";
import { parseCouncilVerdict, runCriticSeat } from "./council-seat.ts";
import {
  PINNED_CHECKER_WORKFLOW,
  applyCheckEvidence,
  bindingFromArgs,
  bindingMatches,
  checkerPassedCurrentSha,
  checksConfigured,
  checksMoveRequestReady,
  createGhChecker,
  evidenceFromOutcome,
  requestIsBound,
  sanitizeBotEvidence,
  type CheckerGateway,
} from "./checker.ts";
import { contextNotes, postNote, verifyNote } from "./board-notes.ts";
import { decisionTrail } from "./decision-trail.ts";
import { launchBlockedByDesignGate } from "./design-gate.ts";
import { composeLaunchBrief } from "./personas.ts";
import { closeIfTerminal, runHandleFor } from "./reconcile.ts";

export { CONNECTOR_TOOLS, createMemoryConnectorStore };
export type { ConnectorAuth, ConnectorStore, ConnectorToolName };

export const STUB_OWNER_ID = "00000000-0000-4000-8000-000000000000";
export const AGENT_SURGE_CAP = 6;
export const PER_REPO_CAP = 2;
export const PER_REQUEST_LAUNCH_CAP = 5;
export const COUNCIL_WEEKLY_SEAT_CAP = 40;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const STOP_EXEMPT = new Set<string>(["whoami", "heartbeat", "approval_status"]);
const KNOWN_HOSTS = ["github.com", "api.github.com"];

export type CursorGateway = Runtime & {
  followup?(handle: RunHandle, text: string): Promise<RunHandle>;
};

export type CouncilSeatFn = (input: { packet: string }) => Promise<Verdict>;

export type ConnectorDeps = {
  store: ConnectorStore;
  sheet: RoleSheet;
  cursor: CursorGateway | null;
  cursorConfigured: boolean;
  checker?: CheckerGateway | null;
  checkerConfigured?: boolean;
  knownHosts?: readonly string[];
  now?: () => string;
  ownerId?: string;
  councilConfigured?: boolean;
  runCouncilSeat?: CouncilSeatFn;
};

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
};

function toolResult(body: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    isError,
  };
}

export function hashBotToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function pathBCouncilConfigured(): boolean {
  return Boolean(process.env.SUPABASE_DB_URL?.trim() && process.env.DEXTER_AGE_PRIVATE_KEY?.trim());
}

export function loadConnectorSheetText(): string {
  try {
    return readFileSync("gateway/role-sheet.yaml", "utf8");
  } catch (error) {
    const bundled = bundledRoleSheet();
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && bundled) return bundled;
    throw error;
  }
}

export function familyForRole(sheet: RoleSheet, role: string): string | null {
  if (role === "ceo") return sheet.ceo.family;
  return sheet.roles[role]?.family ?? null;
}

function asArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function allowedTools(auth: ConnectorAuth | null): string[] {
  if (!auth) return ["whoami"];
  const scopes = auth.scopes.length > 0 ? auth.scopes : auth.tools;
  const listed = scopes.length > 0 ? scopes : [...CONNECTOR_TOOLS];
  return listed.includes("whoami") ? listed : ["whoami", ...listed];
}

function canCall(auth: ConnectorAuth | null, name: string): boolean {
  return allowedTools(auth).includes(name);
}

function namedModel(args: Record<string, unknown>): boolean {
  return ["model", "family", "version", "modelId", "model_id"].some((key) => key in args);
}

async function record(
  deps: ConnectorDeps,
  auth: ConnectorAuth | null,
  action: string,
  target: string,
  result: Record<string, unknown>,
): Promise<void> {
  await deps.store.appendEvent({
    ownerId: auth?.ownerId ?? deps.ownerId ?? STUB_OWNER_ID,
    actor: auth?.name ?? "anonymous",
    action,
    target,
    result,
    at: (deps.now ?? (() => new Date().toISOString()))(),
  });
}

function capsLeft(agents: ConnectorAgent[], repo: string | null): { agents: number; perRepo: number } {
  const active = agents.filter((item) => isActiveAgent(item.status));
  const repoActive = repo ? active.filter((item) => item.repo === repo).length : 0;
  return {
    agents: Math.max(0, SANDBOX_SLOT_CAP - active.length),
    perRepo: repo ? Math.max(0, PER_REPO_CAP - repoActive) : PER_REPO_CAP,
  };
}

async function whoamiBody(deps: ConnectorDeps, auth: ConnectorAuth | null): Promise<Record<string, unknown>> {
  const stopped = await deps.store.stopped();
  if (!auth) {
    return { id: "dexter-connector-stub", name: "Dexter connector", kind: "stub", scopes: [], stopped };
  }
  const agents = await deps.store.listAgents();
  return {
    id: auth.id,
    name: auth.name,
    kind: auth.kind,
    scopes: auth.scopes,
    stopped,
    capsLeft: capsLeft(agents, null),
    suspended: auth.suspended,
  };
}

async function handleLaunch(deps: ConnectorDeps, auth: ConnectorAuth, args: Record<string, unknown>): Promise<ToolResult> {
  if (namedModel(args)) {
    const body = { status: "refused", reason: "callers_never_name_a_model" };
    await record(deps, auth, "launch_agent", "refused", body);
    return toolResult(body, true);
  }
  const role = textArg(args, "role");
  const brief = textArg(args, "brief");
  const idempotencyKey = textArg(args, "idempotencyKey") ?? textArg(args, "idempotency_key");
  const repo = textArg(args, "repo");
  if (!role || !brief || !idempotencyKey) {
    const body = { status: "refused", reason: "role_brief_and_idempotency_key_required" };
    await record(deps, auth, "launch_agent", "refused", body);
    return toolResult(body, true);
  }
  const existing = await deps.store.findLaunch(auth.id, idempotencyKey);
  if (existing && existing.status !== "launch_failed") return launchReplay(deps, auth, existing);
  const family = familyForRole(deps.sheet, role);
  if (!family) {
    const body = { status: "refused", reason: "unknown_role" };
    await record(deps, auth, "launch_agent", role, body);
    return toolResult(body, true);
  }
  if (repo && !auth.repos.includes(repo)) {
    const body = { status: "refused", reason: "repo_out_of_scope" };
    await record(deps, auth, "launch_agent", repo, body);
    return toolResult(body, true);
  }
  if (!repo && auth.repos.length > 0 && auth.kind !== "scout") {
    const body = { status: "refused", reason: "repo_required" };
    await record(deps, auth, "launch_agent", role, body);
    return toolResult(body, true);
  }
  const requestId = textArg(args, "requestId") ?? textArg(args, "request_id");
  const approvalId = textArg(args, "approvalId") ?? textArg(args, "approval_id");
  const gate = await launchBlockedByDesignGate(deps.store, auth, {
    role,
    brief,
    args,
    requestId,
    approvalId,
  });
  if (gate.blocked) {
    const body = { status: "refused", reason: gate.reason ?? "design_approval_required", requestId };
    await record(deps, auth, "launch_agent", requestId ?? idempotencyKey, body);
    return toolResult(body, true);
  }
  const findings = preflight(brief, deps.knownHosts ?? KNOWN_HOSTS);
  if (findings.length > 0) {
    const body = { status: "needs_you", reason: "preflight", findings, requestId };
    await record(deps, auth, "launch_agent", idempotencyKey, body);
    return toolResult(body, true);
  }
  const { surge, cap } = await agentCap(deps, approvalId);
  // Atomic: the caps are checked and a `reserving` row inserted in one step, so two launches cannot both pass.
  const reservation = await deps.store.reserveLaunch({
    agent: {
      id: randomUUID(),
      ownerId: auth.ownerId,
      botId: auth.id,
      cursorHandle: null,
      repo,
      role,
      family,
      status: "reserving",
      idempotencyKey,
      result: null,
      createdAt: (deps.now ?? (() => new Date().toISOString()))(),
    },
    requestId,
    caps: { global: cap, perRepo: PER_REPO_CAP, perRequest: PER_REQUEST_LAUNCH_CAP },
  });
  if (!reservation.ok && reservation.reason === "duplicate") {
    if (reservation.existing) return launchReplay(deps, auth, reservation.existing);
    const body = { status: "refused", reason: "launch_in_progress" };
    await record(deps, auth, "launch_agent", idempotencyKey, body);
    return toolResult(body, true);
  }
  if (!reservation.ok) {
    const reason = reservation.reason === "agent_cap" && surge ? "surge_cap" : reservation.reason;
    const body = { status: "refused", reason, cap: reservation.cap };
    await record(deps, auth, "launch_agent", reason === "per_repo_cap" && repo ? repo : idempotencyKey, body);
    return toolResult(body, true);
  }
  const reserved = reservation.agent;
  const composed = composeLaunchBrief(role, brief);
  if (!deps.cursorConfigured || !deps.cursor) {
    const body = {
      status: "not-configured",
      configured: false,
      launched: false,
      persona: composed.persona,
      requestId,
    };
    await deps.store.saveAgent({ ...reserved, status: "not-configured", result: body });
    await record(deps, auth, "launch_agent", idempotencyKey, body);
    return toolResult(body, true);
  }
  try {
    const handle = await deps.cursor.start({ idempotencyKey, taskId: idempotencyKey, brief: composed.text });
    const body = {
      status: "launched",
      launched: true,
      agentId: handle.id,
      role,
      family,
      persona: composed.persona,
      requestId,
    };
    await deps.store.saveAgent({ ...reserved, cursorHandle: handle.id, status: "launched", result: body });
    await record(deps, auth, "launch_agent", handle.id, body);
    return toolResult(body);
  } catch {
    const body = { status: "error", launched: false, reason: "launch_failed", requestId };
    // The failed row frees its slot and lets the same idempotency key retry.
    await deps.store.saveAgent({ ...reserved, status: "launch_failed", result: body });
    await record(deps, auth, "launch_agent", idempotencyKey, body);
    return toolResult(body, true);
  }
}

async function agentCap(deps: ConnectorDeps, approvalId: string | null): Promise<{ surge: boolean; cap: number }> {
  const approval = approvalId ? await deps.store.getApproval(approvalId) : null;
  const surge = approval?.status === "approved" && approval.action === "surge";
  return { surge, cap: surge ? AGENT_SURGE_CAP : SANDBOX_SLOT_CAP };
}

async function launchReplay(deps: ConnectorDeps, auth: ConnectorAuth, existing: ConnectorAgent): Promise<ToolResult> {
  if (existing.status === "reserving") {
    const body = { status: "refused", reason: "launch_in_progress" };
    await record(deps, auth, "launch_agent", existing.idempotencyKey, body);
    return toolResult(body, true);
  }
  // A replay says what it is; the stored launch status travels as agentStatus.
  const body = { ...existing.result, status: "idempotent", agentStatus: existing.status };
  await record(deps, auth, "launch_agent", existing.cursorHandle ?? existing.id, body);
  return toolResult(body, existing.status === "not-configured" || existing.status === "refused");
}

async function ownAgent(deps: ConnectorDeps, auth: ConnectorAuth, args: Record<string, unknown>): Promise<ConnectorAgent | null> {
  const id = textArg(args, "agentId") ?? textArg(args, "agent_id");
  if (!id) return null;
  const agent = await deps.store.getAgent(id);
  if (!agent || agent.botId !== auth.id) return null;
  return agent;
}

async function handleAgentTool(
  deps: ConnectorDeps,
  auth: ConnectorAuth,
  name: "agent_status" | "followup_agent" | "cancel_agent",
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const agent = await ownAgent(deps, auth, args);
  if (!agent) {
    const body = { status: "refused", reason: "not_own_agent" };
    await record(deps, auth, name, textArg(args, "agentId") ?? "missing", body);
    return toolResult(body, true);
  }
  if (!deps.cursorConfigured || !deps.cursor) {
    const body = { status: "not-configured", configured: false };
    await record(deps, auth, name, agent.cursorHandle ?? agent.id, body);
    return toolResult(body, true);
  }
  if (!agent.cursorHandle) {
    const body = { status: "not-configured", configured: false, launched: false };
    await record(deps, auth, name, agent.id, body);
    return toolResult(body, true);
  }
  const handle = { id: agent.cursorHandle, runtime: "cursor-cloud" };
  try {
    if (name === "agent_status") {
      const status = await deps.cursor.status({ id: runHandleFor(agent) ?? handle.id, runtime: handle.runtime });
      await closeIfTerminal(deps.store, agent, status, (deps.now ?? (() => new Date().toISOString()))());
      const body = { status: status.state, usage: status.usage, agentId: handle.id };
      await record(deps, auth, name, handle.id, { status: status.state });
      return toolResult(body);
    }
    if (name === "cancel_agent") {
      const result = await deps.cursor.cancel(handle);
      agent.status = "cancelled";
      await deps.store.saveAgent(agent);
      const body = { status: result.state, agentId: handle.id };
      await record(deps, auth, name, handle.id, body);
      return toolResult(body);
    }
    const text = textArg(args, "brief") ?? textArg(args, "text") ?? "";
    if (!deps.cursor.followup) {
      const body = { status: "not-configured", configured: false };
      await record(deps, auth, name, handle.id, body);
      return toolResult(body, true);
    }
    // Atomic, under the launch lock: an active agent is claimed; a finished one reopens only within the caps;
    // a cancelled one is refused. The claim also stops the tick from closing the run while Cursor answers.
    const approvalId = textArg(args, "approvalId") ?? textArg(args, "approval_id");
    const { surge, cap } = await agentCap(deps, approvalId);
    const claim = await deps.store.reserveFollowup({
      id: agent.id,
      caps: { global: cap, perRepo: PER_REPO_CAP },
      at: (deps.now ?? (() => new Date().toISOString()))(),
    });
    if (!claim.ok) {
      const reason = claim.reason === "agent_cap" && surge ? "surge_cap" : claim.reason;
      const body = "cap" in claim ? { status: "refused", reason, cap: claim.cap } : { status: "refused", reason };
      await record(deps, auth, name, handle.id, body);
      return toolResult(body, true);
    }
    const previous = claim.previous;
    let next: RunHandle;
    try {
      next = await deps.cursor.followup(handle, text);
    } catch (error) {
      await deps.store.setAgentStatus({ id: agent.id, from: ["reserving"], status: previous.status, result: previous.result });
      throw error;
    }
    await deps.store.setAgentStatus({
      id: agent.id,
      from: ["reserving"],
      status: "running",
      result: { ...withoutFollowupClaim(previous.result), latestRunHandle: next.id },
    });
    const body = { status: "followed_up", agentId: next.id };
    await record(deps, auth, name, next.id, body);
    return toolResult(body);
  } catch {
    const body = { status: "error", reason: `${name}_failed` };
    await record(deps, auth, name, handle.id, body);
    return toolResult(body, true);
  }
}

async function handleOpenRequest(deps: ConnectorDeps, auth: ConnectorAuth, args: Record<string, unknown>): Promise<ToolResult> {
  const goal = textArg(args, "goal");
  const rawCard = args.card;
  const parsed = PlanCardSchema.safeParse(rawCard);
  if (!goal || !parsed.success) {
    const body = { status: "refused", reason: "invalid_plan_card" };
    await record(deps, auth, "open_request", "refused", body);
    return toolResult(body, true);
  }
  const bound = bindingFromArgs(args);
  if (!bound.ok) {
    const body = { status: "refused", reason: "invalid_binding" };
    await record(deps, auth, "open_request", "refused", body);
    return toolResult(body, true);
  }
  const validated = validatePlanCard(parsed.data as PlanCard, SHIPPED_CREWS);
  const id = randomUUID();
  const status = validated.card.requiresApproval || validated.card.requiresDesignApproval ? "needs_you" : "queued";
  await deps.store.saveRequest({
    id,
    ownerId: auth.ownerId,
    goal,
    status,
    card: { ...validated.card, notices: validated.notices },
    evidence: [],
    assignedBotId: auth.id,
    repo: textArg(args, "repo"),
    notices: validated.notices,
    pullRequest: bound.binding.pullRequest,
    branch: bound.binding.branch,
  });
  let designApprovalId: string | null = null;
  if (validated.card.requiresDesignApproval) {
    designApprovalId = randomUUID();
    await deps.store.saveApproval({
      id: designApprovalId,
      ownerId: auth.ownerId,
      action: "design",
      target: id,
      status: "pending",
      requestId: id,
    });
  }
  const body = {
    status: "opened",
    requestId: id,
    requestStatus: status,
    notices: validated.notices,
    designApprovalId,
  };
  await record(deps, auth, "open_request", id, body);
  return toolResult(body);
}

async function handleUpdateRequest(deps: ConnectorDeps, auth: ConnectorAuth, args: Record<string, unknown>): Promise<ToolResult> {
  const id = textArg(args, "requestId") ?? textArg(args, "request_id");
  const status = textArg(args, "status");
  let row = id ? await deps.store.getRequest(id) : null;
  if (!row) {
    const body = { status: "refused", reason: "unknown_request" };
    await record(deps, auth, "update_request", id ?? "missing", body);
    return toolResult(body, true);
  }
  if (!botMayMutateRequest(auth, row)) {
    const body = { status: "refused", reason: "not_own_request", requestId: row.id };
    await record(deps, auth, "update_request", row.id, body);
    return toolResult(body, true);
  }
  if (status && !(REQUEST_STATES as readonly string[]).includes(status)) {
    const body = { status: "refused", reason: "invalid_status" };
    await record(deps, auth, "update_request", row.id, body);
    return toolResult(body, true);
  }
  if (status === "ready_for_review") {
    const body = { status: "refused", reason: "ready_requires_checks" };
    await record(deps, auth, "update_request", row.id, body);
    return toolResult(body, true);
  }
  let evidence = Array.isArray(args.evidence)
    ? sanitizeBotEvidence(args.evidence.map((item) => String(item)))
    : row.evidence;
  if (status === "done" && evidence.length === 0) {
    const body = { status: "refused", reason: "done_requires_evidence" };
    await record(deps, auth, "update_request", row.id, body);
    return toolResult(body, true);
  }
  if (status === "done" && !checkerPassedCurrentSha(row)) {
    const body = { status: "refused", reason: "done_requires_checks", requestId: row.id };
    await record(deps, auth, "update_request", row.id, body);
    return toolResult(body, true);
  }
  if (status === "done") {
    const refusal = await doneHeadRefusal(deps, row);
    if (refusal) {
      const body = { status: "refused", ...refusal, requestId: row.id };
      await record(deps, auth, "update_request", row.id, body);
      return toolResult(body, true);
    }
    // The head lookup awaited GitHub; a request_checks may have saved meanwhile. Write onto a fresh read, never the stale row.
    const fresh = await deps.store.getRequest(row.id);
    if (!fresh || fresh.status !== row.status || !sameCheckRun(fresh.checkRun, row.checkRun)) {
      const body = { status: "refused", reason: "request_changed", requestId: row.id };
      await record(deps, auth, "update_request", row.id, body);
      return toolResult(body, true);
    }
    if (!Array.isArray(args.evidence)) evidence = fresh.evidence;
    row = fresh;
  }
  // Reopening a done request drops its pass, so returning to done needs a fresh check.
  if (row.status === "done" && status && status !== "done") row.checkRun = null;
  row.status = status ?? row.status;
  row.evidence = evidence;
  await deps.store.saveRequest(row);
  const body = { status: "updated", requestId: row.id, requestStatus: row.status };
  await record(deps, auth, "update_request", row.id, body);
  return toolResult(body);
}

function sameCheckRun(left: ConnectorRequest["checkRun"], right: ConnectorRequest["checkRun"]): boolean {
  if (!left || !right) return !left && !right;
  return left.nonce === right.nonce && left.sha === right.sha && left.repo === right.repo && left.passed === right.passed;
}

/** Fail closed: done needs a bound PR/branch whose GitHub head is the sha the Checker passed. */
async function doneHeadRefusal(
  deps: ConnectorDeps,
  row: ConnectorRequest,
): Promise<{ reason: string; head?: string; checkedSha?: string } | null> {
  const run = row.checkRun;
  if (!requestIsBound(row) || !row.repo) return { reason: "done_requires_binding" };
  if (!run || run.repo !== row.repo) return { reason: "done_requires_checks" };
  if (!deps.checker?.head) return { reason: "head_lookup_unavailable" };
  let head: string | null;
  try {
    head = await deps.checker.head({ repo: row.repo, pullRequest: row.pullRequest ?? null, branch: row.branch ?? null });
  } catch {
    head = null;
  }
  if (!head) return { reason: "head_lookup_failed" };
  if (head.toLowerCase() !== run.sha.toLowerCase()) {
    return { reason: "done_requires_checks_on_head", head, checkedSha: run.sha };
  }
  return null;
}

function councilPacket(args: Record<string, unknown>): string | null {
  const packet = textArg(args, "packet");
  if (packet) return packet;
  const diff = textArg(args, "diff");
  const checker = textArg(args, "checker");
  const evidence = Array.isArray(args.evidence)
    ? args.evidence.map((item) => String(item)).filter(Boolean).join("\n")
    : textArg(args, "evidence");
  if (!diff && !checker && !evidence) return null;
  return ["Diff:", diff ?? "(none)", "Checker:", checker ?? evidence ?? "(none)"].join("\n");
}

function safeCouncilError(error: unknown): string {
  const message = error instanceof Error ? error.message : "council_failed";
  return message.replace(/eyJ[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/postgres(?:ql)?:\/\/\S+/gi, "[db]").slice(0, 120);
}

function councilUnavailableReason(message: string): "not-configured" | "not-ready" | "error" {
  if (
    message === "codex_login_missing" ||
    message === "age_key_missing" ||
    message === "path_b_login_unavailable" ||
    message === "codex_login_not_chatgpt" ||
    message === "codex_login_unknown"
  ) {
    return "not-configured";
  }
  if (message === "openai_api_key_set") return "not-ready";
  return "error";
}

async function liveCriticSeat(packet: string): Promise<Verdict> {
  if (process.env.OPENAI_API_KEY) throw new Error("openai_api_key_set");
  const verdict = await runCriticSeat({
    sheetText: loadConnectorSheetText(),
    packet,
    dbUrl: process.env.SUPABASE_DB_URL ?? "",
  });
  return parseCouncilVerdict(verdict);
}

async function handleCouncil(deps: ConnectorDeps, auth: ConnectorAuth, args: Record<string, unknown>): Promise<ToolResult> {
  const target = textArg(args, "requestId") ?? textArg(args, "request_id") ?? "council";
  const mode = textArg(args, "mode") ?? textArg(args, "councilMode") ?? "quick";
  if (mode === "off") {
    const body = { status: "refused", reason: "council_off" };
    await record(deps, auth, "request_council", target, body);
    return toolResult(body, true);
  }
  const packet = councilPacket(args);
  if (!packet) {
    const body = { status: "refused", reason: "packet_required" };
    await record(deps, auth, "request_council", target, body);
    return toolResult(body, true);
  }
  const configured = deps.councilConfigured ?? pathBCouncilConfigured();
  if (!configured && !deps.runCouncilSeat) {
    const body = { status: "not-configured", reason: "path_b_login_unavailable", configured: false };
    await record(deps, auth, "request_council", target, body);
    return toolResult(body, true);
  }
  // dexter-shortcut: the seat cap counts a rolling 7 days, not the PT calendar week; upgrade path: share the PT ISO week boundary with the U5 fleet report.
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const seat = await deps.store.reserveCouncilSeat({
    event: { ownerId: auth.ownerId, actor: auth.name, action: "council_seat", target, result: { seat: "critic" }, at },
    since: new Date(Date.parse(at) - WEEK_MS).toISOString(),
    cap: COUNCIL_WEEKLY_SEAT_CAP,
  });
  if (!seat.ok) {
    const body = { status: "refused", reason: "council_weekly_cap", cap: COUNCIL_WEEKLY_SEAT_CAP, used: seat.used };
    await record(deps, auth, "request_council", target, body);
    return toolResult(body, true);
  }
  try {
    const raw = deps.runCouncilSeat ? await deps.runCouncilSeat({ packet }) : await liveCriticSeat(packet);
    const parsed = VerdictSchema.safeParse(raw);
    if (!parsed.success) {
      const body = { status: "error", reason: "invalid_verdict" };
      await record(deps, auth, "request_council", target, body);
      return toolResult(body, true);
    }
    const body = {
      status: "verdict",
      seat: "critic",
      path: "B",
      result: parsed.data.result,
      actions: parsed.data.actions,
    };
    await record(deps, auth, "request_council", target, body);
    return toolResult(body);
  } catch (error) {
    const reason = safeCouncilError(error);
    const status = councilUnavailableReason(reason);
    const body =
      status === "error"
        ? { status, reason }
        : { status, reason, configured: false };
    await record(deps, auth, "request_council", target, body);
    return toolResult(body, true);
  }
}

async function handleAssign(deps: ConnectorDeps, auth: ConnectorAuth, args: Record<string, unknown>): Promise<ToolResult> {
  if (auth.kind !== "ceo") {
    const body = { status: "refused", reason: "ceo_only" };
    await record(deps, auth, "assign", "scope", body);
    return toolResult(body, true);
  }
  const requestId = textArg(args, "requestId") ?? textArg(args, "request_id");
  const botId = textArg(args, "botId") ?? textArg(args, "bot_id");
  const request = requestId ? await deps.store.getRequest(requestId) : null;
  const bot = botId ? await deps.store.getBot(botId) : null;
  if (!request || !bot) {
    const body = { status: "refused", reason: "unknown_target" };
    await record(deps, auth, "assign", requestId ?? "missing", body);
    return toolResult(body, true);
  }
  if (request.repo && !bot.repos.includes(request.repo) && bot.kind !== "scout") {
    const body = { status: "refused", reason: "bot_does_not_own_repo" };
    await record(deps, auth, "assign", bot.id, body);
    return toolResult(body, true);
  }
  request.assignedBotId = bot.id;
  await deps.store.saveRequest(request);
  const body = { status: "assigned", requestId: request.id, botId: bot.id };
  await record(deps, auth, "assign", request.id, body);
  return toolResult(body);
}

function botMayMutateRequest(auth: ConnectorAuth, request: { assignedBotId: string | null }): boolean {
  if (auth.kind === "ceo") return true;
  return request.assignedBotId === auth.id;
}

function botMayCheckRequest(
  auth: ConnectorAuth,
  request: { assignedBotId: string | null; repo: string | null },
  repo: string,
): { ok: true } | { ok: false; reason: string } {
  if (!auth.repos.includes(repo)) return { ok: false, reason: "repo_out_of_scope" };
  if (request.repo && request.repo !== repo) return { ok: false, reason: "repo_mismatch" };
  if (request.repo && !auth.repos.includes(request.repo)) return { ok: false, reason: "repo_out_of_scope" };
  if (request.assignedBotId && request.assignedBotId !== auth.id) return { ok: false, reason: "not_own_request" };
  if (!request.assignedBotId) return { ok: false, reason: "not_own_request" };
  return { ok: true };
}

async function handleRequestChecks(deps: ConnectorDeps, auth: ConnectorAuth, args: Record<string, unknown>): Promise<ToolResult> {
  const repo = textArg(args, "repo");
  const requestId = textArg(args, "requestId") ?? textArg(args, "request_id");
  const sha = textArg(args, "sha");
  const supplied = bindingFromArgs(args);
  if (!requestId) {
    const body = { status: "refused", reason: "request_required", ready: false };
    await record(deps, auth, "request_checks", "missing", body);
    return toolResult(body, true);
  }
  const request = await deps.store.getRequest(requestId);
  if (!request) {
    const body = { status: "refused", reason: "unknown_request", ready: false, requestId };
    await record(deps, auth, "request_checks", requestId, body);
    return toolResult(body, true);
  }
  if (!repo || !sha) {
    const body = { status: "refused", reason: "repo_and_sha_required", ready: false, requestId };
    await record(deps, auth, "request_checks", requestId, body);
    return toolResult(body, true);
  }
  const access = botMayCheckRequest(auth, request, repo);
  if (!access.ok) {
    const body = { status: "refused", reason: access.reason, ready: false, requestId };
    await record(deps, auth, "request_checks", requestId, body);
    return toolResult(body, true);
  }
  if (!supplied.ok || !bindingMatches(request, supplied.binding)) {
    const body = { status: "refused", reason: supplied.ok ? "binding_mismatch" : "invalid_binding", ready: false, requestId };
    await record(deps, auth, "request_checks", requestId, body);
    return toolResult(body, true);
  }
  // Bind once: the first check on an unbound request records its PR/branch; later checks reuse it.
  const binding = requestIsBound(request)
    ? { pullRequest: request.pullRequest ?? null, branch: request.branch ?? null }
    : supplied.binding;
  const { branch, pullRequest } = binding;
  const configured = deps.checkerConfigured ?? Boolean(deps.checker);
  if (!configured || !deps.checker) {
    const body = {
      status: "not-configured",
      ready: false,
      configured: false,
      workflow: PINNED_CHECKER_WORKFLOW,
      requestId,
    };
    await record(deps, auth, "request_checks", requestId, body);
    return toolResult(body, true);
  }
  try {
    const at = (deps.now ?? (() => new Date().toISOString()))();
    let checkRun = request.checkRun ?? null;
    const shaChanged = Boolean(checkRun && (checkRun.sha !== sha || checkRun.repo !== repo));
    if (shaChanged) checkRun = null;

    let dispatchedNow = false;
    if (checkRun) {
      if (!checkRun.githubRunId) {
        const found = await deps.checker.find({ repo, sha, nonce: checkRun.nonce });
        if (found) checkRun = { ...checkRun, githubRunId: found };
      }
    } else {
      const nonce = randomUUID();
      const dispatched = await deps.checker.dispatch({
        repo,
        sha,
        nonce,
        branch,
        pullRequest,
      });
      dispatchedNow = dispatched.dispatched;
      checkRun = {
        nonce,
        githubRunId: dispatched.githubRunId,
        sha,
        repo,
        hostRepo: dispatched.hostRepo,
        dispatchedAt: at,
        passed: false,
      };
    }

    const hostRepo = checkRun.hostRepo;
    const githubRunId = checkRun.githubRunId;
    const outcome = githubRunId
      ? await deps.checker.outcome({ githubRunId, sha, repo, nonce: checkRun.nonce })
      : { state: "queued" as const, conclusion: null, githubRunId: null, evidence: [] };
    if (outcome.githubRunId) checkRun = { ...checkRun, githubRunId: outcome.githubRunId };
    const ready = checksMoveRequestReady(outcome);
    checkRun = { ...checkRun, passed: ready };
    const evidence = evidenceFromOutcome({
      workflow: PINNED_CHECKER_WORKFLOW,
      sha,
      repo,
      hostRepo,
      nonce: checkRun.nonce,
      githubRunId: checkRun.githubRunId,
      outcome,
    });
    const next = applyCheckEvidence(request, evidence, ready, { sha, repo });
    next.checkRun = checkRun;
    next.pullRequest = pullRequest;
    next.branch = branch;
    if (requestIsBound(next) && !next.repo) next.repo = repo;
    await deps.store.saveRequest(next);
    const status = ready ? "ready" : outcome.state === "completed" ? "failed" : "in_progress";
    const body = {
      status,
      ready,
      dispatched: dispatchedNow,
      workflow: PINNED_CHECKER_WORKFLOW,
      githubRunId: checkRun.githubRunId,
      nonce: checkRun.nonce,
      sha,
      evidence,
      requestId,
      requestStatus: next.status,
    };
    await record(deps, auth, "request_checks", requestId, body);
    return toolResult(body, status === "failed");
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 80) : "checker_failed";
    const body = { status: "error", ready: false, reason, requestId, workflow: PINNED_CHECKER_WORKFLOW };
    await record(deps, auth, "request_checks", requestId, body);
    return toolResult(body, true);
  }
}

export async function callConnectorTool(
  deps: ConnectorDeps,
  auth: ConnectorAuth | null,
  name: string,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args = asArgs(rawArgs);
  const stopped = await deps.store.stopped();
  if (stopped && !STOP_EXEMPT.has(name)) {
    const body = { status: "stopped" };
    await record(deps, auth, name, "stop", body);
    return toolResult(body, true);
  }
  if (!CONNECTOR_TOOLS.includes(name as ConnectorToolName)) {
    const body = { status: "error", reason: "unknown_tool" };
    await record(deps, auth, name, "unknown", body);
    return toolResult(body, true);
  }
  if (name !== "whoami" && !auth) {
    const body = { status: "refused", reason: "unauthorized" };
    await record(deps, auth, name, "unauthorized", body);
    return toolResult(body, true);
  }
  if (auth?.suspended && !STOP_EXEMPT.has(name)) {
    const body = { status: "stopped", reason: "suspended" };
    await record(deps, auth, name, "suspended", body);
    return toolResult(body, true);
  }
  if (!canCall(auth, name)) {
    const body = { status: "refused", reason: "out_of_scope" };
    await record(deps, auth, name, "scope", body);
    return toolResult(body, true);
  }

  if (name === "whoami") {
    const body = await whoamiBody(deps, auth);
    await record(deps, auth, "whoami", auth?.id ?? "stub", { scopes: body.scopes });
    return toolResult(body);
  }
  if (!auth) return toolResult({ status: "refused", reason: "unauthorized" }, true);

  if (name === "heartbeat") {
    const task = textArg(args, "task") ?? textArg(args, "currentTask");
    const at = (deps.now ?? (() => new Date().toISOString()))();
    await deps.store.heartbeat(auth.id, task, at);
    const body = { status: "ok", at };
    await record(deps, auth, "heartbeat", auth.id, body);
    return toolResult(body);
  }
  if (name === "open_request") return handleOpenRequest(deps, auth, args);
  if (name === "update_request") return handleUpdateRequest(deps, auth, args);
  if (name === "assign") return handleAssign(deps, auth, args);
  if (name === "launch_agent") return handleLaunch(deps, auth, args);
  if (name === "agent_status" || name === "followup_agent" || name === "cancel_agent") {
    return handleAgentTool(deps, auth, name, args);
  }
  if (name === "request_checks") return handleRequestChecks(deps, auth, args);
  if (name === "request_council") return handleCouncil(deps, auth, args);
  if (name === "request_approval") {
    const action = textArg(args, "action") ?? "unknown";
    const target = textArg(args, "target") ?? action;
    const id = randomUUID();
    await deps.store.saveApproval({
      id,
      ownerId: auth.ownerId,
      action,
      target,
      status: "pending",
      requestId: textArg(args, "requestId"),
    });
    const body = { status: "pending", approvalId: id, requestId: textArg(args, "requestId") };
    await record(deps, auth, name, id, body);
    return toolResult(body);
  }
  if (name === "approval_status") {
    const id = textArg(args, "approvalId") ?? textArg(args, "approval_id");
    const row = id ? await deps.store.getApproval(id) : null;
    const body = row ? { status: row.status, approvalId: row.id, action: row.action } : { status: "unknown" };
    await record(deps, auth, name, id ?? "missing", body);
    return toolResult(body, !row);
  }
  if (name === "post" || name === "verify_post") {
    const at = (deps.now ?? (() => new Date().toISOString()))();
    const out = name === "post" ? await postNote(deps.store, auth, args, at) : await verifyNote(deps.store, auth, args);
    await record(deps, auth, name, out.target, out.event);
    return toolResult(out.body, out.isError);
  }
  if (name === "get_context") {
    const at = (deps.now ?? (() => new Date().toISOString()))();
    const notes = await contextNotes(deps.store, auth, args, at);
    if (notes.isError) {
      await record(deps, auth, name, notes.target, notes.event);
      return toolResult(notes.body, true);
    }
    const requestId = textArg(args, "requestId") ?? textArg(args, "request_id");
    const events = await deps.store.listEvents();
    const why = requestId ? decisionTrail(events, requestId) : [];
    const body = { ...notes.body, why, requestId };
    await record(deps, auth, name, notes.target, { ...notes.event, why: why.length });
    return toolResult(body);
  }
  const body = { status: "error", reason: "unknown_tool" };
  await record(deps, auth, name, "unknown", body);
  return toolResult(body, true);
}

export function createDefaultConnectorDeps(overrides?: Partial<ConnectorDeps>): ConnectorDeps {
  const key = process.env.CURSOR_API_KEY;
  const ghToken = process.env.GH_HQ_TOKEN?.trim();
  const hostRepo = process.env.GH_WORKERS_REPO?.trim();
  const sheet = overrides?.sheet ?? parseRoleSheet(loadConnectorSheetText());
  const checker =
    overrides && "checker" in overrides
      ? (overrides.checker ?? null)
      : ghToken && hostRepo
        ? createGhChecker({ token: ghToken, hostRepo })
        : null;
  return {
    store: overrides?.store ?? createMemoryConnectorStore(),
    sheet,
    cursor: overrides?.cursor ?? (key ? createCursorCloud({ apiKey: key }) : null),
    cursorConfigured: overrides?.cursorConfigured ?? Boolean(key),
    checker,
    checkerConfigured:
      overrides?.checkerConfigured ?? (overrides && "checker" in overrides ? Boolean(checker) : checksConfigured()),
    knownHosts: overrides?.knownHosts ?? KNOWN_HOSTS,
    now: overrides?.now,
    ownerId: overrides?.ownerId,
    councilConfigured: overrides?.councilConfigured ?? pathBCouncilConfigured(),
    runCouncilSeat: overrides?.runCouncilSeat,
  };
}

const BOARD_TOOL_DESCRIPTIONS: Record<string, string> = {
  post:
    "Save one board note. Args: type (finding | dead_end | shortcut | handoff), body (<=2000 chars, secrets are redacted), optional repo, scope (shared | project | mission; a lead defaults to project on its own repo, shared must be explicit), requestId (required for mission), agentId, runId, sha, link, idempotencyKey. dead_end needs conditions and gets expiresAt or expiresInDays (default 30, max 180). Findings and shortcuts start claimed.",
  verify_post:
    "Verify a claimed finding or shortcut. Args: postId, optional checkRequestId (the note's own request with a passed Checker run on the note's repo). The author cannot verify its own note unless the Checker passed.",
  get_context:
    "Notes you may read, ranked verified first, then this request, then this repo, then newest; capped and clipped. Args: optional repo (must be yours), requestId, type, limit (<=30). Returns findings (verified), claimed (unverified: never change a plan on them), deadEnds (live only), handoffs, unverified ids, omitted count, and the request's why trail.",
};

export function connectorToolDescriptors(names: readonly string[]) {
  return names.map((name) => ({
    name,
    description:
      name === "whoami"
        ? "Return this connector's identity, scopes, caps left, and stop flag."
        : name === "request_council"
          ? "Run one Critic seat through path B. Returns a schema-valid verdict, or not-configured when the login is absent."
          : name === "request_checks"
            ? "Dispatch pinned checker.yml from the trusted workers main ref against a commit SHA. Returns in_progress until GitHub has a conclusion; ready requires a completed success. Callers cannot supply a GitHub run id. The first pullRequest or branch given binds the request; update_request done then requires a pass on that PR/branch's current GitHub head."
            : (BOARD_TOOL_DESCRIPTIONS[name] ?? `Dexter connector tool ${name}.`),
    inputSchema: { type: "object", additionalProperties: true },
  }));
}
