import { randomUUID } from "node:crypto";
import pg from "pg";
import { pgConfig } from "./snapshot-db.ts";
import {
  ACTIVE_AGENT_STATUSES,
  launchCapRefusal,
  type ConnectorAgent,
  type ConnectorApproval,
  type ConnectorBot,
  type ConnectorRequest,
  type ConnectorStore,
} from "./connector-store.ts";

const AGENT_COLUMNS = "id, owner_id, bot_id, cursor_handle, repo, role, family, status, idempotency_key, result, created_at";
// One lock for every launch: the global cap spans all repos, so a per-repo key would not be enough.
const LAUNCH_LOCK = "select pg_advisory_xact_lock(hashtext('dexter.connector.launch'))";
const COUNCIL_LOCK = "select pg_advisory_xact_lock(hashtext('dexter.connector.council_seat'))";

async function inTransaction<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    const value = await fn();
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isMissingRelation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "42P01");
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(pgConfig(url));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function botFromRow(row: {
  id: string;
  owner_id: string;
  name: string;
  kind: string;
  repos: unknown;
  tools: unknown;
  current_task: string | null;
  heartbeat_at: Date | string | null;
}): ConnectorBot {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    kind: row.kind,
    repos: asStringArray(row.repos),
    tools: asStringArray(row.tools),
    currentTask: row.current_task,
    heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null,
  };
}

function approvalFromRow(row: {
  id: string;
  owner_id: string;
  request_id: string | null;
  action: string;
  target: string;
}): ConnectorApproval {
  const split = row.action.includes(":") ? row.action.split(":") : ["pending", row.action];
  const status = split[0] === "approved" || split[0] === "denied" || split[0] === "pending" ? split[0] : "pending";
  const action = split.length > 1 ? split.slice(1).join(":") : row.action;
  return {
    id: row.id,
    ownerId: row.owner_id,
    requestId: row.request_id,
    action,
    target: row.target,
    status: status as ConnectorApproval["status"],
  };
}

function agentFromRow(row: {
  id: string;
  owner_id: string;
  bot_id: string;
  cursor_handle: string | null;
  repo: string | null;
  role: string;
  family: string;
  status: string;
  idempotency_key: string;
  result: unknown;
  created_at?: Date | string | null;
}): ConnectorAgent {
  return {
    id: row.id,
    ownerId: row.owner_id,
    botId: row.bot_id,
    cursorHandle: row.cursor_handle,
    repo: row.repo,
    role: row.role,
    family: row.family,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    result: asRecord(row.result),
    ...(row.created_at ? { createdAt: new Date(row.created_at).toISOString() } : {}),
  };
}

