import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPgConnectorStore } from "../../hq/connector-pg.ts";
import type { ConnectorStore, PinResolution } from "../../hq/connector-store.ts";
import { resolveDailyPins } from "../../hq/pins.ts";
import { databaseUrl, newPool } from "./db.ts";

let pool: pg.Pool;
let store: ConnectorStore;
const sheetText = readFileSync("gateway/role-sheet.yaml", "utf8");
const IDS = ["grok-4.7", "grok-4.9-fast", "composer-2.5", "claude-opus-5-5", "gpt-5.6-sol"];

function baseline(): PinResolution[] {
  return [
    { family: "grok", version: "grok-4.7", held: false, reason: "baseline" },
    { family: "composer", version: "composer-2.5", held: false, reason: "baseline" },
  ];
}

async function rowCount(owner: string): Promise<number> {
  const found = await pool.query<{ n: string }>("select count(*)::text as n from public.model_resolutions where owner_id = $1", [owner]);
  return Number(found.rows[0]?.n ?? 0);
}

beforeAll(() => {
  pool = newPool();
  store = createPgConnectorStore(databaseUrl());
});

afterAll(async () => {
  await pool.end();
});

describe("model pins in model_resolutions (Postgres)", () => {
  it("reads the latest non-held row per family as the pin", async () => {
    const owner = randomUUID();
    expect(await store.currentPins(owner)).toEqual([]);
    const first = await store.recordPinResolutions({ ownerId: owner, since: "2026-10-08T00:00:00.000Z", at: "2026-10-08T09:00:00.000Z", rows: baseline() });
    expect(first.recorded).toBe(true);
    const held = await store.recordPinResolutions({
      ownerId: owner,
      since: "2026-10-09T00:00:00.000Z",
      at: "2026-10-09T09:00:00.000Z",
      rows: [{ family: "grok", version: "grok-4.8", held: true, reason: "held: pinned grok-4.7" }],
    });
    expect(held.recorded).toBe(true);
    expect(held.approvals).toEqual([expect.objectContaining({ action: "model_upgrade", target: "grok:grok-4.8", status: "pending" })]);
    const pins = await store.currentPins(owner);
    expect(pins).toEqual(expect.arrayContaining([{ family: "grok", version: "grok-4.7" }, { family: "composer", version: "composer-2.5" }]));
    expect(pins).toHaveLength(2);
    const approval = await store.getApproval(held.approvals[0]!.id);
    expect(approval).toMatchObject({ ownerId: owner, action: "model_upgrade", status: "pending", requestId: null });
    expect(await store.pinsResolvedSince(owner, "2026-10-09T00:00:00.000Z")).toBe(true);
    expect(await store.pinsResolvedSince(owner, "2026-10-10T00:00:00.000Z")).toBe(false);
  });

  it("does not raise a second card for the same held version", async () => {
    const owner = randomUUID();
    const row: PinResolution = { family: "grok", version: "grok-4.8", held: true, reason: "held" };
    const a = await store.recordPinResolutions({ ownerId: owner, since: "2026-10-08T00:00:00.000Z", at: "2026-10-08T01:00:00.000Z", rows: [row] });
    const b = await store.recordPinResolutions({ ownerId: owner, since: "2026-10-09T00:00:00.000Z", at: "2026-10-09T01:00:00.000Z", rows: [row] });
    expect(a.approvals).toHaveLength(1);
    expect(b.approvals).toHaveLength(0);
    const found = await pool.query("select id from public.approvals where owner_id = $1", [owner]);
    expect(found.rows).toHaveLength(1);
  });

  it("records once per day under concurrency", async () => {
    const owner = randomUUID();
    const input = { ownerId: owner, since: "2026-10-08T00:00:00.000Z", at: "2026-10-08T09:00:00.000Z", rows: baseline() };
    const results = await Promise.all([1, 2, 3, 4].map(() => store.recordPinResolutions(input)));
    expect(results.filter((item) => item.recorded)).toHaveLength(1);
    expect(await rowCount(owner)).toBe(2);
  });

  it("runs the daily check end to end and skips the second run", async () => {
    const owner = randomUUID();
    let calls = 0;
    const cursor = {
      async listModels() {
        calls += 1;
        return IDS;
      },
    };
    const first = await resolveDailyPins({ store, cursor, sheetText, now: () => "2026-10-08T09:00:00.000Z", ownerIds: [owner] });
    expect(first.owners[0]?.status).toBe("recorded");
    expect(await store.currentPins(owner)).toEqual(
      expect.arrayContaining([
        { family: "grok", version: "grok-4.7" },
        { family: "composer", version: "composer-2.5" },
        { family: "claude-opus", version: "claude-opus-5-5" },
        { family: "gpt-sol", version: "gpt-5.6-sol" },
      ]),
    );
    const second = await resolveDailyPins({ store, cursor, sheetText, now: () => "2026-10-08T20:00:00.000Z", ownerIds: [owner] });
    expect(second.owners[0]?.status).toBe("skipped");
    expect(calls).toBe(1);
    expect(await rowCount(owner)).toBe(4);
  });

  it("records a Cursor failure as an event and one alert post", async () => {
    const owner = randomUUID();
    const cursor = {
      async listModels(): Promise<string[]> {
        throw new Error("fetch failed");
      },
    };
    expect(await store.lastPinFailureAt(owner)).toBeNull();
    const failed = await resolveDailyPins({ store, cursor, sheetText, now: () => new Date().toISOString(), ownerIds: [owner] });
    expect(failed.owners[0]).toMatchObject({ status: "failed", reason: "cursor_unreachable" });
    expect(await store.lastPinFailureAt(owner)).not.toBeNull();
    const posts = await pool.query("select type from public.posts where owner_id = $1", [owner]);
    expect(posts.rows).toEqual([{ type: "alert" }]);
    expect(await rowCount(owner)).toBe(0);
  });
});
