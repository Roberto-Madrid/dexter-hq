import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createCursorCloud } from "../adapters/cursor-cloud.ts";
import { SHIPPED_CREWS } from "./crews.ts";
import { bundledRoleSheet } from "./bundled-assets.ts";
import { PlanCardSchema } from "../kernel/schemas.ts";
import { validatePlanCard } from "../kernel/plan-card.ts";
import { preflight } from "../kernel/preflight.ts";
import { SANDBOX_SLOT_CAP } from "../kernel/police.ts";
import { parseRoleSheet } from "../kernel/role-sheet.ts";
import { REQUEST_STATES, type PlanCard, type RoleSheet, type RunHandle, type Runtime } from "../kernel/types.ts";
import {
  CONNECTOR_TOOLS,
  createMemoryConnectorStore,
  type ConnectorAgent,
  type ConnectorAuth,
  type ConnectorStore,
  type ConnectorToolName,
} from "./connector-store.ts";

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

export type ConnectorDeps = {
  store: ConnectorStore;
  sheet: RoleSheet;
  cursor: CursorGateway | null;
  cursorConfigured: boolean;
  knownHosts?: readonly string[];
  now?: () => string;
  ownerId?: string;
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
  const findings = preflight(brief, deps.knownHosts ?? KNOWN_HOSTS);
  if (findings.length > 0) {
    const body = { status: "needs_you", reason: "preflight", findings };
    await record(deps, auth, "launch_agent", idempotencyKey, body);
    return toolResult(body, true);
  }
  const agents = await deps.store.listAgents();
  const active = agents.filter((item) => ACTIVE_AGENT.has(item.status));
  const approvalId = textArg(args, "approvalId") ?? textArg(args, "approval_id");
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
    const body = { status: "not-configured", configured: false, launched: false };
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
  try {
    const handle = await deps.cursor.start({ idempotencyKey, taskId: idempotencyKey, brief });
    const body = { status: "launched", launched: true, agentId: handle.id, role, family };
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
  const body = { status: "opened", requestId: id, requestStatus: status, notices: validated.notices };
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
  if (name === "request_checks") {
    const body = { status: "recorded", ready: false };
    await record(deps, auth, name, textArg(args, "branch") ?? textArg(args, "pullRequest") ?? "checks", body);
    return toolResult(body);
  }
  if (name === "request_council") {
    const body = { status: "not-ready", reason: "council_seat_not_wired" };
    await record(deps, auth, name, textArg(args, "requestId") ?? "council", body);
    return toolResult(body);
  }
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
    const body = { status: "pending", approvalId: id };
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
    const posts = await deps.store.listPosts();
    const items = posts.filter((item) => !repo || item.repo === repo);
    const body = {
      status: "ok",
      findings: items.filter((item) => item.type === "finding" && item.verified),
      unverified: items.filter((item) => item.type === "finding" && !item.verified).map((item) => item.id),
      deadEnds: items.filter((item) => item.type === "dead_end"),
    };
    await record(deps, auth, name, repo ?? "all", { count: items.length });
    return toolResult(body);
  }
  const body = { status: "error", reason: "unknown_tool" };
  await record(deps, auth, name, "unknown", body);
  return toolResult(body, true);
}

export function createDefaultConnectorDeps(overrides?: Partial<ConnectorDeps>): ConnectorDeps {
  const key = process.env.CURSOR_API_KEY;
  const sheet = overrides?.sheet ?? parseRoleSheet(loadConnectorSheetText());
  return {
    store: overrides?.store ?? createMemoryConnectorStore(),
    sheet,
    cursor: overrides?.cursor ?? (key ? createCursorCloud({ apiKey: key }) : null),
    cursorConfigured: overrides?.cursorConfigured ?? Boolean(key),
    knownHosts: overrides?.knownHosts ?? KNOWN_HOSTS,
    now: overrides?.now,
    ownerId: overrides?.ownerId,
  };
}

export function connectorToolDescriptors(names: readonly string[]) {
  return names.map((name) => ({
    name,
    description: name === "whoami" ? "Return this connector's identity, scopes, caps left, and stop flag." : `Dexter connector tool ${name}.`,
    inputSchema: { type: "object", additionalProperties: true },
  }));
}