export function createPgConnectorStore(url: string): ConnectorStore {
  return {
    async stopped() {
      return withClient(url, async (client) => {
        const found = await client.query<{ stop_all: boolean }>("select stop_all from public.control limit 1");
        return found.rows[0]?.stop_all ?? false;
      });
    },
    async setStopped(value) {
      await withClient(url, async (client) => {
        await client.query(
          `insert into public.control (owner_id, stop_all)
           select owner_id, $1 from public.control
           on conflict (owner_id) do update set stop_all = excluded.stop_all`,
          [value],
        );
        const existing = await client.query("select owner_id from public.control limit 1");
        if (existing.rows.length === 0) {
          await client.query("insert into public.control (owner_id, stop_all) values ($1, $2)", [randomUUID(), value]);
        }
      });
    },
    async setTokensSuspended(value) {
      await withClient(url, async (client) => {
        try {
          await client.query("update public.bot_tokens set suspended = $1", [value]);
        } catch (error) {
          if (isMissingRelation(error)) return;
          throw error;
        }
      });
    },
    async authenticate(tokenHash) {
      return withClient(url, async (client) => {
        const found = await client.query<{
          id: string;
          owner_id: string;
          name: string;
          kind: string;
          repos: unknown;
          tools: unknown;
          current_task: string | null;
          heartbeat_at: Date | string | null;
          scopes: unknown;
          suspended: boolean;
        }>(
          `select b.id, b.owner_id, b.name, b.kind, b.repos, b.tools, b.current_task, b.heartbeat_at, t.scopes, t.suspended
           from public.bot_tokens t
           join public.bots b on b.id = t.bot_id
           where t.token_hash = $1`,
          [tokenHash],
        );
        const row = found.rows[0];
        if (!row) return null;
        return { ...botFromRow(row), scopes: asStringArray(row.scopes), suspended: row.suspended };
      });
    },
    async getBot(id) {
      return withClient(url, async (client) => {
        const found = await client.query(
          `select id, owner_id, name, kind, repos, tools, current_task, heartbeat_at from public.bots where id = $1`,
          [id],
        );
        const row = found.rows[0];
        return row ? botFromRow(row) : null;
      });
    },
    async heartbeat(botId, task, at) {
      await withClient(url, async (client) => {
        await client.query("update public.bots set current_task = $2, heartbeat_at = $3::timestamptz where id = $1", [
          botId,
          task,
          at,
        ]);
      });
    },
    async appendEvent(event) {
      return withClient(url, async (client) => {
        const id = event.id ?? randomUUID();
        try {
          await client.query("select public.append_event($1,$2,$3,$4,$5::jsonb,null,null)", [
            event.ownerId,
            event.actor,
            event.action,
            event.target,
            event.result,
          ]);
        } catch {
          await client.query(
            `insert into public.events (id, owner_id, actor, action, target, result, at)
             values ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)`,
            [id, event.ownerId, event.actor, event.action, event.target, event.result, event.at],
          );
        }
        return { ...event, id, result: event.result };
      });
    },
    async listEvents() {
      return withClient(url, async (client) => {
        const found = await client.query<{
          id: string;
          owner_id: string;
          actor: string;
          action: string;
          target: string;
          result: unknown;
          at: Date | string;
        }>("select id, owner_id, actor, action, target, result, at from public.events order by at asc");
        return found.rows.map((row) => ({
          id: row.id,
          ownerId: row.owner_id,
          actor: row.actor,
          action: row.action,
          target: row.target,
          result: asRecord(row.result),
          at: new Date(row.at).toISOString(),
        }));
      });
    },
    async listBots() {
      return withClient(url, async (client) => {
        const found = await client.query(
          `select id, owner_id, name, kind, repos, tools, current_task, heartbeat_at from public.bots order by created_at asc`,
        );
        return found.rows.map(botFromRow);
      });
    },
    async listAgents() {
      return withClient(url, async (client) => {
        const found = await client.query(
          `select ${AGENT_COLUMNS}
           from public.connector_agents`,
        );
        return found.rows.map(agentFromRow);
      });
    },
    async getAgent(id) {
      return withClient(url, async (client) => {
        const found = await client.query(
          `select ${AGENT_COLUMNS}
           from public.connector_agents where id::text = $1 or cursor_handle = $1`,
          [id],
        );
        const row = found.rows[0];
        return row ? agentFromRow(row) : null;
      });
    },
    async findLaunch(botId, idempotencyKey) {
      return withClient(url, async (client) => {
        const found = await client.query(
          `select ${AGENT_COLUMNS}
           from public.connector_agents where bot_id = $1 and idempotency_key = $2`,
          [botId, idempotencyKey],
        );
        const row = found.rows[0];
        return row ? agentFromRow(row) : null;
      });
    },
    async saveAgent(agent) {
      await withClient(url, async (client) => {
        await client.query(
          `insert into public.connector_agents
             (id, owner_id, bot_id, cursor_handle, repo, role, family, status, idempotency_key, result)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
           on conflict (bot_id, idempotency_key) do update set
             cursor_handle = excluded.cursor_handle,
             status = excluded.status,
             result = excluded.result`,
          [
            agent.id,
            agent.ownerId,
            agent.botId,
            agent.cursorHandle,
            agent.repo,
            agent.role,
            agent.family,
            agent.status,
            agent.idempotencyKey,
            agent.result,
          ],
        );
      });
    },
    async reserveLaunch({ agent, requestId, caps }) {
      return withClient(url, async (client) =>
        inTransaction(client, async () => {
          await client.query(LAUNCH_LOCK);
          const found = await client.query(
            `select ${AGENT_COLUMNS} from public.connector_agents
             where status = any($3::text[]) or result->>'requestId' = $1 or (bot_id = $2 and idempotency_key = $4)`,
            [requestId, agent.botId, [...ACTIVE_AGENT_STATUSES], agent.idempotencyKey],
          );
          const rows = found.rows.map(agentFromRow);
          const existing = rows.find((row) => row.botId === agent.botId && row.idempotencyKey === agent.idempotencyKey);
          if (existing && existing.status !== "launch_failed") return { ok: false as const, reason: "duplicate" as const, existing };
          const refusal = launchCapRefusal(rows, { repo: agent.repo, requestId, caps });
          if (refusal) return { ok: false as const, ...refusal };
          const inserted = await client.query(
            `insert into public.connector_agents
               (id, owner_id, bot_id, cursor_handle, repo, role, family, status, idempotency_key, result)
             values ($1,$2,$3,null,$4,$5,$6,'reserving',$7,$8::jsonb)
             on conflict (bot_id, idempotency_key) do update set
               status = 'reserving', cursor_handle = null, result = excluded.result, created_at = now()
             where public.connector_agents.status = 'launch_failed'
             returning ${AGENT_COLUMNS}`,
            [agent.id, agent.ownerId, agent.botId, agent.repo, agent.role, agent.family, agent.idempotencyKey, { ...agent.result, requestId }],
          );
          const row = inserted.rows[0];
          if (!row) return { ok: false as const, reason: "duplicate" as const, existing: existing ?? null };
          return { ok: true as const, agent: agentFromRow(row) };
        }),
      );
    },
    async setAgentStatus(id, from, status, result) {
      return withClient(url, async (client) => {
        const updated = await client.query(
          `update public.connector_agents
           set status = $3, result = case when $4::boolean then $5::jsonb else result end
           where id::text = $1 and status = any($2::text[])`,
          [id, [...from], status, result !== undefined, result ?? null],
        );
        return (updated.rowCount ?? 0) > 0;
      });
    },
    async reserveCouncilSeat({ event, since, cap }) {
      return withClient(url, async (client) =>
        inTransaction(client, async () => {
          await client.query(COUNCIL_LOCK);
          const found = await client.query<{ n: string }>(
            "select count(*)::text as n from public.events where action = 'council_seat' and at >= $1::timestamptz",
            [since],
          );
          const used = Number(found.rows[0]?.n ?? 0);
          if (used >= cap) return { ok: false, used };
          await client.query("select public.append_event($1,$2,'council_seat',$3,$4::jsonb,null,null)", [
            event.ownerId,
            event.actor,
            event.target,
            event.result,
          ]);
          return { ok: true, used: used + 1 };
        }),
      );
    },
    async saveRequest(row) {
      await withClient(url, async (client) => persistRequest(client, row));
    },
    async getRequest(id) {
      return withClient(url, async (client) => readRequest(client, id));
    },
    async listRequests() {
      return withClient(url, async (client) => {
        const found = await client.query<{ id: string }>("select id from public.requests order by created_at asc");
        const rows = [];
        for (const item of found.rows) {
          const row = await readRequest(client, item.id);
          if (row) rows.push(row);
        }
        return rows;
      });
    },
    async saveApproval(row) {
      await withClient(url, async (client) => {
        await client.query(
          `insert into public.approvals (id, owner_id, request_id, action, target, plan_version)
           values ($1,$2,$3,$4,$5,1)
           on conflict (id) do update set action = excluded.action, target = excluded.target`,
          [row.id, row.ownerId, row.requestId, `${row.status}:${row.action}`, row.target],
        );
      });
    },
    async getApproval(id) {
      return withClient(url, async (client) => {
        const found = await client.query<{
          id: string;
          owner_id: string;
          request_id: string | null;
          action: string;
          target: string;
        }>("select id, owner_id, request_id, action, target from public.approvals where id = $1", [id]);
        const row = found.rows[0];
        return row ? approvalFromRow(row) : null;
      });
    },
    async claimApproval(id, status) {
      return withClient(url, async (client) => {
        const updated = await client.query<{
          id: string;
          owner_id: string;
          request_id: string | null;
          action: string;
          target: string;
        }>(
          `update public.approvals
           set action = $2 || case
             when action like 'pending:%' then substr(action, 9)
             else action
           end
           where id = $1
             and action not like 'approved:%'
             and action not like 'denied:%'
           returning id, owner_id, request_id, action, target`,
          [id, `${status}:`],
        );
        if (updated.rows[0]) return { claimed: true, row: approvalFromRow(updated.rows[0]) };
        const found = await client.query<{
          id: string;
          owner_id: string;
          request_id: string | null;
          action: string;
          target: string;
        }>("select id, owner_id, request_id, action, target from public.approvals where id = $1", [id]);
        const row = found.rows[0];
        return { claimed: false, row: row ? approvalFromRow(row) : null };
      });
    },
    async listApprovals() {
      return withClient(url, async (client) => {
        const found = await client.query<{
          id: string;
          owner_id: string;
          request_id: string | null;
          action: string;
          target: string;
        }>("select id, owner_id, request_id, action, target from public.approvals order by approved_at asc");
        return found.rows.map(approvalFromRow);
      });
    },
    async savePost(row) {
      await withClient(url, async (client) => {
        await client.query(
          `insert into public.posts (id, owner_id, type, author, evidence, verified_by, status)
           values ($1,$2,$3,$4,$5::jsonb,$6,$7)
           on conflict (id) do update set evidence = excluded.evidence, verified_by = excluded.verified_by, status = excluded.status`,
          [
            row.id,
            row.ownerId,
            row.type,
            row.author,
            { body: row.body, repo: row.repo },
            row.verified ? "owner" : null,
            row.verified ? "verified" : "claimed",
          ],
        );
      });
    },
    async getPost(id) {
      return withClient(url, async (client) => {
        const found = await client.query<{
          id: string;
          owner_id: string;
          type: string;
          author: string;
          evidence: unknown;
          verified_by: string | null;
        }>("select id, owner_id, type, author, evidence, verified_by from public.posts where id = $1", [id]);
        const row = found.rows[0];
        if (!row) return null;
        const evidence = asRecord(row.evidence) ?? {};
        return {
          id: row.id,
          ownerId: row.owner_id,
          type: row.type,
          author: row.author,
          body: String(evidence.body ?? ""),
          repo: evidence.repo ? String(evidence.repo) : null,
          verified: Boolean(row.verified_by),
        };
      });
    },
    async listPosts() {
      return withClient(url, async (client) => {
        const found = await client.query<{
          id: string;
          owner_id: string;
          type: string;
          author: string;
          evidence: unknown;
          verified_by: string | null;
        }>("select id, owner_id, type, author, evidence, verified_by from public.posts");
        return found.rows.map((row) => {
          const evidence = asRecord(row.evidence) ?? {};
          return {
            id: row.id,
            ownerId: row.owner_id,
            type: row.type,
            author: row.author,
            body: String(evidence.body ?? ""),
            repo: evidence.repo ? String(evidence.repo) : null,
            verified: Boolean(row.verified_by),
          };
        });
      });
    },
  };
}

