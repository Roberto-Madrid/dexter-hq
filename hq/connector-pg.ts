import { randomUUID } from "node:crypto";
import pg from "pg";
import { pgConfig } from "./snapshot-db.ts";
import {
  ACTIVE_AGENT_STATUSES,
  followupClaim,
  followupRefusal,
  launchCapRefusal,
  MODEL_UPGRADE_ACTION,
  modelUpgradeTarget,
  PIN_FAILURE_ACTION,
  UPGRADE_CHECK_DONE,
  type ConnectorAgent,
  type ConnectorApproval,
  type ConnectorBot,
  type ConnectorPost,
  type ConnectorRequest,
  type ConnectorStore,
  type ModelResolutionRow,
} from "./connector-store.ts";
import { assertSingleBinding, ventureMetaFrom, type RosterRow } from "./connector-store.ts";

const AGENT_COLUMNS = "id, owner_id, bot_id, cursor_handle, repo, role, family, status, idempotency_key, result, created_at";
// One lock for every launch: the global cap spans all repos, so a per-repo key would not be enough.
const LAUNCH_LOCK = "select pg_advisory_xact_lock(hashtext('dexter.connector.launch'))";
const COUNCIL_LOCK = "select pg_advisory_xact_lock(hashtext('dexter.connector.council_seat'))";
const PINS_LOCK = "select pg_advisory_xact_lock(hashtext('dexter.connector.pins'))";
const INTERNAL_BOT_LOCK = "select pg_advisory_xact_lock(hashtext('dexter.connector.internal_bot'))";
const OUTCOMES_LOCK = "select pg_advisory_xact_lock(hashtext('dexter.connector.model_outcomes'))";
// Rows an upgrade switch or rollback appends change the pin but are not the daily check (see isPinSwitchReason).
const DAILY_ROW = "coalesce(reason, '') not like 'upgrade:%' and coalesce(reason, '') not like 'rollback:%'";
const CURRENT_PIN_SQL = `select version from public.model_resolutions
  where owner_id = $1 and family = $2 and not held
  order by resolved_at desc, id desc limit 1`;

async function currentPinVersion(client: pg.Client, ownerId: string, family: string): Promise<string | null> {
  const found = await client.query<{ version: string }>(CURRENT_PIN_SQL, [ownerId, family]);
  return found.rows[0]?.version ?? null;
}

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
  approved_at?: Date | string | null;
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
    // approved_at is stamped when the approval is decided (it is the insert time on rows decided before that).
    decidedAt: status === "pending" || !row.approved_at ? null : new Date(row.approved_at).toISOString(),
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

/** One lock for every venture create and rotate, so duplicate checks and inserts cannot interleave. */
const VENTURE_LOCK_SQL = "select pg_advisory_xact_lock(hashtext('dexter.ventures'))";
// Same row the connector's stopped() reads. `for share` makes a concurrent STOP ALL wait for this
// transaction, so its token suspend that follows also sees the row written here.
const STOP_FOR_SHARE_SQL = "select stop_all from public.control limit 1 for share";

async function readRoster(client: pg.Client): Promise<RosterRow[]> {
  // dexter-shortcut: venture name/brief live in the newest add_venture event (no ventures table, and
  // events has no index on action, so this scans events once per read); upgrade path: a ventures table or
  // an events(action, target) index in a migration once events grows large.
  const found = await client.query<{
    id: string;
    owner_id: string;
    name: string;
    kind: string;
    repos: unknown;
    tools: unknown;
    current_task: string | null;
    heartbeat_at: Date | string | null;
    token_issued_at: Date | string | null;
    venture: unknown;
  }>(
    `with v as (
       select distinct on (target) target, result
       from public.events where action = 'add_venture'
       order by target, at desc
     ), t as (
       select bot_id, max(created_at) as issued from public.bot_tokens group by bot_id
     )
     select b.id, b.owner_id, b.name, b.kind, b.repos, b.tools, b.current_task, b.heartbeat_at,
            t.issued as token_issued_at, v.result as venture
     from public.bots b
     left join t on t.bot_id = b.id
     left join v on v.target = b.id::text
     order by b.created_at asc, b.id asc`,
  );
  return found.rows.map((row) => ({
    bot: botFromRow(row),
    tokenIssuedAt: row.token_issued_at ? new Date(row.token_issued_at).toISOString() : null,
    venture: ventureMetaFrom(row.venture),
  }));
}

