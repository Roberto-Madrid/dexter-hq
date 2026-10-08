import { randomUUID } from "node:crypto";

export const CONNECTOR_TOOLS = [
  "whoami",
  "open_request",
  "update_request",
  "assign",
  "launch_agent",
  "agent_status",
  "followup_agent",
  "cancel_agent",
  "request_checks",
  "request_council",
  "request_approval",
  "approval_status",
  "post",
  "verify_post",
  "get_context",
  "heartbeat",
] as const;

export type ConnectorToolName = (typeof CONNECTOR_TOOLS)[number];

export type ConnectorBot = {
  id: string;
  ownerId: string;
  name: string;
  kind: string;
  repos: string[];
  tools: string[];
  currentTask: string | null;
  heartbeatAt: string | null;
};

export type ConnectorAuth = ConnectorBot & {
  scopes: string[];
  suspended: boolean;
};

export type ConnectorEvent = {
  id: string;
  ownerId: string;
  actor: string;
  action: string;
  target: string;
  result: Record<string, unknown> | null;
  at: string;
};

export type ConnectorAgent = {
  id: string;
  ownerId: string;
  botId: string;
  cursorHandle: string | null;
  repo: string | null;
  role: string;
  family: string;
  status: string;
  idempotencyKey: string;
  result: Record<string, unknown> | null;
  createdAt?: string;
};

/** Rows that hold a cap slot. `reserving` is the placeholder a launch inserts before it calls Cursor. */
export const ACTIVE_AGENT_STATUSES = ["reserving", "launched", "running", "starting", "CREATING", "RUNNING", "queued"] as const;
const ACTIVE = new Set<string>(ACTIVE_AGENT_STATUSES);
/** Rows that never reached Cursor; they do not count against the per-request launch cap. */
const NOT_LAUNCHED = new Set(["not-configured", "launch_failed"]);

export type LaunchCaps = { global: number; perRepo: number; perRequest: number };
export type LaunchRefusalReason = "agent_cap" | "per_repo_cap" | "request_cap";
export type LaunchReservation =
  | { ok: true; agent: ConnectorAgent }
  | { ok: false; reason: LaunchRefusalReason; cap: number }
  | { ok: false; reason: "duplicate"; existing: ConnectorAgent | null };

export function isActiveAgent(status: string): boolean {
  return ACTIVE.has(status);
}

/** Terminal states a follow-up may reopen (under the caps). A cancelled agent stays cancelled. */
const REOPENABLE = new Set(["finished", "error", "expired"]);

export type FollowupRefusal =
  | { ok: false; reason: "agent_cap" | "per_repo_cap"; cap: number }
  | { ok: false; reason: "agent_not_active" | "followup_in_progress" | "unknown_agent" };
export type FollowupReservation = { ok: true; previous: ConnectorAgent } | FollowupRefusal;

export type SetAgentStatusInput = {
  id: string;
  from: readonly string[];
  status: string;
  result?: Record<string, unknown> | null;
  /** When set, the row moves only if its current run (see runHandleFor) is still this one. */
  run?: string | null;
};

/** The run to poll: the latest follow-up run when there is one, else the launch run. */
export function runHandleFor(agent: Pick<ConnectorAgent, "cursorHandle" | "result">): string | null {
  const latest = agent.result?.latestRunHandle;
  return typeof latest === "string" && latest ? latest : agent.cursorHandle;
}

/** One rule for both stores. The caller must hold the launch lock while it reads `rows` and updates. */
export function followupRefusal(
  rows: readonly ConnectorAgent[],
  agent: ConnectorAgent,
  caps: Pick<LaunchCaps, "global" | "perRepo">,
): FollowupRefusal | null {
  if (agent.status === "reserving") return { ok: false, reason: "followup_in_progress" };
  if (ACTIVE.has(agent.status)) return null;
  if (!REOPENABLE.has(agent.status)) return { ok: false, reason: "agent_not_active" };
  const active = rows.filter((row) => ACTIVE.has(row.status) && row.id !== agent.id);
  if (active.length >= caps.global) return { ok: false, reason: "agent_cap", cap: caps.global };
  if (agent.repo && active.filter((row) => row.repo === agent.repo).length >= caps.perRepo) {
    return { ok: false, reason: "per_repo_cap", cap: caps.perRepo };
  }
  return null;
}

/** The row a follow-up claims: `reserving` until Cursor answers, remembering what to restore. */
export function followupClaim(agent: ConnectorAgent, at: string): Pick<ConnectorAgent, "status" | "result"> {
  return { status: "reserving", result: { ...agent.result, followupFrom: agent.status, reservedAt: at } };
}

/** The result without the follow-up claim fields. */
export function withoutFollowupClaim(result: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!result) return result;
  const rest = { ...result };
  delete rest.followupFrom;
  delete rest.reservedAt;
  return rest;
}

