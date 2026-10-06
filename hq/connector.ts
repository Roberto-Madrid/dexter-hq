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
  type ConnectorAgent,
  type ConnectorAuth,
  type ConnectorStore,
  type ConnectorToolName,
} from "./connector-store.ts";
import { parseCouncilVerdict, runCriticSeat } from "./council-seat.ts";
import {
  PINNED_CHECKER_WORKFLOW,
  applyCheckEvidence,
  checksMoveRequestReady,
  createGhChecker,
  evidenceFromOutcome,
  type CheckerGateway,
} from "./checker.ts";
import { decisionTrail } from "./decision-trail.ts";
import { launchBlockedByDesignGate } from "./design-gate.ts";
import { composeLaunchBrief } from "./personas.ts";

export { CONNECTOR_TOOLS, createMemoryConnectorStore };
export type { ConnectorAuth, ConnectorStore, ConnectorToolName };

export const STUB_OWNER_ID = "00000000-0000-4000-8000-000000000000";
export const AGENT_SURGE_CAP = 6;
export const PER_REPO_CAP = 2;
export const STOP_EXEMPT = new Set<string>(["whoami", "heartbeat", "approval_status"]);
const ACTIVE_AGENT = new Set(["launched", "running", "starting", "CREATING", "RUNNING", "queued"]);
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
  const active = agents.filter((item) => ACTIVE_AGENT.has(item.status));
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
  if (existing?.result) {
    await record(deps, auth, "launch_agent", existing.cursorHandle ?? existing.id, {
      status: "idempotent",
      ...existing.result,
    });
    return toolResult({ status: "idempotent", ...existing.result }, existing.status === "not-configured" || existing.status === "refused");
  }
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
  const agents = await deps.store.listAgents();
  const active = agents.filter((item) => ACTIVE_AGENT.has(item.status));
  let surge = false;
  if (approvalId) {
    const approval = await deps.store.getApproval(approvalId);
    surge = approval?.status === "approved" && approval.action === "surge";
  }
  const cap = surge ? AGENT_SURGE_CAP : SANDBOX_SLOT_CAP;
  if (active.length >= cap) {
    const body = { status: "refused", reason: surge ? "surge_cap" : "agent_cap", cap };
    await record(deps, auth, "launch_agent", idempotencyKey, body);
    return toolResult(body, true);
  }
  if (repo) {
    const repoActive = active.filter((item) => item.repo === repo).length;
    if (repoActive >= PER_REPO_CAP) {
      const body = { status: "refused", reason: "per_repo_cap", cap: PER_REPO_CAP };
      await record(deps, auth, "launch_agent", repo, body);
      return toolResult(body, true);
    }
  }
  if (!deps.cursorConfigured || !deps.cursor) {
    const composed = composeLaunchBrief(role, brief);
    const body = {
      status: "not-configured",
      configured: false,
      launched: false,
      persona: composed.persona,
      requestId,
    };
    const row: ConnectorAgent = {
      id: randomUUID(),
      ownerId: auth.ownerId,
      botId: auth.id,
      cursorHandle: null,
      repo,
      role,
      family,
      status: "not-configured",
      idempotencyKey,
      result: body,
    };
    await deps.store.saveAgent(row);
    await record(deps, auth, "launch_agent", idempotencyKey, body);
    return toolResult(body, true);
  }
  const composed = composeLaunchBrief(role, brief);
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
    const row: ConnectorAgent = {
      id: randomUUID(),
      ownerId: auth.ownerId,
      botId: auth.id,
      cursorHandle: handle.id,
      repo,
      role,
      family,
      status: "launched",
      idempotencyKey,
      result: body,
    };
    await deps.store.saveAgent(row);
    await record(deps, auth, "launch_agent", handle.id, body);
    return toolResult(body);
  } catch {
    const body = { status: "error", launched: false, reason: "launch_failed" };
    await record(deps, auth, "launch_agent", idempotencyKey, body);
    return toolResult(body, true);
  }
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
      const status = await deps.cursor.status(handle);
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
    const next = await deps.cursor.followup(handle, text);
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
    assignedBotId: null,
    repo: textArg(args, "repo"),
    notices: validated.notices,
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
  const row = id ? await deps.store.getRequest(id) : null;
  if (!row) {
    const body = { status: "refused", reason: "unknown_request" };
    await record(deps, auth, "update_request", id ?? "missing", body);
    return toolResult(body, true);
  }
  if (status && !(REQUEST_STATES as readonly string[]).includes(status)) {
    const body = { status: "refused", reason: "invalid_status" };
    await record(deps, auth, "update_request", row.id, body);
    return toolResult(body, true);
  }
  const evidence = Array.isArray(args.evidence) ? args.evidence.map((item) => String(item)) : row.evidence;
  if (status === "done" && evidence.length === 0) {
    const body = { status: "refused", reason: "done_requires_evidence" };
    await record(deps, auth, "update_request", row.id, body);
    return toolResult(body, true);
  }
  row.status = status ?? row.status;
  row.evidence = evidence;
  await deps.store.saveRequest(row);
  const body = { status: "updated", requestId: row.id, requestStatus: row.status };
  await record(deps, auth, "update_request", row.id, body);
  return toolResult(body);
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

