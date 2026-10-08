import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { handleChat } from "../../hq/chat.ts";
import { classifyQuestion } from "../../hq/classify.ts";
import { callConnectorTool, createDefaultConnectorDeps, CONNECTOR_TOOLS } from "../../hq/connector.ts";
import { createMemoryConnectorStore, type ConnectorAuth, type ConnectorStore } from "../../hq/connector-store.ts";
import { SHIPPED_CREWS } from "../../hq/crews.ts";
import type { HqDeps } from "../../hq/deps.ts";
import { MemoryStore } from "../../hq/memory.ts";
import { createScriptedCeo } from "../../hq/scripted-ceo.ts";
import { getBoardNotes, login } from "../../hq/server.ts";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OWNER_EMAIL = "owner@example.com";
const NOW = "2026-10-08T09:00:00.000Z";
const ALL = [...CONNECTOR_TOOLS];

function bot(id: string, name: string, kind: string, repos: string[]): ConnectorAuth {
  return { id, ownerId: OWNER, name, kind, repos, tools: ALL, currentTask: null, heartbeatAt: null, scopes: ALL, suspended: false };
}

const leadA = bot("aaaaaaaa-0000-4000-8000-000000000001", "alpha-lead", "lead", ["acme/alpha"]);
const leadB = bot("bbbbbbbb-0000-4000-8000-000000000001", "beta-lead", "lead", ["acme/beta"]);
const ceo = bot("cccccccc-0000-4000-8000-000000000001", "dexter", "ceo", []);

beforeAll(() => {
  // Never touch a real database from unit tests.
  process.env.SUPABASE_DB_URL = "";
  process.env.DEXTER_STORE = "memory";
  process.env.DEXTER_CEO = "off";
  process.env.DEXTER_CALLBACK_SECRET = "unit-test-session-secret-0123456789";
  process.env.DEXTER_OWNER_EMAIL = OWNER_EMAIL;
});

async function seeded(): Promise<{ store: ConnectorStore; ids: Record<string, string> }> {
  const store = createMemoryConnectorStore({ bots: [leadA, leadB, ceo] });
  let clock = NOW;
  const deps = createDefaultConnectorDeps({ store, cursor: null, cursorConfigured: false, checker: null, now: () => clock });
  const post = async (auth: ConnectorAuth, args: Record<string, unknown>) =>
    String((await callConnectorTool(deps, auth, "post", args)).structuredContent.postId);
  clock = "2026-10-01T09:00:00.000Z";
  const expired = await post(leadA, { type: "dead_end", body: "old dead end", conditions: "until v2", expiresInDays: 2 });
  clock = NOW;
  const alpha = await post(leadA, { type: "finding", body: "alpha finding" });
  const beta = await post(leadB, { type: "shortcut", body: "beta shortcut" });
  const shared = await post(leadB, { type: "finding", body: "shared finding", scope: "shared" });
  const dead = await post(leadA, { type: "dead_end", body: "live dead end", conditions: "until v3" });
  await callConnectorTool(deps, ceo, "verify_post", { postId: alpha });
  return { store, ids: { expired, alpha, beta, shared, dead } };
}

function ownerCookie(): string {
  const session = login(OWNER_EMAIL, false);
  if (!session.ok) throw new Error("login failed");
  return session.cookie.split(";")[0] ?? "";
}

function noteIds(body: unknown): string[] {
  return ((body as { notes: { id: string }[] }).notes ?? []).map((note) => note.id);
}

