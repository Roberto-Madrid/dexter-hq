import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPgConnectorStore } from "../../hq/connector-pg.ts";
import { ACTIVE_AGENT_STATUSES, type ConnectorAgent, type ConnectorStore } from "../../hq/connector-store.ts";
import { databaseUrl, newPool } from "./db.ts";

let pool: pg.Pool;
let store: ConnectorStore;
const owner = randomUUID();
const bot = randomUUID();

function row(key: string, repo: string, requestId: string | null = null): ConnectorAgent {
  return {
    id: randomUUID(),
    ownerId: owner,
    botId: bot,
    cursorHandle: null,
    repo,
    role: "builder",
    family: "grok",
    status: "reserving",
    idempotencyKey: key,
    result: { requestId },
  };
}

async function activeCount(): Promise<number> {
  const found = await pool.query<{ n: string }>(
    "select count(*)::text as n from public.connector_agents where status = any($1::text[])",
    [[...ACTIVE_AGENT_STATUSES]],
  );
  return Number(found.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  pool = newPool();
  store = createPgConnectorStore(databaseUrl());
  await pool.query("insert into public.bots (id, owner_id, name, kind, repos) values ($1, $2, 'it-lead', 'lead', '{}')", [bot, owner]);
});

afterAll(async () => {
  await pool.query("delete from public.bots where id = $1", [bot]);
  await pool.end();
});

describe("connector caps under concurrency (Postgres)", () => {
  it("lets exactly 2 of 3 simultaneous launches on one repo through", async () => {
    const repo = `it/${randomUUID()}`;
    const caps = { global: 1000, perRepo: 2, perRequest: 5 };
    const results = await Promise.all(
      [1, 2, 3].map((n) => store.reserveLaunch({ agent: row(`repo-${repo}-${n}`, repo), requestId: null, caps })),
    );
    expect(results.filter((item) => item.ok)).toHaveLength(2);
    expect(results.filter((item) => !item.ok && item.reason === "per_repo_cap")).toHaveLength(1);
    const rows = await pool.query("select status from public.connector_agents where repo = $1", [repo]);
    expect(rows.rows.map((item) => item.status)).toEqual(["reserving", "reserving"]);
  });

  it("holds the global cap across repos", async () => {
    const caps = { global: (await activeCount()) + 2, perRepo: 2, perRequest: 5 };
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => store.reserveLaunch({ agent: row(`global-${randomUUID()}-${n}`, `it/${randomUUID()}`), requestId: null, caps })),
    );
    expect(results.filter((item) => item.ok)).toHaveLength(2);
    expect(results.filter((item) => !item.ok && item.reason === "agent_cap")).toHaveLength(2);
  });

  it("holds the per-request cap, counting finished launches", async () => {
    const requestId = randomUUID();
    const caps = { global: 1000, perRepo: 2, perRequest: 3 };
    const first = await store.reserveLaunch({ agent: row(`req-${requestId}-0`, `it/${randomUUID()}`, requestId), requestId, caps });
    expect(first.ok).toBe(true);
    if (first.ok) expect(await store.setAgentStatus(first.agent.id, ["reserving"], "finished")).toBe(true);
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        store.reserveLaunch({ agent: row(`req-${requestId}-${n}`, `it/${randomUUID()}`, requestId), requestId, caps }),
      ),
    );
    expect(results.filter((item) => item.ok)).toHaveLength(2);
    expect(results.filter((item) => !item.ok && item.reason === "request_cap")).toHaveLength(1);
  });

  it("reserves one row when the same key arrives twice, and re-reserves only a failed launch", async () => {
    const repo = `it/${randomUUID()}`;
    const caps = { global: 1000, perRepo: 2, perRequest: 5 };
    const key = `dup-${randomUUID()}`;
    const results = await Promise.all([1, 2].map(() => store.reserveLaunch({ agent: row(key, repo), requestId: null, caps })));
    expect(results.filter((item) => item.ok)).toHaveLength(1);
    expect(results.filter((item) => !item.ok && item.reason === "duplicate")).toHaveLength(1);
    const won = results.find((item) => item.ok);
    if (!won?.ok) throw new Error("no reservation");
    expect(await store.setAgentStatus(won.agent.id, ["reserving"], "launch_failed")).toBe(true);
    const retry = await store.reserveLaunch({ agent: row(key, repo), requestId: null, caps });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.agent.id).toBe(won.agent.id);
  });

  it("moves an agent to terminal once; a second move changes nothing", async () => {
    const repo = `it/${randomUUID()}`;
    const caps = { global: 1000, perRepo: 2, perRequest: 5 };
    const reserved = await store.reserveLaunch({ agent: row(`term-${randomUUID()}`, repo), requestId: null, caps });
    if (!reserved.ok) throw new Error("no reservation");
    await store.saveAgent({ ...reserved.agent, cursorHandle: `bc-${randomUUID()}:run-1`, status: "launched" });
    expect(await store.setAgentStatus(reserved.agent.id, ACTIVE_AGENT_STATUSES, "finished", { status: "finished" })).toBe(true);
    expect(await store.setAgentStatus(reserved.agent.id, ACTIVE_AGENT_STATUSES, "error")).toBe(false);
    const agent = await store.getAgent(reserved.agent.id);
    expect(agent?.status).toBe("finished");
    expect(agent?.result).toMatchObject({ status: "finished" });
    expect(agent?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("holds the Council seat cap under concurrency", async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const used = await pool.query<{ n: string }>(
      "select count(*)::text as n from public.events where action = 'council_seat' and at >= $1::timestamptz",
      [since],
    );
    const cap = Number(used.rows[0]?.n ?? 0) + 1;
    const event = { ownerId: owner, actor: "it-lead", action: "council_seat", target: "it", result: null, at: new Date().toISOString() };
    const results = await Promise.all([1, 2, 3].map(() => store.reserveCouncilSeat({ event, since, cap })));
    expect(results.filter((item) => item.ok)).toHaveLength(1);
  });
});
