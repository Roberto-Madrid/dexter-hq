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
  /** `verdict` notes: what the note judges. */
  verdict?: "pass" | "fail" | null;
  /** `verdict` notes: the bot whose work is judged (request assignee or agent owner); it may not verify the verdict. */
  subjectBotId?: string | null;
  /** HQ-written notes (type alert): `blocked`, `skill_suggestion`, `fleet_report`. */
  kind?: string | null;
  /** Reuse scan key: a lowercase slug naming the approach (agent-brake `operation`). */
  approach?: string | null;
  /** Tool output: inline when short, else the first 200 chars with the full text in a `tool_output` artifact. */
  output?: string | null;
  outputChars?: number | null;
  artifactId?: string | null;
};

/** Live = a heartbeat within this many seconds; Wait = seen since the token was issued but silent longer. */
export const LIVE_WINDOW_SECONDS = 60;

export type BotStatus = "live" | "wait" | "never_seen";

/** One rule for the venture list and Dexter's roster. Never seen = no heartbeat since the current token was issued. */
export function heartbeatStatus(
  input: { heartbeatAt: string | null; tokenIssuedAt: string | null },
  now: Date,
): { status: BotStatus; heartbeatAgeSeconds: number | null } {
  const beat = input.heartbeatAt ? Date.parse(input.heartbeatAt) : Number.NaN;
  if (Number.isNaN(beat)) return { status: "never_seen", heartbeatAgeSeconds: null };
  const issued = input.tokenIssuedAt ? Date.parse(input.tokenIssuedAt) : Number.NaN;
  if (!Number.isNaN(issued) && beat < issued) return { status: "never_seen", heartbeatAgeSeconds: null };
  const age = Math.max(0, Math.floor((now.getTime() - beat) / 1000));
  return { status: age <= LIVE_WINDOW_SECONDS ? "live" : "wait", heartbeatAgeSeconds: age };
}

/** What the `add_venture` event remembers. It never carries the token. */
export type VentureMeta = {
  name: string;
  repo: string | null;
  brief: string | null;
  idempotencyKey: string | null;
};

export type RosterRow = {
  bot: ConnectorBot;
  /** created_at of the bot's newest token row; null when it has none or the store does not know. */
  tokenIssuedAt: string | null;
  venture: VentureMeta | null;
};

export type VentureRefusal =
  | { reason: "stopped" | "name_taken" | "repo_taken" | "lead_name_taken"; field: string | null }
  | { reason: "replay"; field: null; botId: string };

export type VentureDecision = { ok: true; ownerId: string } | { ok: false; refusal: VentureRefusal };

export type CreateVentureInput = {
  bot: Omit<ConnectorBot, "ownerId">;
  tokenHash: string;
  scopes: string[];
  /** Token issue time; also the bot's created_at. */
  at: string;
  actor: string;
  meta: VentureMeta;
  /** Runs under the store's lock with the current STOP flag and roster, so a refusal and the insert cannot race. */
  decide(roster: RosterRow[], stopped: boolean): VentureDecision;
};

export type RotateTokenInput = {
  botId: string;
  tokenHash: string;
  at: string;
  actor: string;
  /** Used only when the bot has no token row left to copy scopes from. */
  fallbackScopes: string[];
};

export function ventureMetaFrom(value: unknown): VentureMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string" || !row.name) return null;
  return {
    name: row.name,
    repo: typeof row.repo === "string" ? row.repo : null,
    brief: typeof row.brief === "string" ? row.brief : null,
    idempotencyKey: typeof row.idempotencyKey === "string" ? row.idempotencyKey : null,
  };
}

export function ventureName(row: RosterRow): string {
  if (row.venture?.name) return row.venture.name;
  // Leads made by hand before Stage 3 have no add_venture event; they are named after their repo.
  const repo = row.bot.repos[0];
  return repo ? (repo.split("/")[1] ?? repo) : row.bot.name;
}

export type RosterEntry = {
  id: string;
  name: string;
  kind: string;
  repos: string[];
  venture: string | null;
  status: BotStatus;
  heartbeatAgeSeconds: number | null;
};

/** Dexter's roster for `get_context` (kind ceo only). Names, kinds, repos and status; never tokens or hashes. */
export async function botRoster(store: ConnectorStore, now: Date): Promise<RosterEntry[]> {
  return (await store.listRoster()).map((row) => {
    const status = heartbeatStatus({ heartbeatAt: row.bot.heartbeatAt, tokenIssuedAt: row.tokenIssuedAt }, now);
    return {
      id: row.bot.id,
      name: row.bot.name,
      kind: row.bot.kind,
      repos: [...row.bot.repos],
      venture: row.bot.kind === "lead" ? ventureName(row) : null,
      status: status.status,
      heartbeatAgeSeconds: status.heartbeatAgeSeconds,
    };
  });
}

