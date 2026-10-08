import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import { createPgConnectorStore } from "../../hq/connector-pg.ts";
import { callConnectorTool, createDefaultConnectorDeps, hashBotToken, loadConnectorSheetText } from "../../hq/connector.ts";
import type { ConnectorStore } from "../../hq/connector-store.ts";
import { handleMcpHttp } from "../../hq/mcp.ts";
import { LEAD_SCOPES, handleVenturesHttp, type VenturesDeps } from "../../hq/ventures.ts";
import { databaseUrl, newPool } from "./db.ts";

// Every name and repo carries a run id so this suite can share the local database with other suites.
const run = randomUUID().slice(0, 8);
const owner = randomUUID();
const ceo = randomUUID();
const ceoToken = `it-ceo-${run}`;
let pool: pg.Pool;
let store: ConnectorStore;

function deps(): VenturesDeps {
  return { store, repoCheck: async () => "reachable", ownerFromCookie: () => "owner@example.com" };
}

async function post(body: Record<string, unknown>) {
  const response = await handleVenturesHttp(
    new Request("http://127.0.0.1/api/board", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "dexter_session=stub" },
      body: JSON.stringify(body),
    }),
    deps(),
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function venture(suffix: string) {
  return {
    action: "add_venture",
    name: `IT ${run} ${suffix}`,
    repo: `it-${run}/${suffix}`,
    leadName: `it-${run}-${suffix}-lead`,
    brief: "integration",
  };
}

async function mcpStatus(token: string): Promise<number> {
  const response = await handleMcpHttp(
    new Request("http://127.0.0.1/api/mcp", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
    }),
    createDefaultConnectorDeps({ store, sheet: parseRoleSheet(loadConnectorSheetText()), cursor: null, cursorConfigured: false }),
  );
  return response.status;
}

beforeAll(async () => {
  pool = newPool();
  store = createPgConnectorStore(databaseUrl());
  await pool.query(
    "insert into public.bots (id, owner_id, name, kind, repos, tools) values ($1, $2, $3, 'ceo', '{}', '{whoami,get_context}')",
    [ceo, owner, `it-ceo-${run}`],
  );
  await pool.query("insert into public.bot_tokens (owner_id, bot_id, token_hash, scopes) values ($1, $2, $3, '{whoami,get_context}')", [
    owner,
    ceo,
    hashBotToken(ceoToken),
  ]);
});

afterAll(async () => {
  await pool.query("delete from public.bots where name like $1", [`it-${run}-%`]);
  await pool.query("delete from public.bots where id = $1", [ceo]);
  await pool.end();
});

describe("ventures on Postgres", () => {
  it("stores the lead, a hashed token only, and an event without the token", async () => {
    const created = await post(venture("one"));
    expect(created.status).toBe(201);
    const token = String(created.json.token);
    const botId = String((created.json.venture as Record<string, unknown>).botId);

    const bot = await pool.query("select kind, repos, tools, owner_id from public.bots where id = $1", [botId]);
    expect(bot.rows[0]).toMatchObject({ kind: "lead", repos: [`it-${run}/one`], tools: [...LEAD_SCOPES] });
    const tokens = await pool.query("select * from public.bot_tokens where bot_id = $1", [botId]);
    expect(tokens.rows).toHaveLength(1);
    expect(tokens.rows[0]).toMatchObject({ token_hash: hashBotToken(token), scopes: [...LEAD_SCOPES], suspended: false });
    expect(JSON.stringify(tokens.rows)).not.toContain(token);
    const events = await pool.query("select action, target, result from public.events where target = $1", [botId]);
    expect(events.rows.map((row) => row.action)).toEqual(["add_venture"]);
    expect(events.rows[0]?.result).toMatchObject({ name: `IT ${run} one`, repo: `it-${run}/one` });
    expect(JSON.stringify(events.rows)).not.toContain(token);
    expect(await mcpStatus(token)).toBe(200);
  });

  it("mints exactly one lead when the same venture is created three times at once", async () => {
    const body = venture("race");
    const results = await Promise.all([1, 2, 3].map((n) => post({ ...body, idempotencyKey: `k${n}` })));
    expect(results.map((item) => item.status).sort()).toEqual([201, 409, 409]);
    const rows = await pool.query("select id from public.bots where name = $1", [body.leadName]);
    expect(rows.rows).toHaveLength(1);
  });

  it("replays a create with the same idempotency key without a second lead or token", async () => {
    const body = { ...venture("replay"), idempotencyKey: `form-${run}` };
    const first = await post(body);
    const second = await post(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ status: "already_created", token: null });
    const botId = String((first.json.venture as Record<string, unknown>).botId);
    const tokens = await pool.query("select count(*)::int as n from public.bot_tokens where bot_id = $1", [botId]);
    expect(tokens.rows[0]?.n).toBe(1);
  });

  it("rotation deletes the old token row, so the old token gets 401 right away", async () => {
    const created = await post(venture("rotate"));
    const oldToken = String(created.json.token);
    const botId = String((created.json.venture as Record<string, unknown>).botId);
    const rotated = await post({ action: "rotate_token", botId });
    expect(rotated.status).toBe(200);
    const newToken = String(rotated.json.token);
    const rows = await pool.query("select token_hash, scopes from public.bot_tokens where bot_id = $1", [botId]);
    expect(rows.rows).toEqual([{ token_hash: hashBotToken(newToken), scopes: [...LEAD_SCOPES] }]);
    expect(await mcpStatus(oldToken)).toBe(401);
    expect(await mcpStatus(newToken)).toBe(200);
    const events = await pool.query("select result from public.events where target = $1 and action = 'rotate_token'", [botId]);
    expect(events.rows).toHaveLength(1);
    expect(JSON.stringify(events.rows)).not.toContain(newToken);
  });

  it("lists ventures and gives the CEO a roster with status from the database", async () => {
    const created = await post(venture("roster"));
    const token = String(created.json.token);
    const botId = String((created.json.venture as Record<string, unknown>).botId);
    const lead = await store.authenticate(hashBotToken(token));
    const sheet = parseRoleSheet(loadConnectorSheetText());
    const connector = createDefaultConnectorDeps({ store, sheet, cursor: null, cursorConfigured: false });
    await callConnectorTool(connector, lead, "heartbeat", { task: "idle" });

    const list = await handleVenturesHttp(new Request("http://127.0.0.1/api/board?view=ventures", { headers: { cookie: "x" } }), deps());
    const ventures = ((await list.json()) as { ventures: Record<string, unknown>[] }).ventures;
    expect(ventures.find((item) => item.botId === botId)).toMatchObject({ name: `IT ${run} roster`, status: "live" });

    const ceoAuth = await store.authenticate(hashBotToken(ceoToken));
    const context = await callConnectorTool(connector, ceoAuth, "get_context", {});
    const bots = context.structuredContent.bots as Record<string, unknown>[];
    expect(bots.find((bot) => bot.id === botId)).toMatchObject({ kind: "lead", repos: [`it-${run}/roster`], status: "live" });
    expect(JSON.stringify(bots)).not.toContain(hashBotToken(token));

    const leadContext = await callConnectorTool(connector, lead, "get_context", {});
    expect(leadContext.structuredContent).not.toHaveProperty("bots");
  });
});
