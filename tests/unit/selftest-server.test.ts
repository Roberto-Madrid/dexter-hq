import { beforeAll, describe, expect, it } from "vitest";
import { issueSession } from "../../hq/session.ts";
import { getSelftestView, getTickHealth, postChat, postTick } from "../../hq/server.ts";
import type { SelftestDb } from "../../hq/selftest.ts";

const SECRET = "unit-watchdog-secret";
const TICK = "unit-tick-secret";

const healthyDb: SelftestDb = {
  async ping() {},
  async controlRows() {
    return [false];
  },
  async tokenSuspension() {
    return { total: 1, suspended: 0 };
  },
  async tickStats() {
    return { lastBeatAt: new Date(Date.now() - 30_000).toISOString(), maxGapSeconds: 60 };
  },
  async hasRun() {
    return false;
  },
  async latest() {
    return { day: "2026-10-08", at: new Date().toISOString(), ok: true, failed: [], checks: [] };
  },
  async recordOnce() {
    return true;
  },
};

beforeAll(() => {
  delete process.env.SUPABASE_DB_URL;
  delete process.env.DATABASE_URL;
  process.env.DEXTER_STORE = "memory";
  process.env.DEXTER_CEO = "scripted";
  process.env.DEXTER_CALLBACK_SECRET = "unit-session-secret";
  process.env.DEXTER_OWNER_EMAIL = "owner@example.com";
  process.env.DEXTER_TICK_SECRET = TICK;
  process.env.DEXTER_WATCHDOG_SECRET = SECRET;
});

describe("watchdog health endpoint (GET /api/tick-now)", () => {
  it("refuses a missing or wrong secret, and the tick secret", async () => {
    expect((await getTickHealth(null, healthyDb)).status).toBe(401);
    expect((await getTickHealth("wrong", healthyDb)).status).toBe(401);
    expect((await getTickHealth(TICK, healthyDb)).status).toBe(401);
    const refused = await getTickHealth("wrong", healthyDb);
    expect(refused.body).toBeUndefined();
  });

  it("fails closed when the secret is not configured", async () => {
    const saved = process.env.DEXTER_WATCHDOG_SECRET;
    delete process.env.DEXTER_WATCHDOG_SECRET;
    try {
      expect((await getTickHealth("", healthyDb)).status).toBe(401);
      expect((await getTickHealth(SECRET, healthyDb)).status).toBe(401);
    } finally {
      process.env.DEXTER_WATCHDOG_SECRET = saved;
    }
  });

  it("returns only health fields with the right secret", async () => {
    const result = await getTickHealth(SECRET, healthyDb);
    expect(result.status).toBe(200);
    expect(Object.keys(result.body ?? {}).sort()).toEqual(["ok", "reasons", "selfTestAgeHours", "selfTestDay", "selfTestOk", "tickAgeSeconds"]);
    expect(result.body).toMatchObject({ ok: true, selfTestOk: true });
  });

  it("answers 503 not_configured with the right secret but no database", async () => {
    expect(await getTickHealth(SECRET, undefined)).toEqual({ status: 503, body: { ok: false, reasons: ["not_configured"] } });
  });
});

describe("owner self-test view (GET /api/board?view=selftest)", () => {
  it("is owner-only", async () => {
    expect((await getSelftestView(null, healthyDb)).status).toBe(401);
    const cookie = `dexter_session=${issueSession("owner@example.com", "unit-session-secret", Date.now() + 60_000)}`;
    const view = await getSelftestView(cookie, healthyDb);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ latest: { day: "2026-10-08", ok: true }, stale: false });
  });
});

describe("tick and chat hooks", () => {
  it("the tick reports the self-test as not configured without a database and still answers 200", async () => {
    const result = await postTick(TICK);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, selftest: { status: "not_configured" } });
  });

  it("chat answers a self-test question without a model call", async () => {
    const result = await postChat("self test");
    expect(result.modelCalls).toBe(0);
    expect(result.card).toBeNull();
    expect(result.text).toContain("not configured");
  });
});