/** One role-sheet family's model id. */
export type ModelPin = { family: string; version: string };

/** One `model_resolutions` row the daily check appends. A `held` row is a version waiting on the owner, never a pin. */
export type PinResolution = ModelPin & { held: boolean; reason: string };

export type ModelResolutionRow = PinResolution & { ownerId: string; resolvedAt: string };

/** The event the daily check appends when it cannot read the catalog. */
export const PIN_FAILURE_ACTION = "pins_resolve_failed";

/** The Needs-you card a held version raises. Its target is `<family>:<version>`. */
export const MODEL_UPGRADE_ACTION = "model_upgrade";

export function modelUpgradeTarget(row: ModelPin): string {
  return `${row.family}:${row.version}`;
}

/** The latest non-held row per family, from rows in any order. */
export function latestPins(rows: readonly ModelResolutionRow[]): ModelPin[] {
  const latest = new Map<string, ModelResolutionRow>();
  for (const row of rows) {
    if (row.held) continue;
    const seen = latest.get(row.family);
    if (!seen || row.resolvedAt >= seen.resolvedAt) latest.set(row.family, row);
  }
  return [...latest.values()].map((row) => ({ family: row.family, version: row.version }));
}

export interface ConnectorStore {
  stopped(): Promise<boolean>;
  setStopped(value: boolean): Promise<void>;
  setTokensSuspended(value: boolean): Promise<void>;
  authenticate(tokenHash: string): Promise<ConnectorAuth | null>;
  getBot(id: string): Promise<ConnectorBot | null>;
  heartbeat(botId: string, task: string | null, at: string): Promise<void>;
  appendEvent(event: Omit<ConnectorEvent, "id"> & { id?: string }): Promise<ConnectorEvent>;
  listEvents(): Promise<ConnectorEvent[]>;
  /** Newest first: events with this action (and target, when given), at most `limit` (default 200). */
  listEventsByAction(action: string, options?: { target?: string; limit?: number }): Promise<ConnectorEvent[]>;
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
  /** Every bot with its newest token time and venture metadata. Never returns token hashes. */
  listRoster(): Promise<RosterRow[]>;
  /** Atomic: decide() sees the STOP flag and roster under one lock, then the bot, its hashed token, and an `add_venture` event are written together. */
  createVenture(input: CreateVentureInput): Promise<{ ok: true; bot: ConnectorBot } | { ok: false; refusal: VentureRefusal }>;
  /**
   * Atomic: deletes every token row of a lead and inserts one new hashed row, plus a `rotate_token` event.
   * Deleting (not suspending) is the revocation, because Resume un-suspends every row.
   * A token rotated during STOP ALL is written suspended, so Resume restores it like the others.
   */
  rotateToken(input: RotateTokenInput): Promise<{ ok: true; bot: ConnectorBot } | { ok: false; reason: "unknown_venture" }>;
  /** The pins launches use: the latest non-held `model_resolutions` row per family for this owner. */
  currentPins(ownerId: string): Promise<ModelPin[]>;
  listModelResolutions(ownerId: string): Promise<ModelResolutionRow[]>;
  /** True once the daily check wrote any row for this owner at or after `since`. */
  pinsResolvedSince(ownerId: string, since: string): Promise<boolean>;
  /** When the daily check last failed to reach the catalog for this owner, or null. */
  lastPinFailureAt(ownerId: string): Promise<string | null>;
  /**
   * Atomic, under one lock: appends `rows` (stamped `at`) only if none were written at or after `since`, and raises one
   * pending `model_upgrade` approval per held version that never had one. A second call the same day writes nothing.
   */
  recordPinResolutions(input: {
    ownerId: string;
    since: string;
    at: string;
    rows: PinResolution[];
  }): Promise<{ recorded: boolean; approvals: ConnectorApproval[] }>;
}

