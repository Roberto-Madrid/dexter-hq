import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCursorCloud } from "../../adapters/cursor-cloud.ts";
import { callConnectorTool, createMemoryConnectorStore } from "../../hq/connector.ts";
import type { ConnectorAuth } from "../../hq/connector-store.ts";
import { PIN_FAILURE_RETRY_MS, resolveDailyPins } from "../../hq/pins.ts";
import { capsAuth, capsDeps, fakeCursor, launch, OWNER, type FakeCursor } from "./caps-fixtures.ts";
import { CATALOG_IDS, PINS } from "./pin-fixtures.ts";

const sheetText = readFileSync("gateway/role-sheet.yaml", "utf8");
const DAY1 = "2026-10-08T09:00:00.000Z";
const DAY1_LATER = "2026-10-08T23:59:00.000Z";
const DAY2 = "2026-10-09T00:05:00.000Z";
const DAY3 = "2026-10-10T00:05:00.000Z";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recordingFetch(reply: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return reply();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function sentBody(call: { init?: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

const scout: ConnectorAuth = { ...capsAuth, id: "33333333-3333-4333-8333-333333333333", name: "unit-scout", kind: "scout", repos: [] };
const bareLead: ConnectorAuth = { ...capsAuth, id: "44444444-4444-4444-8444-444444444444", name: "bare-lead", repos: [] };

function emptyStore() {
  return createMemoryConnectorStore({ bots: [capsAuth] });
}

function resolve(store: ReturnType<typeof createMemoryConnectorStore>, cursor: FakeCursor | null, at: string) {
  return resolveDailyPins({ store, cursor, sheetText, now: () => at });
}

async function rowsFor(store: ReturnType<typeof createMemoryConnectorStore>) {
  return store.listModelResolutions(OWNER);
}

describe("cursor-cloud start() carries repo and model", () => {
  it("sends repos[{url,startingRef}] and model.id", async () => {
    const { calls, fetchImpl } = recordingFetch(() => json(200, { agent: { id: "bc-1", latestRunId: "run-1" } }));
    const cloud = createCursorCloud({ apiKey: "test", fetchImpl });
    await cloud.start({
      idempotencyKey: "k1",
      taskId: "k1",
      brief: "Fix the footer.",
      repo: "owner/a",
      startingRef: "feature/footer",
      modelId: "grok-4.7",
    });
    const body = sentBody(calls[0]!);
    expect(body.repos).toEqual([{ url: "https://github.com/owner/a", startingRef: "feature/footer" }]);
    expect(body.model).toEqual({ id: "grok-4.7" });
    expect(body.prompt).toEqual({ text: "Fix the footer." });
  });

  it("omits startingRef without a branch, and repos for a no-repo launch", async () => {
    const { calls, fetchImpl } = recordingFetch(() => json(200, { agent: { id: "bc-1", latestRunId: "run-1" } }));
    const cloud = createCursorCloud({ apiKey: "test", fetchImpl });
    await cloud.start({ idempotencyKey: "k1", taskId: "k1", brief: "x", repo: "owner/a", modelId: "grok-4.7" });
    await cloud.start({ idempotencyKey: "k2", taskId: "k2", brief: "y", repo: null, modelId: "grok-4.7" });
    expect(sentBody(calls[0]!).repos).toEqual([{ url: "https://github.com/owner/a" }]);
    expect("repos" in sentBody(calls[1]!)).toBe(false);
    expect(sentBody(calls[1]!).model).toEqual({ id: "grok-4.7" });
  });

  it("lists model ids from GET /v1/models and throws when Cursor refuses", async () => {
    const ok = recordingFetch(() => json(200, { items: [{ id: "grok-4.7", displayName: "Grok" }, { id: "composer-2.5" }] }));
    expect(await createCursorCloud({ apiKey: "test", fetchImpl: ok.fetchImpl }).listModels()).toEqual(["grok-4.7", "composer-2.5"]);
    expect(ok.calls[0]!.url).toBe("https://api.cursor.com/v1/models");
    const down = recordingFetch(() => json(503, { error: "unavailable" }));
    await expect(createCursorCloud({ apiKey: "test", fetchImpl: down.fetchImpl }).listModels()).rejects.toThrow("models_failed_503");
  });
});

describe("launch_agent resolves repo and the pinned model", () => {
  it("builder gets the grok pin and the request's repo", async () => {
    const { deps, cursor } = await capsDeps();
    const result = await launch(deps, "pin-builder", "owner/a", "req-0-0");
    expect(result.structuredContent.status).toBe("launched");
    expect(cursor.starts[0]).toMatchObject({ repo: "owner/a", modelId: "grok-4.7" });
    expect(result.structuredContent.model).toBe("grok-4.7");
  });

  it("quick_edit gets the composer pin", async () => {
    const { deps, cursor } = await capsDeps();
    await launch(deps, "pin-quick", "owner/a", "req-0-0", { role: "quick_edit" });
    expect(cursor.starts[0]).toMatchObject({ repo: "owner/a", modelId: "composer-2.5" });
  });

  it("refuses model_held when the family has no pin, and reserves nothing", async () => {
    const { deps, cursor, store } = await capsDeps({ pins: false });
    const result = await launch(deps, "no-pin", "owner/a", "req-0-0");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "refused", reason: "model_held" });
    expect(cursor.starts).toHaveLength(0);
    expect(await store.listAgents()).toHaveLength(0);
  });

  it("keeps launching on the old pin while a newer version is held", async () => {
    const { deps, cursor } = await capsDeps();
    cursor.models = CATALOG_IDS.map((id) => (id === "grok-4.7" ? "grok-4.8" : id));
    const resolved = await resolveDailyPins({ store: deps.store, cursor, sheetText, now: () => DAY1 });
    expect(resolved.owners[0]?.held).toEqual([{ family: "grok", current: "grok-4.7", incoming: "grok-4.8", action: "hold" }]);
    await launch(deps, "held-still-old", "owner/a", "req-0-0");
    expect(cursor.starts[0]?.modelId).toBe("grok-4.7");
  });

  it("takes the repo from the request and the request's bound branch as startingRef", async () => {
    const { deps, cursor, store } = await capsDeps();
    const request = await store.getRequest("req-1-0");
    await store.saveRequest({ ...request!, branch: "feature/bound" });
    const result = await callConnectorTool(deps, capsAuth, "launch_agent", {
      role: "builder",
      brief: "Change one label in the footer.",
      idempotencyKey: "from-request",
      requestId: "req-1-0",
    });
    expect(result.structuredContent.status).toBe("launched");
    expect(cursor.starts[0]).toMatchObject({ repo: "owner/b", startingRef: "feature/bound", modelId: "grok-4.7" });
    expect((await store.listAgents())[0]?.repo).toBe("owner/b");
  });

  it("refuses repo_mismatch when the call names a different repo than the request", async () => {
    const { deps, cursor } = await capsDeps();
    const result = await launch(deps, "mismatch", "owner/a", "req-1-0");
    expect(result.structuredContent).toMatchObject({ status: "refused", reason: "repo_mismatch" });
    expect(cursor.starts).toHaveLength(0);
  });

  it("fails closed for repo work without a repo, even for a bot with no repos", async () => {
    const { deps, cursor } = await capsDeps({ bots: [bareLead] });
    const result = await callConnectorTool(deps, bareLead, "launch_agent", {
      role: "builder",
      brief: "Change one label in the footer.",
      idempotencyKey: "bare",
    });
    expect(result.structuredContent).toMatchObject({ status: "refused", reason: "repo_required" });
    expect(cursor.starts).toHaveLength(0);
  });

  it("lets a scout launch without a repo, still on a pinned model", async () => {
    const { deps, cursor, store } = await capsDeps({ bots: [scout] });
    await store.saveRequest({
      id: "req-scout",
      ownerId: OWNER,
      goal: "Research pricing pages.",
      status: "queued",
      card: { crew: "research", newScreen: false, requiresDesignApproval: false },
      evidence: [],
      assignedBotId: scout.id,
      repo: null,
      notices: [],
    });
    const result = await callConnectorTool(deps, scout, "launch_agent", {
      role: "researcher",
      brief: "Read the public docs and summarize the pricing page.",
      idempotencyKey: "scout-1",
      requestId: "req-scout",
    });
    expect(result.structuredContent.status).toBe("launched");
    expect(cursor.starts[0]?.repo ?? null).toBeNull();
    expect(cursor.starts[0]?.modelId).toBe("grok-4.7");
  });
});

describe("daily version check", () => {
  it("adopts the first pins as the baseline, ignoring fast/max/preview", async () => {
    const store = emptyStore();
    const cursor = fakeCursor();
    const result = await resolve(store, cursor, DAY1);
    expect(result.owners).toEqual([expect.objectContaining({ ownerId: OWNER, status: "recorded", held: [] })]);
    expect(await store.currentPins(OWNER)).toEqual(expect.arrayContaining(PINS));
    expect(await store.currentPins(OWNER)).toHaveLength(PINS.length);
    const rows = await rowsFor(store);
    expect(rows.map((row) => row.reason)).toEqual(PINS.map(() => "baseline"));
    expect(rows.some((row) => /fast|max|preview/.test(row.version))).toBe(false);
    expect(await store.listApprovals()).toEqual([]);
  });

  it("writes nothing on a second run the same day and does not call Cursor again", async () => {
    const store = emptyStore();
    const cursor = fakeCursor();
    await resolve(store, cursor, DAY1);
    const before = await rowsFor(store);
    const again = await resolve(store, cursor, DAY1_LATER);
    expect(again.owners[0]?.status).toBe("skipped");
    expect(cursor.modelCalls).toBe(1);
    expect(await rowsFor(store)).toEqual(before);
  });

  it("only one of two simultaneous runs records", async () => {
    const store = emptyStore();
    const cursor = fakeCursor();
    const results = await Promise.all([resolve(store, cursor, DAY1), resolve(store, cursor, DAY1)]);
    expect(results.filter((item) => item.owners[0]?.status === "recorded")).toHaveLength(1);
    expect(await rowsFor(store)).toHaveLength(PINS.length);
  });

  it("same version the next day is a no-op for the pins", async () => {
    const store = emptyStore();
    const cursor = fakeCursor();
    await resolve(store, cursor, DAY1);
    const result = await resolve(store, cursor, DAY2);
    expect(result.owners[0]).toMatchObject({ status: "recorded", held: [] });
    expect(await store.currentPins(OWNER)).toEqual(expect.arrayContaining(PINS));
    expect((await rowsFor(store)).filter((row) => row.reason === "confirmed")).toHaveLength(PINS.length);
    expect(await store.listApprovals()).toEqual([]);
  });

  it("holds a new version: held row + one pending approval, current pin unchanged, no repeat card", async () => {
    const store = emptyStore();
    const cursor = fakeCursor();
    await resolve(store, cursor, DAY1);
    cursor.models = [...CATALOG_IDS, "grok-4.8"];
    const result = await resolve(store, cursor, DAY2);
    expect(result.owners[0]?.held).toEqual([{ family: "grok", current: "grok-4.7", incoming: "grok-4.8", action: "hold" }]);
    expect((await store.currentPins(OWNER)).find((pin) => pin.family === "grok")?.version).toBe("grok-4.7");
    const held = (await rowsFor(store)).filter((row) => row.held);
    expect(held).toEqual([expect.objectContaining({ family: "grok", version: "grok-4.8", held: true })]);
    const approvals = await store.listApprovals();
    expect(approvals).toEqual([
      expect.objectContaining({ ownerId: OWNER, action: "model_upgrade", target: "grok:grok-4.8", status: "pending", requestId: null }),
    ]);
    await resolve(store, cursor, DAY3);
    expect(await store.listApprovals()).toHaveLength(1);
    expect((await store.currentPins(OWNER)).find((pin) => pin.family === "grok")?.version).toBe("grok-4.7");
  });

  it("keeps the pins and posts one alert when Cursor is unreachable, retrying at most hourly", async () => {
    const store = emptyStore();
    const cursor = fakeCursor();
    await resolve(store, cursor, DAY1);
    const before = await rowsFor(store);
    cursor.models = new Error("fetch failed");
    const failed = await resolve(store, cursor, DAY2);
    expect(failed.owners[0]).toMatchObject({ status: "failed", reason: "cursor_unreachable" });
    expect(await rowsFor(store)).toEqual(before);
    expect(await store.currentPins(OWNER)).toEqual(expect.arrayContaining(PINS));
    const alerts = (await store.listPosts()).filter((post) => post.type === "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toMatch(/model check/i);
    expect((await store.listEvents()).filter((event) => event.action === "pins_resolve_failed")).toHaveLength(1);

    const soon = new Date(Date.parse(DAY2) + 60_000).toISOString();
    const backoff = await resolve(store, cursor, soon);
    expect(backoff.owners[0]?.status).toBe("backoff");
    expect(cursor.modelCalls).toBe(2);

    const later = new Date(Date.parse(DAY2) + PIN_FAILURE_RETRY_MS + 1).toISOString();
    const retry = await resolve(store, cursor, later);
    expect(retry.owners[0]?.status).toBe("failed");
    expect(cursor.modelCalls).toBe(3);
    expect((await store.listPosts()).filter((post) => post.type === "alert")).toHaveLength(1);

    cursor.models = [...CATALOG_IDS];
    const recovered = await resolve(store, cursor, new Date(Date.parse(later) + PIN_FAILURE_RETRY_MS + 1).toISOString());
    expect(recovered.owners[0]?.status).toBe("recorded");
  });

  it("does nothing without a Cursor key", async () => {
    const store = emptyStore();
    const result = await resolve(store, null, DAY1);
    expect(result).toMatchObject({ configured: false, owners: [] });
    expect(await rowsFor(store)).toEqual([]);
  });

  it("runs from the tick next to reconcile", async () => {
    const { deps, cursor } = await capsDeps({ pins: false });
    const { connectorTick } = await import("../../hq/pins.ts");
    const first = await connectorTick({ ...deps, now: () => DAY1 }, sheetText);
    expect(first.reconcile.configured).toBe(true);
    expect(first.pins.owners[0]?.status).toBe("recorded");
    const second = await connectorTick({ ...deps, now: () => DAY1_LATER }, sheetText);
    expect(second.pins.owners[0]?.status).toBe("skipped");
    expect(cursor.modelCalls).toBe(1);
  });
});

describe("tick order: reconcile, then fleet report, then pins, each failing soft", () => {
  it("runs the three steps in order", async () => {
    const { deps } = await capsDeps({ pins: false });
    const { connectorTick } = await import("../../hq/pins.ts");
    const order: string[] = [];
    const store = deps.store;
    const traced = {
      ...store,
      async listAgents() {
        order.push("reconcile");
        return store.listAgents();
      },
      async pinsResolvedSince(ownerId: string, since: string) {
        order.push("pins");
        return store.pinsResolvedSince(ownerId, since);
      },
    };
    const result = await connectorTick({ ...deps, store: traced, now: () => DAY1 }, sheetText, {
      fleet: async () => {
        order.push("fleet");
        return { status: "written" };
      },
    });
    expect(order).toEqual(["reconcile", "fleet", "pins"]);
    expect(result.fleet).toEqual({ status: "written" });
    expect(result.pins.owners[0]?.status).toBe("recorded");
  });

  it("keeps going when reconcile and the fleet report throw", async () => {
    const { deps, store } = await capsDeps({ pins: false });
    const { connectorTick } = await import("../../hq/pins.ts");
    const broken = {
      ...store,
      async listAgents(): Promise<never> {
        throw new Error("db down postgres://user:pw@host/db");
      },
    };
    const result = await connectorTick({ ...deps, store: broken, now: () => DAY1 }, sheetText, {
      fleet: async () => {
        throw new Error("fleet down");
      },
    });
    expect(result.reconcile).toEqual({ error: "reconcile_failed" });
    expect(result.fleet).toEqual({ status: "error" });
    expect(result.pins.owners[0]?.status).toBe("recorded");
    expect(JSON.stringify(result)).not.toContain("postgres://");
  });

  it("keeps the tick result when the pins check throws", async () => {
    const { deps, store } = await capsDeps({ pins: false });
    const { connectorTick } = await import("../../hq/pins.ts");
    const broken = {
      ...store,
      async listBots(): Promise<never> {
        throw new Error("db down");
      },
    };
    const result = await connectorTick({ ...deps, store: broken, now: () => DAY1 }, sheetText);
    expect(result.reconcile).toMatchObject({ configured: true });
    expect(result.pins).toMatchObject({ error: "pins_check_failed" });
  });
});