/** One rule for both stores. The caller must hold the launch lock while it reads `rows` and inserts. */
export function launchCapRefusal(
  rows: readonly ConnectorAgent[],
  input: { repo: string | null; requestId: string | null; caps: LaunchCaps },
): { reason: LaunchRefusalReason; cap: number } | null {
  const active = rows.filter((row) => ACTIVE.has(row.status));
  if (active.length >= input.caps.global) return { reason: "agent_cap", cap: input.caps.global };
  if (input.repo && active.filter((row) => row.repo === input.repo).length >= input.caps.perRepo) {
    return { reason: "per_repo_cap", cap: input.caps.perRepo };
  }
  if (input.requestId) {
    const launched = rows.filter((row) => row.result?.requestId === input.requestId && !NOT_LAUNCHED.has(row.status));
    if (launched.length >= input.caps.perRequest) return { reason: "request_cap", cap: input.caps.perRequest };
  }
  return null;
}

export type ConnectorCheckRun = {
  nonce: string;
  githubRunId: string | null;
  sha: string;
  repo: string;
  hostRepo: string;
  dispatchedAt: string;
  passed: boolean;
};

export type ConnectorRequest = {
  id: string;
  ownerId: string;
  goal: string;
  status: string;
  card: Record<string, unknown> | null;
  evidence: string[];
  assignedBotId: string | null;
  repo: string | null;
  notices: string[];
  checkRun?: ConnectorCheckRun | null;
  pullRequest?: string | null;
  branch?: string | null;
};

export type ConnectorApproval = {
  id: string;
  ownerId: string;
  action: string;
  target: string;
  status: "pending" | "approved" | "denied";
  requestId: string | null;
};

export type PostScope = "shared" | "project" | "mission";

/**
 * A board note. `verified` mirrors `status === "verified"` for older readers.
 * Optional fields are absent on rows written before Stage 3 unit 4; readers treat them as unknown.
 */
export type ConnectorPost = {
  id: string;
  ownerId: string;
  type: string;
  author: string;
  body: string;
  repo: string | null;
  verified: boolean;
  authorId?: string | null;
  status?: string | null;
  verifiedBy?: string | null;
  scope?: PostScope | null;
  requestId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  sha?: string | null;
  link?: string | null;
  conditions?: string | null;
  expiresAt?: string | null;
  createdAt?: string | null;
};

export interface ConnectorStore {
  stopped(): Promise<boolean>;
  setStopped(value: boolean): Promise<void>;
  setTokensSuspended(value: boolean): Promise<void>;
  authenticate(tokenHash: string): Promise<ConnectorAuth | null>;
  getBot(id: string): Promise<ConnectorBot | null>;
  heartbeat(botId: string, task: string | null, at: string): Promise<void>;
  appendEvent(event: Omit<ConnectorEvent, "id"> & { id?: string }): Promise<ConnectorEvent>;
  listEvents(): Promise<ConnectorEvent[]>;
  listBots(): Promise<ConnectorBot[]>;
  listAgents(): Promise<ConnectorAgent[]>;
  getAgent(id: string): Promise<ConnectorAgent | null>;
  findLaunch(botId: string, idempotencyKey: string): Promise<ConnectorAgent | null>;
  saveAgent(agent: ConnectorAgent): Promise<void>;
  /** Atomic: checks the caps and inserts a `reserving` row in one step, so two launches cannot both pass. */
  reserveLaunch(input: { agent: ConnectorAgent; requestId: string | null; caps: LaunchCaps }): Promise<LaunchReservation>;
  /** Conditional: moves the row only while its status is one of `from` (and its run is `run`, when given). */
  setAgentStatus(input: SetAgentStatusInput): Promise<boolean>;
  /** Atomic, under the launch lock: claims an agent for a follow-up, checking the caps when it reopens a finished one. */
  reserveFollowup(input: { id: string; caps: Pick<LaunchCaps, "global" | "perRepo">; at: string }): Promise<FollowupReservation>;
  /** Atomic: appends a `council_seat` event only while fewer than `cap` exist since `since`. */
  reserveCouncilSeat(input: {
    event: Omit<ConnectorEvent, "id">;
    since: string;
    cap: number;
  }): Promise<{ ok: boolean; used: number }>;
  saveRequest(row: ConnectorRequest): Promise<void>;
  getRequest(id: string): Promise<ConnectorRequest | null>;
  listRequests(): Promise<ConnectorRequest[]>;
  saveApproval(row: ConnectorApproval): Promise<void>;
  getApproval(id: string): Promise<ConnectorApproval | null>;
  claimApproval(
    id: string,
    status: "approved" | "denied",
  ): Promise<{ claimed: boolean; row: ConnectorApproval | null }>;
  listApprovals(): Promise<ConnectorApproval[]>;
  savePost(row: ConnectorPost): Promise<void>;
  getPost(id: string): Promise<ConnectorPost | null>;
  listPosts(): Promise<ConnectorPost[]>;
}