export function createMemoryConnectorStore(seed?: {
  stopped?: boolean;
  bots?: ConnectorBot[];
  tokens?: { tokenHash: string; botId: string; scopes: string[]; suspended?: boolean; createdAt?: string }[];
  modelResolutions?: (PinResolution & { ownerId: string; resolvedAt?: string })[];
}): ConnectorStore {
  let stopped = seed?.stopped ?? false;
  const bots = new Map<string, ConnectorBot>();
  for (const bot of seed?.bots ?? []) bots.set(bot.id, { ...bot });
  const tokens = (seed?.tokens ?? []).map((item) => ({ ...item, suspended: item.suspended ?? false }));
  // No await inside: the venture methods read and write in one turn of the event loop, which is their lock.
  function roster(): RosterRow[] {
    return [...bots.values()].map((bot) => {
      const issued = tokens
        .filter((item) => item.botId === bot.id && item.createdAt)
        .map((item) => item.createdAt as string)
        .sort();
      const added = events.filter((event) => event.action === "add_venture" && event.target === bot.id).at(-1);
      return { bot: { ...bot }, tokenIssuedAt: issued.at(-1) ?? null, venture: ventureMetaFrom(added?.result) };
    });
  }
  const events: ConnectorEvent[] = [];
  const agents = new Map<string, ConnectorAgent>();
  const requests = new Map<string, ConnectorRequest>();
  const approvals = new Map<string, ConnectorApproval>();
  const posts = new Map<string, ConnectorPost>();
  const resolutions: ModelResolutionRow[] = (seed?.modelResolutions ?? []).map((row) => ({
    ...row,
    resolvedAt: row.resolvedAt ?? new Date(0).toISOString(),
  }));

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
    async listEventsByAction(action, options) {
      const limit = options?.limit ?? 200;
      return events
        .filter((row) => row.action === action && (options?.target === undefined || row.target === options.target))
        .map((row, index) => ({ row, index }))
        .sort((a, b) => b.row.at.localeCompare(a.row.at) || b.index - a.index)
        .slice(0, limit)
        .map((item) => ({ ...item.row }));
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
    async listRoster() {
      return roster();
    },
    async createVenture(input) {
      const decision = input.decide(roster(), stopped);
      if (!decision.ok) return { ok: false, refusal: decision.refusal };
      const bot: ConnectorBot = { ...input.bot, ownerId: decision.ownerId };
      bots.set(bot.id, bot);
      tokens.push({ tokenHash: input.tokenHash, botId: bot.id, scopes: [...input.scopes], suspended: false, createdAt: input.at });
      events.push({
        id: randomUUID(),
        ownerId: bot.ownerId,
        actor: input.actor,
        action: "add_venture",
        target: bot.id,
        result: { ...input.meta, leadName: bot.name },
        at: input.at,
      });
      return { ok: true, bot: { ...bot } };
    },
    async rotateToken(input) {
      const bot = bots.get(input.botId);
      if (!bot || bot.kind !== "lead") return { ok: false, reason: "unknown_venture" };
      const old = tokens.filter((item) => item.botId === bot.id);
      const scopes = old.at(-1)?.scopes ?? input.fallbackScopes;
      for (const item of old) tokens.splice(tokens.indexOf(item), 1);
      tokens.push({ tokenHash: input.tokenHash, botId: bot.id, scopes: [...scopes], suspended: stopped, createdAt: input.at });
      events.push({
        id: randomUUID(),
        ownerId: bot.ownerId,
        actor: input.actor,
        action: "rotate_token",
        target: bot.id,
        result: { leadName: bot.name, revoked: old.length },
        at: input.at,
      });
      return { ok: true, bot: { ...bot } };
    },
    async currentPins(ownerId) {
      return latestPins(resolutions.filter((row) => row.ownerId === ownerId));
    },
    async listModelResolutions(ownerId) {
      return resolutions.filter((row) => row.ownerId === ownerId).map((row) => ({ ...row }));
    },
    async pinsResolvedSince(ownerId, since) {
      return resolutions.some((row) => row.ownerId === ownerId && row.resolvedAt >= since);
    },
    async lastPinFailureAt(ownerId) {
      const times = events
        .filter((row) => row.ownerId === ownerId && row.action === PIN_FAILURE_ACTION)
        .map((row) => row.at)
        .sort();
      return times.at(-1) ?? null;
    },
    // No await between the check and the writes, so this is atomic on one event loop.
    async recordPinResolutions({ ownerId, since, at, rows }) {
      if (resolutions.some((row) => row.ownerId === ownerId && row.resolvedAt >= since)) return { recorded: false, approvals: [] };
      for (const row of rows) resolutions.push({ ...row, ownerId, resolvedAt: at });
      const raised: ConnectorApproval[] = [];
      for (const row of rows.filter((item) => item.held)) {
        const target = modelUpgradeTarget(row);
        const seen = [...approvals.values()].some(
          (item) => item.ownerId === ownerId && item.action === MODEL_UPGRADE_ACTION && item.target === target,
        );
        if (seen) continue;
        const approval: ConnectorApproval = {
          id: randomUUID(),
          ownerId,
          action: MODEL_UPGRADE_ACTION,
          target,
          status: "pending",
          requestId: null,
        };
        approvals.set(approval.id, approval);
        raised.push({ ...approval });
      }
      return { recorded: true, approvals: raised };
    },
  };
}