async function ventureTransaction<T>(client: pg.Client, fn: () => Promise<{ commit: boolean; value: T }>): Promise<T> {
  await client.query("begin");
  try {
    const { commit, value } = await fn();
    await client.query(commit ? "commit" : "rollback");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
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
    async listRecentEvents(action, options) {
      return withClient(url, async (client) => {
        // dexter-shortcut: no (action, target) index on events; the log is small. upgrade path: an index on (action, target, at) once events pass ~100k rows.
        const found = await client.query<{
          id: string;
          owner_id: string;
          actor: string;
          action: string;
          target: string;
          result: unknown;
          at: Date | string;
        }>(
          `select id, owner_id, actor, action, target, result, at from public.events
           where action = $1 and ($2::text is null or target = $2)
           order by at desc limit $3`,
          [action, options?.target ?? null, Math.max(1, Math.min(options?.limit ?? 200, 5000))],
        );
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
    async setAgentStatus({ id, from, status, result, run }) {
      return withClient(url, async (client) => {
        // The run check mirrors runHandleFor: the latest follow-up run, else the launch run.
        const updated = await client.query(
          `update public.connector_agents
           set status = $3, result = case when $4::boolean then $5::jsonb else result end
           where id::text = $1 and status = any($2::text[])
             and (not $6::boolean or coalesce(nullif(result->>'latestRunHandle', ''), cursor_handle) is not distinct from $7::text)`,
          [id, [...from], status, result !== undefined, result ?? null, run !== undefined, run ?? null],
        );
        return (updated.rowCount ?? 0) > 0;
      });
    },
    async reserveFollowup({ id, caps, at }) {
      return withClient(url, async (client) =>
        inTransaction(client, async () => {
          // Same lock as launches, so a follow-up and a launch cannot both take the last slot.
          await client.query(LAUNCH_LOCK);
          const found = await client.query(
            `select ${AGENT_COLUMNS} from public.connector_agents where status = any($1::text[]) or id::text = $2`,
            [[...ACTIVE_AGENT_STATUSES], id],
          );
          const rows = found.rows.map(agentFromRow);
          const agent = rows.find((row) => row.id === id);
          if (!agent) return { ok: false as const, reason: "unknown_agent" as const };
          const refusal = followupRefusal(rows, agent, caps);
          if (refusal) return refusal;
          const claim = followupClaim(agent, at);
          await client.query("update public.connector_agents set status = $2, result = $3::jsonb where id = $1", [
            id,
            claim.status,
            claim.result,
          ]);
          return { ok: true as const, previous: agent };
        }),
      );
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
          approved_at: Date | null;
        }>("select id, owner_id, request_id, action, target, approved_at from public.approvals where id = $1", [id]);
        const row = found.rows[0];
        return row ? approvalFromRow(row) : null;
      });
    },
    async claimApproval(id, status, decidedAt) {
      return withClient(url, async (client) => {
        const updated = await client.query<{
          id: string;
          owner_id: string;
          request_id: string | null;
          action: string;
          target: string;
          approved_at: Date | null;
        }>(
          `update public.approvals
           set action = $2 || case
             when action like 'pending:%' then substr(action, 9)
             else action
           end,
           approved_at = coalesce($3::timestamptz, now())
           where id = $1
             and action not like 'approved:%'
             and action not like 'denied:%'
           returning id, owner_id, request_id, action, target, approved_at`,
          [id, `${status}:`, decidedAt ?? null],
        );
        if (updated.rows[0]) return { claimed: true, row: approvalFromRow(updated.rows[0]) };
        const found = await client.query<{
          id: string;
          owner_id: string;
          request_id: string | null;
          action: string;
          target: string;
          approved_at: Date | null;
        }>("select id, owner_id, request_id, action, target, approved_at from public.approvals where id = $1", [id]);
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
          approved_at: Date | null;
        }>("select id, owner_id, request_id, action, target, approved_at from public.approvals order by approved_at asc");
        return found.rows.map(approvalFromRow);
      });
    },
    async savePost(row) {
      await withClient(url, async (client) => {
        await client.query(
          `insert into public.posts (id, owner_id, type, author, evidence, verified_by, status, expires_at, created_at)
           values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::timestamptz, coalesce($9::timestamptz, now()))
           on conflict (id) do update set
             evidence = excluded.evidence,
             verified_by = excluded.verified_by,
             status = excluded.status,
             expires_at = excluded.expires_at`,
          [
            row.id,
            row.ownerId,
            row.type,
            row.author,
            postEvidence(row),
            row.verifiedBy !== undefined ? row.verifiedBy : row.verified ? "owner" : null,
            row.status !== undefined ? row.status : row.verified ? "verified" : "claimed",
            row.expiresAt ?? null,
            row.createdAt ?? null,
          ],
        );
      });
    },
    async getPost(id) {
      return withClient(url, async (client) => {
        const found = await client.query<PostRow>(`${POST_SELECT} where id = $1`, [id]);
        const row = found.rows[0];
        return row ? postFromRow(row) : null;
      });
    },
    async listPosts() {
      return withClient(url, async (client) => {
        // dexter-shortcut: reads every post and filters scope/expiry in memory (live: 0 posts); upgrade path: push owner, scope and expiry filters into SQL with an index once the board passes a few thousand rows.
        const found = await client.query<PostRow>(`${POST_SELECT} order by created_at asc`);
        return found.rows.map(postFromRow);
      });
    },
    async listRoster() {
      return withClient(url, readRoster);
    },
    async createVenture(input) {
      return withClient(url, (client) =>
        ventureTransaction<Awaited<ReturnType<ConnectorStore["createVenture"]>>>(client, async () => {
          await client.query(VENTURE_LOCK_SQL);
          const stop = await client.query<{ stop_all: boolean }>(STOP_FOR_SHARE_SQL);
          const decision = input.decide(await readRoster(client), stop.rows[0]?.stop_all ?? false);
          if (!decision.ok) return { commit: false, value: { ok: false as const, refusal: decision.refusal } };
          const bot: ConnectorBot = { ...input.bot, ownerId: decision.ownerId };
          await client.query(
            `insert into public.bots (id, owner_id, name, kind, repos, tools, created_at)
             values ($1, $2, $3, $4, $5::text[], $6::text[], $7::timestamptz)`,
            [bot.id, bot.ownerId, bot.name, bot.kind, bot.repos, bot.tools, input.at],
          );
          await client.query(
            `insert into public.bot_tokens (owner_id, bot_id, token_hash, scopes, suspended, created_at)
             values ($1, $2, $3, $4::text[], false, $5::timestamptz)`,
            [bot.ownerId, bot.id, input.tokenHash, input.scopes, input.at],
          );
          await client.query("select public.append_event($1, $2, 'add_venture', $3, $4::jsonb, null, null)", [
            bot.ownerId,
            input.actor,
            bot.id,
            { ...input.meta, leadName: bot.name },
          ]);
          return { commit: true, value: { ok: true as const, bot } };
        }),
      );
    },
    async rotateToken(input) {
      return withClient(url, (client) =>
        ventureTransaction<Awaited<ReturnType<ConnectorStore["rotateToken"]>>>(client, async () => {
          await client.query(VENTURE_LOCK_SQL);
          const found = await client.query(
            `select id, owner_id, name, kind, repos, tools, current_task, heartbeat_at
             from public.bots where id::text = $1 and kind = 'lead' for update`,
            [input.botId],
          );
          const row = found.rows[0];
          if (!row) return { commit: false, value: { ok: false as const, reason: "unknown_venture" as const } };
          const bot = botFromRow(row);
          const stop = await client.query<{ stop_all: boolean }>(STOP_FOR_SHARE_SQL);
          const latest = await client.query<{ scopes: unknown }>(
            "select scopes from public.bot_tokens where bot_id = $1 order by created_at desc limit 1",
            [bot.id],
          );
          const scopes = latest.rows[0] ? asStringArray(latest.rows[0].scopes) : input.fallbackScopes;
          const removed = await client.query("delete from public.bot_tokens where bot_id = $1", [bot.id]);
          await client.query(
            `insert into public.bot_tokens (owner_id, bot_id, token_hash, scopes, suspended, created_at)
             values ($1, $2, $3, $4::text[], $5, $6::timestamptz)`,
            [bot.ownerId, bot.id, input.tokenHash, scopes, stop.rows[0]?.stop_all ?? false, input.at],
          );
          await client.query("select public.append_event($1, $2, 'rotate_token', $3, $4::jsonb, null, null)", [
            bot.ownerId,
            input.actor,
            bot.id,
            { leadName: bot.name, revoked: removed.rowCount ?? 0 },
          ]);
          return { commit: true, value: { ok: true as const, bot } };
        }),
      );
    },
    async currentPins(ownerId) {
      return withClient(url, async (client) => {
        const found = await client.query<{ family: string; version: string }>(
          `select distinct on (family) family, version
           from public.model_resolutions
           where owner_id = $1 and not held
           order by family, resolved_at desc, id desc`,
          [ownerId],
        );
        return found.rows.map((row) => ({ family: row.family, version: row.version }));
      });
    },
    async listModelResolutions(ownerId) {
      return withClient(url, async (client) => {
        const found = await client.query<{
          id: string;
          owner_id: string;
          family: string;
          version: string;
          held: boolean;
          reason: string | null;
          resolved_at: Date | string;
        }>(
          `select id, owner_id, family, version, held, reason, resolved_at
           from public.model_resolutions where owner_id = $1 order by resolved_at asc, family asc`,
          [ownerId],
        );
        return found.rows.map(
          (row): ModelResolutionRow => ({
            id: row.id,
            ownerId: row.owner_id,
            family: row.family,
            version: row.version,
            held: row.held,
            reason: row.reason ?? "",
            resolvedAt: new Date(row.resolved_at).toISOString(),
          }),
        );
      });
    },
    async pinsResolvedSince(ownerId, since) {
      return withClient(url, async (client) => {
        const found = await client.query(
          `select 1 from public.model_resolutions where owner_id = $1 and resolved_at >= $2::timestamptz and ${DAILY_ROW} limit 1`,
          [ownerId, since],
        );
        return found.rows.length > 0;
      });
    },
    async lastPinFailureAt(ownerId) {
      return withClient(url, async (client) => {
        const found = await client.query<{ at: Date | string | null }>(
          "select max(at) as at from public.events where owner_id = $1 and action = $2",
          [ownerId, PIN_FAILURE_ACTION],
        );
        const at = found.rows[0]?.at;
        return at ? new Date(at).toISOString() : null;
      });
    },
    async recordPinResolutions({ ownerId, since, at, rows }) {
      return withClient(url, async (client) =>
        inTransaction(client, async () => {
          await client.query(PINS_LOCK);
          const done = await client.query(
            `select 1 from public.model_resolutions where owner_id = $1 and resolved_at >= $2::timestamptz and ${DAILY_ROW} limit 1`,
            [ownerId, since],
          );
          if (done.rows.length > 0) return { recorded: false, approvals: [] };
          for (const row of rows) {
            await client.query(
              `insert into public.model_resolutions (owner_id, family, version, held, reason, resolved_at)
               values ($1,$2,$3,$4,$5,$6::timestamptz)`,
              [ownerId, row.family, row.version, row.held, row.reason, at],
            );
          }
          const raised: ConnectorApproval[] = [];
          for (const row of rows.filter((item) => item.held)) {
            const target = modelUpgradeTarget(row);
            const seen = await client.query(
              `select 1 from public.approvals
               where owner_id = $1 and target = $2 and (action = $3 or action like '%:' || $3)
               limit 1`,
              [ownerId, target, MODEL_UPGRADE_ACTION],
            );
            if (seen.rows.length > 0) continue;
            const approval: ConnectorApproval = {
              id: randomUUID(),
              ownerId,
              action: MODEL_UPGRADE_ACTION,
              target,
              status: "pending",
              requestId: null,
            };
            await client.query(
              `insert into public.approvals (id, owner_id, request_id, action, target, plan_version)
               values ($1,$2,null,$3,$4,1)`,
              [approval.id, ownerId, `pending:${MODEL_UPGRADE_ACTION}`, target],
            );
            raised.push(approval);
          }
          return { recorded: true, approvals: raised };
        }),
      );
    },
    async listEventsByAction(actions) {
      return withClient(url, async (client) => {
        // dexter-shortcut: events has no index on action, so this scans it once per tick; upgrade path: an events(action) index in a migration once events grows large.
        const found = await client.query<{
          id: string;
          owner_id: string;
          actor: string;
          action: string;
          target: string;
          result: unknown;
          at: Date | string;
        }>("select id, owner_id, actor, action, target, result, at from public.events where action = any($1::text[]) order by at asc", [
          [...actions],
        ]);
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
    async ensureInternalBot({ ownerId, name, kind, repos, at }) {
      return withClient(url, async (client) =>
        inTransaction(client, async () => {
          // bots has no unique (owner, name); the lock keeps two ticks from creating it twice.
          await client.query(INTERNAL_BOT_LOCK);
          const found = await client.query(
            `update public.bots set repos = $4::text[]
             where id = (select id from public.bots where owner_id = $1 and name = $2 and kind = $3 order by created_at asc limit 1)
             returning id, owner_id, name, kind, repos, tools, current_task, heartbeat_at`,
            [ownerId, name, kind, repos],
          );
          if (found.rows[0]) return botFromRow(found.rows[0]);
          const inserted = await client.query(
            `insert into public.bots (id, owner_id, name, kind, repos, tools, created_at)
             values ($1, $2, $3, $4, $5::text[], '{}', $6::timestamptz)
             returning id, owner_id, name, kind, repos, tools, current_task, heartbeat_at`,
            [randomUUID(), ownerId, name, kind, repos, at],
          );
          return botFromRow(inserted.rows[0]);
        }),
      );
    },
    async listModelOutcomes(ownerId) {
      return withClient(url, async (client) => {
        const found = await client.query<{
          id: string;
          owner_id: string;
          run_id: string | null;
          model_row_id: string | null;
          passed: boolean;
          checks_failed: number;
          at: Date | string;
        }>(
          "select id, owner_id, run_id, model_row_id, passed, checks_failed, at from public.model_outcomes where owner_id = $1 and run_id is not null order by at asc",
          [ownerId],
        );
        return found.rows.map((row) => ({
          id: row.id,
          ownerId: row.owner_id,
          runId: String(row.run_id),
          modelRowId: row.model_row_id,
          passed: row.passed,
          checksFailed: row.checks_failed,
          at: new Date(row.at).toISOString(),
        }));
      });
    },
    async recordModelOutcome(row) {
      return withClient(url, async (client) =>
        inTransaction(client, async () => {
          // model_outcomes has no unique run_id; the lock makes "one outcome per run" hold across overlapping ticks.
          await client.query(OUTCOMES_LOCK);
          const seen = await client.query("select 1 from public.model_outcomes where run_id = $1 limit 1", [row.runId]);
          if (seen.rows.length > 0) return false;
          await client.query(
            `insert into public.model_outcomes (owner_id, run_id, model_row_id, passed, checks_failed, escalated, at)
             values ($1, $2, $3, $4, $5, false, $6::timestamptz)`,
            [row.ownerId, row.runId, row.modelRowId, row.passed, row.checksFailed, row.at],
          );
          return true;
        }),
      );
    },
    async applyUpgradeDecision({ ownerId, checkId, at, event, pin, approval }) {
      return withClient(url, async (client) =>
        inTransaction(client, async () => {
          await client.query(PINS_LOCK);
          const done = await client.query("select 1 from public.events where action = $1 and target = $2 limit 1", [UPGRADE_CHECK_DONE, checkId]);
          if (done.rows.length > 0) return { applied: false as const, reason: "already_done" as const };
          if (pin && (await currentPinVersion(client, ownerId, pin.family)) !== pin.from) {
            return { applied: false as const, reason: "pin_moved" as const };
          }
          if (pin) {
            await client.query(
              `insert into public.model_resolutions (owner_id, family, version, held, reason, resolved_at)
               values ($1, $2, $3, false, $4, $5::timestamptz)`,
              [ownerId, pin.family, pin.to, pin.reason, at],
            );
          }
          if (approval) {
            await client.query(
              `insert into public.approvals (id, owner_id, request_id, action, target, plan_version)
               values ($1, $2, $3, $4, $5, 1)`,
              [approval.id, ownerId, approval.requestId, `${approval.status}:${approval.action}`, approval.target],
            );
          }
          await client.query("select public.append_event($1, $2, $3, $4, $5::jsonb, null, null)", [
            ownerId,
            event.actor,
            UPGRADE_CHECK_DONE,
            checkId,
            event.result,
          ]);
          return { applied: true as const };
        }),
      );
    },
    async switchPin({ ownerId, family, from, to, reason, at }) {
      return withClient(url, async (client) =>
        inTransaction(client, async () => {
          await client.query(PINS_LOCK);
          const current = await currentPinVersion(client, ownerId, family);
          if (current !== from) return { switched: false, current };
          await client.query(
            `insert into public.model_resolutions (owner_id, family, version, held, reason, resolved_at)
             values ($1, $2, $3, false, $4, $5::timestamptz)`,
            [ownerId, family, to, reason, at],
          );
          return { switched: true, current: to };
        }),
      );
    },
  };
}

type PostRow = {
  id: string;
  owner_id: string;
  type: string;
  author: string;
  evidence: unknown;
  verified_by: string | null;
  status: string | null;
  expires_at: Date | string | null;
  created_at: Date | string | null;
};

const POST_SELECT = "select id, owner_id, type, author, evidence, verified_by, status, expires_at, created_at from public.posts";

const POST_EVIDENCE_KEYS = [
  "scope",
  "authorId",
  "requestId",
  "agentId",
  "runId",
  "sha",
  "link",
  "conditions",
  "verdict",
  "subjectBotId",
  "kind",
  "approach",
  "output",
  "outputChars",
  "artifactId",
] as const;

/** Body, repo, scope and provenance live in `posts.evidence`; no schema change. */
function postEvidence(row: ConnectorPost): Record<string, unknown> {
  const out: Record<string, unknown> = { body: row.body, repo: row.repo };
  for (const key of POST_EVIDENCE_KEYS) {
    const value = row[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function isoOrNull(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function postFromRow(row: PostRow): ConnectorPost {
  const evidence = asRecord(row.evidence) ?? {};
  const scope = evidence.scope === "shared" || evidence.scope === "project" || evidence.scope === "mission" ? evidence.scope : null;
  const status = row.status ?? (row.verified_by ? "verified" : null);
  return {
    id: row.id,
    ownerId: row.owner_id,
    type: row.type,
    author: row.author,
    body: String(evidence.body ?? ""),
    repo: evidence.repo ? String(evidence.repo) : null,
    verified: status === "verified",
    authorId: optionalText(evidence.authorId),
    status,
    verifiedBy: row.verified_by,
    scope,
    requestId: optionalText(evidence.requestId),
    agentId: optionalText(evidence.agentId),
    runId: optionalText(evidence.runId),
    sha: optionalText(evidence.sha),
    link: optionalText(evidence.link),
    conditions: optionalText(evidence.conditions),
    expiresAt: isoOrNull(row.expires_at),
    createdAt: isoOrNull(row.created_at),
    verdict: evidence.verdict === "pass" || evidence.verdict === "fail" ? evidence.verdict : null,
    subjectBotId: optionalText(evidence.subjectBotId),
    kind: optionalText(evidence.kind),
    approach: optionalText(evidence.approach),
    output: optionalText(evidence.output),
    outputChars: typeof evidence.outputChars === "number" && Number.isFinite(evidence.outputChars) ? evidence.outputChars : null,
    artifactId: optionalText(evidence.artifactId),
  };
}

async function persistRequest(client: pg.Client, row: ConnectorRequest): Promise<void> {
  assertSingleBinding(row);
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