export function createMemoryConnectorStore(seed?: {
  stopped?: boolean;
  bots?: ConnectorBot[];
  tokens?: { tokenHash: string; botId: string; scopes: string[]; suspended?: boolean }[];
}): ConnectorStore {
  let stopped = seed?.stopped ?? false;
  const bots = new Map<string, ConnectorBot>();
  for (const bot of seed?.bots ?? []) bots.set(bot.id, { ...bot });
  const tokens = (seed?.tokens ?? []).map((item) => ({ ...item, suspended: item.suspended ?? false }));
  const events: ConnectorEvent[] = [];
  const agents = new Map<string, ConnectorAgent>();
  const requests = new Map<string, ConnectorRequest>();
  const approvals = new Map<string, ConnectorApproval>();
  const posts = new Map<string, ConnectorPost>();

  return {
    async stopped() {
      return stopped;
    },
    async setStopped(value) {
      stopped = value;
    },
    async setTokensSuspended(value) {
      for (const token of tokens) token.suspended = value;
    },
    async authenticate(tokenHash) {
      const row = tokens.find((item) => item.tokenHash === tokenHash);
      if (!row) return null;
      const bot = bots.get(row.botId);
      if (!bot) return null;
      return { ...bot, scopes: row.scopes, suspended: row.suspended ?? false };
    },
    async getBot(id) {
      return bots.get(id) ?? null;
    },
    async heartbeat(botId, task, at) {
      const bot = bots.get(botId);
      if (!bot) return;
      bot.currentTask = task;
      bot.heartbeatAt = at;
    },
    async appendEvent(event) {
      const row: ConnectorEvent = {
        id: event.id ?? randomUUID(),
        ownerId: event.ownerId,
        actor: event.actor,
        action: event.action,
        target: event.target,
        result: event.result,
        at: event.at,
      };
      events.push(row);
      return row;
    },
    async listEvents() {
      return [...events];
    },
    async listBots() {
      return [...bots.values()].map((bot) => ({ ...bot }));
    },
    async listAgents() {
      return [...agents.values()];
    },
    async getAgent(id) {
      return [...agents.values()].find((item) => item.id === id || item.cursorHandle === id) ?? null;
    },
    async findLaunch(botId, idempotencyKey) {
      return [...agents.values()].find((item) => item.botId === botId && item.idempotencyKey === idempotencyKey) ?? null;
    },
    async saveAgent(agent) {
      agents.set(agent.id, { ...agent });
    },
    // No await between the check and the insert, so this is atomic on one event loop.
    async reserveLaunch({ agent, requestId, caps }) {
      const rows = [...agents.values()];
      const existing = rows.find((row) => row.botId === agent.botId && row.idempotencyKey === agent.idempotencyKey);
      if (existing && existing.status !== "launch_failed") return { ok: false, reason: "duplicate", existing };
      const refusal = launchCapRefusal(rows, { repo: agent.repo, requestId, caps });
      if (refusal) return { ok: false, ...refusal };
      const row: ConnectorAgent = {
        ...agent,
        id: existing?.id ?? agent.id,
        status: "reserving",
        result: { ...agent.result, requestId },
      };
      agents.set(row.id, row);
      return { ok: true, agent: { ...row } };
    },
    async setAgentStatus({ id, from, status, result, run }) {
      const row = agents.get(id);
      if (!row || !from.includes(row.status)) return false;
      if (run !== undefined && runHandleFor(row) !== run) return false;
      agents.set(id, { ...row, status, result: result === undefined ? row.result : result });
      return true;
    },
    // No await between the check and the update, so this is atomic on one event loop.
    async reserveFollowup({ id, caps, at }) {
      const agent = agents.get(id);
      if (!agent) return { ok: false, reason: "unknown_agent" };
      const refusal = followupRefusal([...agents.values()], agent, caps);
      if (refusal) return refusal;
      agents.set(id, { ...agent, ...followupClaim(agent, at) });
      return { ok: true, previous: { ...agent } };
    },
    async reserveCouncilSeat({ event, since, cap }) {
      const used = events.filter((row) => row.action === "council_seat" && row.at >= since).length;
      if (used >= cap) return { ok: false, used };
      events.push({ ...event, id: randomUUID() });
      return { ok: true, used: used + 1 };
    },
    async saveRequest(row) {
      requests.set(row.id, { ...row });
    },
    async getRequest(id) {
      return requests.get(id) ?? null;
    },
    async listRequests() {
      return [...requests.values()].map((row) => ({ ...row }));
    },
    async saveApproval(row) {
      approvals.set(row.id, { ...row });
    },
    async getApproval(id) {
      return approvals.get(id) ?? null;
    },
    async claimApproval(id, status) {
      const row = approvals.get(id);
      if (!row) return { claimed: false, row: null };
      if (row.status !== "pending") return { claimed: false, row: { ...row } };
      const next = { ...row, status };
      approvals.set(id, next);
      return { claimed: true, row: { ...next } };
    },
    async listApprovals() {
      return [...approvals.values()].map((row) => ({ ...row }));
    },
    async savePost(row) {
      posts.set(row.id, { ...row });
    },
    async getPost(id) {
      return posts.get(id) ?? null;
    },
    async listPosts() {
      return [...posts.values()];
    },
  };
}
