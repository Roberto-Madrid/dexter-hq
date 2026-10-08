import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { decideApproval } from "../../hq/approval.ts";
import { createPgConnectorStore } from "../../hq/connector-pg.ts";
import type { ConnectorStore } from "../../hq/connector-store.ts";
import { SURGE_TTL_MS, surgeActive, surgeExpiresAt } from "../../hq/surge.ts";
import { databaseUrl, newPool } from "./db.ts";

let pool: pg.Pool;
let store: ConnectorStore;
const owner = randomUUID();

beforeAll(() => {
  pool = newPool();
  store = createPgConnectorStore(databaseUrl());
});

afterAll(async () => {
  await pool.query("delete from public.approvals where owner_id = $1", [owner]);
  await pool.end();
});

describe("surge TTL (Postgres)", () => {
  it("stamps the decision time on claim, so the surge expires 24h after approval", async () => {
    const id = randomUUID();
    await store.saveApproval({ id, ownerId: owner, action: "surge", target: "agents", status: "pending", requestId: null });
    expect((await store.getApproval(id))?.decidedAt ?? null).toBeNull();
    const decidedAt = "2026-10-08T12:00:00.000Z";
    const result = await decideApproval(store, { approvalId: id, decision: "approved", now: () => decidedAt });
    expect(result).toMatchObject({ status: "approved", expiresAt: "2026-10-09T12:00:00.000Z" });
    const approval = await store.getApproval(id);
    expect(approval).toMatchObject({ status: "approved", action: "surge", decidedAt });
    expect(surgeExpiresAt(approval!)).toBe(new Date(Date.parse(decidedAt) + SURGE_TTL_MS).toISOString());
    expect(surgeActive(approval!, "2026-10-09T11:59:59.000Z")).toBe(true);
    expect(surgeActive(approval!, "2026-10-09T12:00:00.000Z")).toBe(false);
    const again = await store.claimApproval(id, "denied", "2026-10-10T00:00:00.000Z");
    expect(again.claimed).toBe(false);
    expect(again.row?.decidedAt).toBe(decidedAt);
  });
});