async function handleRequestChecks(deps: ConnectorDeps, auth: ConnectorAuth, args: Record<string, unknown>): Promise<ToolResult> {
  const repo = textArg(args, "repo");
  const branch = textArg(args, "branch");
  const pullRequest = textArg(args, "pullRequest") ?? textArg(args, "pull_request");
  const requestId = textArg(args, "requestId") ?? textArg(args, "request_id");
  const sha = textArg(args, "sha");
  const ref = branch ?? (pullRequest ? `refs/pull/${pullRequest}/head` : null);
  if (!repo || !ref) {
    const body = { status: "refused", reason: "repo_and_branch_or_pull_request_required", ready: false, requestId };
    await record(deps, auth, "request_checks", requestId ?? "checks", body);
    return toolResult(body, true);
  }
  if (!auth.repos.includes(repo)) {
    const body = { status: "refused", reason: "repo_out_of_scope", ready: false, requestId };
    await record(deps, auth, "request_checks", repo, body);
    return toolResult(body, true);
  }
  const configured = deps.checkerConfigured ?? Boolean(deps.checker);
  if (!configured || !deps.checker) {
    const body = {
      status: "not-configured",
      ready: false,
      configured: false,
      workflow: PINNED_CHECKER_WORKFLOW,
      requestId,
    };
    await record(deps, auth, "request_checks", requestId ?? repo, body);
    return toolResult(body, true);
  }
  const runId = textArg(args, "runId") ?? textArg(args, "run_id") ?? randomUUID();
  try {
    const dispatched = await deps.checker.dispatch({
      repo,
      ref,
      runId,
      sha,
      pullRequest,
    });
    const outcome = await deps.checker.outcome({ repo, runId: dispatched.runId });
    const evidence = evidenceFromOutcome({
      workflow: dispatched.workflow || PINNED_CHECKER_WORKFLOW,
      sha: dispatched.sha ?? sha,
      repo,
      ref,
      outcome,
    });
    const ready = checksMoveRequestReady(outcome);
    if (requestId) {
      const request = await deps.store.getRequest(requestId);
      if (request) {
        const next = applyCheckEvidence(request, evidence, ready);
        await deps.store.saveRequest(next);
      }
    }
    const body = {
      status: ready ? "ready" : outcome.state === "completed" ? "failed" : "recorded",
      ready,
      workflow: PINNED_CHECKER_WORKFLOW,
      runId: dispatched.runId,
      sha: dispatched.sha ?? sha,
      evidence,
      requestId,
      requestStatus: requestId ? (await deps.store.getRequest(requestId))?.status ?? null : null,
    };
    await record(deps, auth, "request_checks", requestId ?? dispatched.runId, body);
    return toolResult(body, !ready && outcome.conclusion === "failure");
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 80) : "checker_failed";
    const body = { status: "error", ready: false, reason, requestId, workflow: PINNED_CHECKER_WORKFLOW };
    await record(deps, auth, "request_checks", requestId ?? repo, body);
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
  if (name === "post") {
    const id = randomUUID();
    const type = textArg(args, "type") ?? "finding";
    await deps.store.savePost({
      id,
      ownerId: auth.ownerId,
      type,
      author: auth.name,
      body: textArg(args, "body") ?? "",
      repo: textArg(args, "repo"),
      verified: false,
    });
    const body = { status: "posted", postId: id, verified: false };
    await record(deps, auth, name, id, body);
    return toolResult(body);
  }
  if (name === "verify_post") {
    const id = textArg(args, "postId") ?? textArg(args, "post_id");
    const row = id ? await deps.store.getPost(id) : null;
    if (!row) {
      const body = { status: "refused", reason: "unknown_post" };
      await record(deps, auth, name, id ?? "missing", body);
      return toolResult(body, true);
    }
    row.verified = true;
    await deps.store.savePost(row);
    const body = { status: "verified", postId: row.id };
    await record(deps, auth, name, row.id, body);
    return toolResult(body);
  }
  if (name === "get_context") {
    const repo = textArg(args, "repo");
    const requestId = textArg(args, "requestId") ?? textArg(args, "request_id");
    const posts = await deps.store.listPosts();
    const items = posts.filter((item) => !repo || item.repo === repo);
    const events = await deps.store.listEvents();
    const why = requestId ? decisionTrail(events, requestId) : [];
    const body = {
      status: "ok",
      findings: items.filter((item) => item.type === "finding" && item.verified),
      unverified: items.filter((item) => item.type === "finding" && !item.verified).map((item) => item.id),
      deadEnds: items.filter((item) => item.type === "dead_end"),
      why,
      requestId,
    };
    await record(deps, auth, name, requestId ?? repo ?? "all", { count: items.length, why: why.length });
    return toolResult(body);
  }
  const body = { status: "error", reason: "unknown_tool" };
  await record(deps, auth, name, "unknown", body);
  return toolResult(body, true);
}