describe("GET /api/board?view=notes is owner-only JSON", () => {
  it("refuses no cookie and a forged cookie", async () => {
    const { store } = await seeded();
    expect((await getBoardNotes(null, "view=notes", store, NOW)).status).toBe(401);
    expect((await getBoardNotes("dexter_session=forged.value", "view=notes", store, NOW)).status).toBe(401);
  });

  it("serves every scope to the owner, live notes by default, newest first", async () => {
    const { store, ids } = await seeded();
    const view = await getBoardNotes(ownerCookie(), "view=notes", store, NOW);
    expect(view.status).toBe(200);
    expect(noteIds(view.body).sort()).toEqual([ids.alpha, ids.beta, ids.shared, ids.dead].sort());
    const alpha = (view.body as { notes: Record<string, unknown>[] }).notes.find((note) => note.id === ids.alpha);
    expect(alpha).toMatchObject({ type: "finding", status: "verified", verifiedBy: "dexter", by: "alpha-lead", repo: "acme/alpha", scope: "project" });
  });

  it("filters by type, scope, repo and status", async () => {
    const { store, ids } = await seeded();
    const cookie = ownerCookie();
    const get = async (query: string) => noteIds((await getBoardNotes(cookie, `view=notes&${query}`, store, NOW)).body);
    expect(await get("type=shortcut")).toEqual([ids.beta]);
    expect(await get("scope=shared")).toEqual([ids.shared]);
    expect((await get("repo=acme/alpha")).sort()).toEqual([ids.alpha, ids.dead].sort());
    expect(await get("status=verified")).toEqual([ids.alpha]);
    expect((await get("status=claimed")).sort()).toEqual([ids.beta, ids.shared].sort());
    expect(await get("status=expired")).toEqual([ids.expired]);
    expect((await get("status=all")).length).toBe(5);
    const bad = await getBoardNotes(cookie, "view=notes&type=rumor", store, NOW);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ reason: "invalid_filter" });
  });
});

describe("HQ chat reads the board", () => {
  const sheet = parseRoleSheet(readFileSync("gateway/role-sheet.yaml", "utf8"));

  function deps(extra?: Partial<HqDeps>): HqDeps {
    return {
      ceo: createScriptedCeo(sheet),
      ceoEnabled: true,
      sheet,
      catalog: [],
      shippedCrews: SHIPPED_CREWS,
      exhaustedPools: [],
      knownHosts: ["example.com"],
      slotCap: 3,
      runtimes: {},
      controlReachable: true,
      ...extra,
    };
  }

  it("classifies board asks before list asks", () => {
    for (const text of ["board", "Board", "show the board", "what's on the board?", "board findings", "findings", "dead ends", "show dead ends", "shortcuts"]) {
      expect(classifyQuestion(text)).toBe("board");
    }
    expect(classifyQuestion("show requests")).toBe("list");
    expect(classifyQuestion("Fix the board layout bug in the repo")).toBe("work");
  });

  it("answers from the connector posts with no model call and marks claimed notes", async () => {
    const { store } = await seeded();
    const wired = deps({ connector: store });
    const memory = new MemoryStore(() => new Date(NOW));
    const result = await handleChat(memory, wired, "board");
    expect(result.modelCalls).toBe(0);
    expect(wired.ceo.calls).toBe(0);
    expect(result.kind).toBe("list");
    const lines = result.text.split("\n");
    expect(lines[0]).toMatch(/^Board: 4 notes, 1 verified\./);
    expect(result.text).toContain("verified finding");
    expect(result.text).toContain("claimed shortcut");
    expect(result.text).toContain("dead end");
    expect(result.text).not.toContain("old dead end");
    const dead = await handleChat(new MemoryStore(() => new Date(NOW)), wired, "dead ends");
    expect(dead.text.split("\n")[0]).toMatch(/^Board: 1 note/);
    expect(dead.text).toContain("until v3");
    expect((await memory.listMessages()).map((item) => item.role)).toEqual(["owner", "dexter"]);
  });

  it("says so when the board is empty or unreachable", async () => {
    const empty = await handleChat(new MemoryStore(), deps({ connector: createMemoryConnectorStore() }), "board");
    expect(empty.text).toContain("No board notes");
    expect(empty.modelCalls).toBe(0);
    const none = await handleChat(new MemoryStore(), deps(), "board");
    expect(none.text).toContain("Board unavailable");
  });
});
