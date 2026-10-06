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
};

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
};

export type ConnectorApproval = {
  id: string;
  ownerId: string;
  action: string;
  target: string;
  status: "pending" | "approved" | "denied";
  requestId: string | null;
};

export type ConnectorPost = {
  id: string;
  ownerId: string;
  type: string;
  author: string;
  body: string;
  repo: string | null;
  verified: boolean;
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
