import { beforeAll, describe, expect, it } from "vitest";
import { createMemoryConnectorStore } from "../../hq/connector-store.ts";
import { createMemoryFleetReports, runFleetReportTick } from "../../hq/fleet-report.ts";
import { getFleetView, login, postTick } from "../../hq/server.ts";

const OWNER_EMAIL = "owner@example.com";

beforeAll(() => {
  // Never touch a real database from unit tests.
  process.env.SUPABASE_DB_URL = "";
  process.env.DEXTER_STORE = "memory";
  process.env.DEXTER_CEO = "off";
  process.env.DEXTER_CALLBACK_SECRET = "unit-test-session-secret-0123456789";
  process.env.DEXTER_OWNER_EMAIL = OWNER_EMAIL;
  process.env.DEXTER_TICK_SECRET = "unit-test-tick-secret";
});

async function seeded() {
  const connector = createMemoryConnectorStore();
  await connector.appendEvent({
    ownerId: "o",
    actor: "dexter",
    action: "open_request",
    target: "r1",
    result: { status: "opened", requestId: "r1" },
    at: "2026-10-01T12:00:00.000Z",
  });
  return { connector, db: createMemoryFleetReports(connector) };
}

describe("GET /api/board?view=fleet is owner-only", () => {
  it("refuses no cookie and a forged cookie, and serves the owner", async () => {
    const { db } = await seeded();
    await runFleetReportTick({ db, now: new Date("2026-10-08T09:00:00.000Z") });
    expect((await getFleetView(null, null, db)).status).toBe(401);
    expect((await getFleetView("dexter_session=forged.value", null, db)).status).toBe(401);
    const session = login(OWNER_EMAIL, false);
    if (!session.ok) throw new Error("login failed");
    const cookie = session.cookie.split(";")[0] ?? "";
    const view = await getFleetView(cookie, null, db);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ week: "2026-W40", report: { totals: { requests: { opened: 1 } } } });
  });
});

describe("the per-minute tick writes the weekly report once", () => {
  it("writes on the first due tick, then finds it, and a bad secret writes nothing", async () => {
    const { connector, db } = await seeded();
    const now = new Date("2026-10-08T09:00:00.000Z");
    expect((await postTick("wrong", { fleetReports: db, now })).status).toBe(401);
    expect((await connector.listEvents()).filter((item) => item.action === "fleet_report")).toHaveLength(0);
    const first = await postTick("unit-test-tick-secret", { fleetReports: db, now });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ fleet: { status: "written", week: "2026-W40" } });
    const second = await postTick("unit-test-tick-secret", { fleetReports: db, now });
    expect(second.body).toMatchObject({ fleet: { status: "exists", week: "2026-W40" } });
    expect((await connector.listEvents()).filter((item) => item.action === "fleet_report")).toHaveLength(1);
  });

  it("keeps the tick green when the report fails", async () => {
    const { db } = await seeded();
    const broken = { ...db, async getReport() { throw new Error("db down postgres://user:pw@host/db"); } };
    const result = await postTick("unit-test-tick-secret", { fleetReports: broken, now: new Date("2026-10-08T09:00:00.000Z") });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ fleet: { status: "error" } });
    expect(JSON.stringify(result.body)).not.toContain("postgres://");
  });
});