export function createDefaultConnectorDeps(overrides?: Partial<ConnectorDeps>): ConnectorDeps {
  const key = process.env.CURSOR_API_KEY;
  const ghToken = process.env.GH_HQ_TOKEN?.trim();
  const sheet = overrides?.sheet ?? parseRoleSheet(loadConnectorSheetText());
  const checker =
    overrides && "checker" in overrides
      ? (overrides.checker ?? null)
      : ghToken
        ? createGhChecker({ token: ghToken })
        : null;
  return {
    store: overrides?.store ?? createMemoryConnectorStore(),
    sheet,
    cursor: overrides?.cursor ?? (key ? createCursorCloud({ apiKey: key }) : null),
    cursorConfigured: overrides?.cursorConfigured ?? Boolean(key),
    checker,
    checkerConfigured: overrides?.checkerConfigured ?? Boolean(checker),
    knownHosts: overrides?.knownHosts ?? KNOWN_HOSTS,
    now: overrides?.now,
    ownerId: overrides?.ownerId,
    councilConfigured: overrides?.councilConfigured ?? pathBCouncilConfigured(),
    runCouncilSeat: overrides?.runCouncilSeat,
  };
}

export function connectorToolDescriptors(names: readonly string[]) {
  return names.map((name) => ({
    name,
    description:
      name === "whoami"
        ? "Return this connector's identity, scopes, caps left, and stop flag."
        : name === "request_council"
          ? "Run one Critic seat through path B. Returns a schema-valid verdict, or not-configured when the login is absent."
          : name === "request_checks"
            ? "Run the pinned Checker workflow on a branch or pull request. Ready requires evidence."
            : `Dexter connector tool ${name}.`,
    inputSchema: { type: "object", additionalProperties: true },
  }));
}