async function persistRequest(client: pg.Client, row: ConnectorRequest): Promise<void> {
  await client.query(
    `insert into public.requests (id, owner_id, goal, crew, tier, definition_of_done, status, caps)
     values ($1,$2,$3,$4,$5,$6,$7::public.request_status, $8::jsonb)
     on conflict (id) do update set status = excluded.status, caps = excluded.caps`,
    [
      row.id,
      row.ownerId,
      row.goal,
      String(row.card?.crew ?? "custom"),
      String(row.card?.tier ?? "T1"),
      String(row.card?.definitionOfDone ?? row.goal),
      row.status,
      { evidence: row.evidence, assignedBotId: row.assignedBotId, repo: row.repo, card: row.card, notices: row.notices, checkRun: row.checkRun ?? null, pullRequest: row.pullRequest ?? null, branch: row.branch ?? null },
    ],
  );
}

async function readRequest(client: pg.Client, id: string): Promise<ConnectorRequest | null> {
  const found = await client.query<{
    id: string;
    owner_id: string;
    goal: string;
    status: string;
    caps: unknown;
  }>("select id, owner_id, goal, status, caps from public.requests where id = $1", [id]);
  const row = found.rows[0];
  if (!row) return null;
  const caps = asRecord(row.caps) ?? {};
  return {
    id: row.id,
    ownerId: row.owner_id,
    goal: row.goal,
    status: row.status,
    card: asRecord(caps.card),
    evidence: asStringArray(caps.evidence),
    assignedBotId: caps.assignedBotId ? String(caps.assignedBotId) : null,
    repo: caps.repo ? String(caps.repo) : null,
    notices: asStringArray(caps.notices),
    checkRun: parseCheckRun(caps.checkRun),
    pullRequest: typeof caps.pullRequest === "string" ? caps.pullRequest : null,
    branch: typeof caps.branch === "string" ? caps.branch : null,
  };
}

function parseCheckRun(value: unknown): ConnectorRequest["checkRun"] {
  const row = asRecord(value);
  if (!row) return null;
  if (typeof row.nonce !== "string" || typeof row.sha !== "string" || typeof row.repo !== "string") return null;
  return {
    nonce: row.nonce,
    githubRunId: typeof row.githubRunId === "string" ? row.githubRunId : null,
    sha: row.sha,
    repo: row.repo,
    hostRepo: typeof row.hostRepo === "string" ? row.hostRepo : "",
    dispatchedAt: typeof row.dispatchedAt === "string" ? row.dispatchedAt : "",
    passed: row.passed === true,
  };
}
