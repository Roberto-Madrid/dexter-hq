import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCatalogMatch } from "../../gateway/catalog.ts";
import {
  MODEL_UPGRADE_ACTION,
  createMemoryConnectorStore,
  type ConnectorAgent,
  type ConnectorBot,
  type ConnectorStore,
} from "../../hq/connector-store.ts";
import {
  SELFTEST_CHECKS,
  isSelftestQuestion,
  runDailySelftest,
  selftestChatAnswer,
  selftestHealth,
  type SelftestDb,
  type SelftestRecord,
} from "../../hq/selftest.ts";

const SHEET = readFileSync("gateway/role-sheet.yaml", "utf8");
// 2026-10-08 07:30 PDT
const MORNING = new Date("2026-10-08T14:30:00.000Z");
const ENV = { GH_HQ_TOKEN: "ghp_unit_checker_secret_value_123456", GH_WORKERS_REPO: "owner/workers" };

type Fake = SelftestDb & {
  records: SelftestRecord[];
  alerts: { day: string; failed: string[] }[];
  control: boolean[];
  tokens: { total: number; suspended: number };
  beats: string[];
  pingError: Error | null;
};

function fakeDb(overrides: Partial<Pick<Fake, "control" | "tokens" | "beats" | "pingError">> = {}, now = MORNING): Fake {
  // Healthy default: a beat every minute for the last 24h.
  const beats: string[] = [];
  for (let minute = 24 * 60; minute >= 0; minute -= 1) beats.push(new Date(now.getTime() - minute * 60_000).toISOString());
  const db: Fake = {
    records: [],
    alerts: [],
    control: [false],
    tokens: { total: 3, suspended: 0 },
    beats,
    pingError: null,
    ...overrides,
    async ping() {
      if (db.pingError) throw db.pingError;
    },
    async controlRows() {
      return [...db.control];
    },
    async tokenSuspension() {
      return { ...db.tokens };
    },
    async tickStats(since) {
      const window = db.beats.filter((beat) => beat > since).sort();
      let maxGapSeconds: number | null = null;
      let previous = since;
      for (const beat of window) {
        const gap = (Date.parse(beat) - Date.parse(previous)) / 1000;
        maxGapSeconds = maxGapSeconds === null ? gap : Math.max(maxGapSeconds, gap);
        previous = beat;
      }
      return { lastBeatAt: [...db.beats].sort().at(-1) ?? null, maxGapSeconds };
    },
    async hasRun(day) {
      return db.records.some((record) => record.day === day);
    },
    async latest() {
      return db.records.at(-1) ?? null;
    },
    async recordOnce(record) {
      if (db.records.some((item) => item.day === record.day)) return false;
      db.records.push(record);
      if (!record.ok) db.alerts.push({ day: record.day, failed: record.failed });
      return true;
    },
  };
  return db;
}

function agent(id: string, status: string, repo: string, ageMinutes: number, now = MORNING): ConnectorAgent {
  return {
    id,
    ownerId: "o",
    botId: "b",
    cursorHandle: null,
    repo,
    role: "builder",
    family: "f",
    status,
    idempotencyKey: id,
    result: null,
    createdAt: new Date(now.getTime() - ageMinutes * 60_000).toISOString(),
  };
}

const OWNER = "o";
const LEAD: ConnectorBot = {
  id: "b",
  ownerId: OWNER,
  name: "lead",
  kind: "lead",
  repos: ["owner/a"],
  tools: [],
  currentTask: null,
  heartbeatAt: null,
};
/** Every family the role sheet's catalog_match pins, as the daily check would have recorded them. */
const FAMILIES = [...new Set(readCatalogMatch(SHEET).map((row) => row.family))];
const PINS = FAMILIES.map((family) => ({
  ownerId: OWNER,
  family,
  version: `${family}-1`,
  held: false,
  reason: "baseline",
  resolvedAt: "2026-10-07T00:00:00.000Z",
}));

async function connectorWith(
  agents: ConnectorAgent[],
  stopped = false,
  seed: { bots?: ConnectorBot[]; modelResolutions?: typeof PINS } = {},
): Promise<ConnectorStore> {
  const store = createMemoryConnectorStore({
    stopped,
    bots: seed.bots ?? [LEAD],
    modelResolutions: seed.modelResolutions ?? PINS,
  });
  for (const row of agents) await store.saveAgent(row);
  return store;
}

async function run(db: Fake, options: { connector?: ConnectorStore; env?: Record<string, string | undefined>; now?: Date; sheetText?: string } = {}) {
  return runDailySelftest({
    db,
    connector: options.connector ?? (await connectorWith([])),
    env: options.env ?? ENV,
    now: options.now ?? MORNING,
    sheetText: options.sheetText ?? SHEET,
  });
}

function check(record: SelftestRecord | undefined, name: string) {
  const found = record?.checks.find((item) => item.name === name);
  if (!found) throw new Error(`missing check ${name}`);
  return found;
}

describe("daily self-test: schedule and idempotency", () => {
  it("does nothing before 07:00 PT", async () => {
    const db = fakeDb();
    const early = await run(db, { now: new Date("2026-10-08T13:59:00.000Z") });
    expect(early).toMatchObject({ status: "not_due", day: "2026-10-08" });
    expect(db.records).toHaveLength(0);
  });

  it("runs once per PT day and again the next day", async () => {
    const db = fakeDb();
    expect(await run(db)).toMatchObject({ status: "ran", day: "2026-10-08", ok: true, failed: [] });
    expect(await run(db, { now: new Date(MORNING.getTime() + 60_000) })).toMatchObject({ status: "already_ran", day: "2026-10-08" });
    // 23:59 PDT is still the same PT day even though UTC has rolled over.
    expect(await run(db, { now: new Date("2026-10-09T06:59:00.000Z") })).toMatchObject({ status: "already_ran", day: "2026-10-08" });
    const next = new Date("2026-10-09T14:05:00.000Z");
    expect(await run(fakeDbWithRecords(db, next), { now: next })).toMatchObject({ status: "ran", day: "2026-10-09" });
  });

  it("writes one record when two ticks race", async () => {
    const db = fakeDb();
    const results = await Promise.all([run(db), run(db), run(db)]);
    expect(db.records).toHaveLength(1);
    expect(results.filter((item) => item.status === "ran")).toHaveLength(1);
  });

  it("checks every invariant and passes on a healthy fleet", async () => {
    const db = fakeDb();
    await run(db, { connector: await connectorWith([agent("a1", "launched", "owner/a", 30), agent("a2", "reserving", "owner/b", 2)]) });
    const record = db.records[0];
    expect(record?.checks.map((item) => item.name)).toEqual([...SELFTEST_CHECKS]);
    expect(record?.checks.filter((item) => !item.ok)).toEqual([]);
    expect(record?.ok).toBe(true);
    expect(db.alerts).toEqual([]);
  });

  it("has no side effects on agents and never calls a runtime", async () => {
    const rows = [agent("a1", "launched", "owner/a", 30), agent("a2", "reserving", "owner/a", 40)];
    const connector = await connectorWith(rows);
    const before = JSON.stringify(await connector.listAgents());
    await run(fakeDb(), { connector });
    expect(JSON.stringify(await connector.listAgents())).toBe(before);
    expect(await connector.stopped()).toBe(false);
  });
});

function fakeDbWithRecords(previous: Fake, now: Date): Fake {
  const db = fakeDb({}, now);
  db.records.push(...previous.records);
  return db;
}

describe("daily self-test: each check fails on its fixture", () => {
  it("database: reports an error code and never the driver message", async () => {
    const error = Object.assign(new Error("connect ECONNREFUSED postgresql://user:hunter2@db.example:5432/postgres"), { code: "ECONNREFUSED" });
    const db = fakeDb({ pingError: error });
    await run(db);
    const failed = check(db.records[0], "database");
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("ECONNREFUSED");
    expect(JSON.stringify(db.records)).not.toContain("hunter2");
    expect(db.alerts[0]?.failed).toContain("database");
  });

  it("stop_state: flags more than one control row", async () => {
    const db = fakeDb({ control: [false, true] });
    await run(db);
    expect(check(db.records[0], "stop_state")).toMatchObject({ ok: false });
    expect(check(db.records[0], "stop_state").detail).toContain("2 control rows");
  });

  it("stop_state: flags active tokens while STOP ALL is on, and suspended tokens while it is off", async () => {
    const on = fakeDb({ control: [true], tokens: { total: 4, suspended: 3 } });
    await run(on, { connector: await connectorWith([], true) });
    expect(check(on.records[0], "stop_state")).toMatchObject({ ok: false });
    expect(check(on.records[0], "stop_state").detail).toContain("1 token");

    const off = fakeDb({ control: [false], tokens: { total: 4, suspended: 2 } });
    await run(off);
    expect(check(off.records[0], "stop_state")).toMatchObject({ ok: false });

    const stopped = fakeDb({ control: [true], tokens: { total: 4, suspended: 4 } });
    await run(stopped, { connector: await connectorWith([], true) });
    expect(check(stopped.records[0], "stop_state")).toMatchObject({ ok: true });
    expect(check(stopped.records[0], "connector_whoami")).toMatchObject({ ok: true });

    const none = fakeDb({ control: [] });
    await run(none);
    expect(check(none.records[0], "stop_state")).toMatchObject({ ok: true });
  });

  it("caps: flags more active agents than the surge cap, or more than 2 on one repo", async () => {
    const many = Array.from({ length: 7 }, (_, index) => agent(`g${index}`, "launched", `owner/r${index}`, 10));
    const global = fakeDb();
    await run(global, { connector: await connectorWith(many) });
    expect(check(global.records[0], "caps")).toMatchObject({ ok: false });

    const repo = fakeDb();
    await run(repo, {
      connector: await connectorWith([agent("r1", "launched", "owner/a", 5), agent("r2", "RUNNING", "owner/a", 5), agent("r3", "launched", "owner/a", 5)]),
    });
    expect(check(repo.records[0], "caps")).toMatchObject({ ok: false });
    expect(check(repo.records[0], "caps").detail).toContain("owner/a");

    const finished = fakeDb();
    await run(finished, { connector: await connectorWith([agent("f1", "finished", "owner/a", 5), agent("f2", "cancelled", "owner/a", 5), agent("f3", "launched", "owner/a", 5)]) });
    expect(check(finished.records[0], "caps")).toMatchObject({ ok: true });
  });

  it("stuck_reserving: flags a reserving row older than 15 minutes only", async () => {
    const stuck = fakeDb();
    await run(stuck, { connector: await connectorWith([agent("s1", "reserving", "owner/a", 16)]) });
    expect(check(stuck.records[0], "stuck_reserving")).toMatchObject({ ok: false });
    const fresh = fakeDb();
    await run(fresh, { connector: await connectorWith([agent("s2", "reserving", "owner/a", 14)]) });
    expect(check(fresh.records[0], "stuck_reserving")).toMatchObject({ ok: true });
  });

  it("long_running_agents: flags an agent active for more than 6 hours", async () => {
    const db = fakeDb();
    await run(db, { connector: await connectorWith([agent("l1", "launched", "owner/a", 6 * 60 + 1)]) });
    expect(check(db.records[0], "long_running_agents")).toMatchObject({ ok: false });
  });

  it("tick_fresh and tick_gaps: flag a stale last beat and a gap over 5 minutes", async () => {
    const beats: string[] = [];
    for (let minute = 24 * 60; minute >= 7; minute -= 1) beats.push(new Date(MORNING.getTime() - minute * 60_000).toISOString());
    const stale = fakeDb({ beats });
    await run(stale);
    expect(check(stale.records[0], "tick_fresh")).toMatchObject({ ok: false });

    const gappy = fakeDb();
    gappy.beats = gappy.beats.filter((beat) => {
      const age = (MORNING.getTime() - Date.parse(beat)) / 60_000;
      return age < 600 || age > 612;
    });
    await run(gappy);
    expect(check(gappy.records[0], "tick_fresh")).toMatchObject({ ok: true });
    expect(check(gappy.records[0], "tick_gaps")).toMatchObject({ ok: false });

    const none = fakeDb({ beats: [] });
    await run(none);
    expect(check(none.records[0], "tick_fresh")).toMatchObject({ ok: false });
    expect(check(none.records[0], "tick_gaps")).toMatchObject({ ok: false });
  });

  it("checker_credential: names a missing variable and never records a value", async () => {
    const present = fakeDb();
    await run(present);
    expect(check(present.records[0], "checker_credential")).toMatchObject({ ok: true });
    expect(JSON.stringify(present.records)).not.toContain(ENV.GH_HQ_TOKEN);
    expect(JSON.stringify(present.records)).not.toContain(ENV.GH_WORKERS_REPO);

    const missing = fakeDb();
    await run(missing, { env: { GH_WORKERS_REPO: "owner/workers" } });
    expect(check(missing.records[0], "checker_credential")).toMatchObject({ ok: false });
    expect(check(missing.records[0], "checker_credential").detail).toContain("GH_HQ_TOKEN");
  });

  it("role_sheet: flags a sheet that does not parse", async () => {
    const db = fakeDb();
    await run(db, { sheetText: "not: [valid" });
    expect(check(db.records[0], "role_sheet")).toMatchObject({ ok: false });
  });

  it("raises one Needs-you alert listing the failed checks", async () => {
    const db = fakeDb({ control: [false, false] });
    const result = await run(db, { connector: await connectorWith([agent("s1", "reserving", "owner/a", 30)]) });
    expect(result).toMatchObject({ status: "ran", ok: false, failed: ["stop_state", "stuck_reserving"] });
    expect(db.alerts).toEqual([{ day: "2026-10-08", failed: ["stop_state", "stuck_reserving"] }]);
  });
});

describe("self-test reads", () => {
  it("recognises the chat question", () => {
    for (const text of ["self test", "self-test", "selftest", "show me the self-tests", "today's self test", "health check", "Self-test results"]) {
      expect(isSelftestQuestion(text)).toBe(true);
    }
    for (const text of ["status", "test the login page", "write a self-test for the parser"]) {
      expect(isSelftestQuestion(text)).toBe(false);
    }
  });

  it("answers from the latest record without running anything", async () => {
    expect(await selftestChatAnswer(undefined, MORNING)).toContain("not configured");
    const empty = fakeDb();
    expect(await selftestChatAnswer(empty, MORNING)).toContain("No self-test has run yet");
    const db = fakeDb({ control: [false, false] });
    await run(db);
    const text = await selftestChatAnswer(db, new Date(MORNING.getTime() + 3_600_000));
    expect(text).toContain("2026-10-08");
    expect(text).toContain("failed");
    expect(text).toContain("stop_state");
    const ok = fakeDb();
    await run(ok);
    expect(await selftestChatAnswer(ok, MORNING)).toContain(`${SELFTEST_CHECKS.length} of ${SELFTEST_CHECKS.length} passed`);
    expect(await selftestChatAnswer(ok, new Date(MORNING.getTime() + 27 * 3_600_000))).toContain("stale");
  });

  it("health for the watchdog: ok only with a fresh tick and a fresh passing self-test", async () => {
    const db = fakeDb();
    await run(db);
    expect(await selftestHealth(db, new Date(MORNING.getTime() + 60_000))).toEqual({
      ok: true,
      tickAgeSeconds: 60,
      selfTestDay: "2026-10-08",
      selfTestOk: true,
      selfTestAgeHours: 0,
      reasons: [],
    });
    const later = new Date(MORNING.getTime() + 11 * 60_000);
    expect((await selftestHealth(db, later)).reasons).toEqual(["tick_stale"]);
    expect((await selftestHealth(db, new Date(MORNING.getTime() + 27 * 3_600_000))).reasons).toEqual(["tick_stale", "selftest_stale"]);
    expect((await selftestHealth(fakeDb(), MORNING)).reasons).toEqual(["selftest_missing"]);
    const failed = fakeDb({ control: [false, false] });
    await run(failed);
    expect(await selftestHealth(failed, MORNING)).toMatchObject({ ok: false, reasons: ["selftest_failed"] });
    const down = fakeDb({ pingError: new Error("down") });
    down.tickStats = async () => {
      throw new Error("down");
    };
    expect(await selftestHealth(down, MORNING)).toMatchObject({ ok: false, reasons: ["db_unreachable"] });
  });
});

describe("daily self-test: model pins", () => {
  it("pins_present: fails when model_resolutions has no rows", async () => {
    const db = fakeDb();
    const result = await run(db, { connector: await connectorWith([], false, { modelResolutions: [] }) });
    expect(result).toMatchObject({ status: "ran", ok: false });
    expect(check(db.records[0], "pins_present")).toMatchObject({ ok: false });
    expect(check(db.records[0], "pins_present").detail).toContain("no model_resolutions rows");
    expect(db.alerts[0]?.failed).toContain("pins_present");
  });

  it("pins_present: names each required family without a pin", async () => {
    const db = fakeDb();
    const [kept, ...dropped] = FAMILIES;
    expect(dropped.length).toBeGreaterThan(0);
    await run(db, { connector: await connectorWith([], false, { modelResolutions: PINS.filter((row) => row.family === kept) }) });
    const found = check(db.records[0], "pins_present");
    expect(found.ok).toBe(false);
    for (const family of dropped) expect(found.detail).toContain(family);
    expect(found.detail).not.toContain(`${kept},`);
  });

  it("pins_present: fails when there is no owner to hold pins", async () => {
    const db = fakeDb();
    await run(db, { connector: await connectorWith([], false, { bots: [] }) });
    expect(check(db.records[0], "pins_present")).toMatchObject({ ok: false });
  });

  it("pins_present: passes when every catalog family has a non-held pin", async () => {
    const db = fakeDb();
    await run(db);
    expect(check(db.records[0], "pins_present")).toMatchObject({ ok: true });
    expect(check(db.records[0], "held_versions")).toMatchObject({ ok: true, detail: "none held" });
  });

  it("held_versions: fails when a family has only held rows (launches refuse model_held)", async () => {
    const db = fakeDb();
    const [family] = FAMILIES;
    const rows = PINS.map((row) => (row.family === family ? { ...row, held: true, reason: "held: pinned none" } : row));
    await run(db, { connector: await connectorWith([], false, { modelResolutions: rows }) });
    expect(check(db.records[0], "held_versions")).toMatchObject({ ok: false });
    expect(check(db.records[0], "held_versions").detail).toContain(`model_held: ${family}`);
    expect(check(db.records[0], "pins_present")).toMatchObject({ ok: false });
  });

  it("held_versions: fails when a held version has no Needs-you card", async () => {
    const db = fakeDb();
    const [family] = FAMILIES;
    const held = { ...PINS[0]!, family: family!, version: `${family}-2`, held: true, reason: `held: pinned ${family}-1`, resolvedAt: "2026-10-08T00:00:00.000Z" };
    await run(db, { connector: await connectorWith([], false, { modelResolutions: [...PINS, held] }) });
    expect(check(db.records[0], "pins_present")).toMatchObject({ ok: true });
    expect(check(db.records[0], "held_versions")).toMatchObject({ ok: false });
    expect(check(db.records[0], "held_versions").detail).toContain(`${family}:${family}-2`);
  });

  it("held_versions: passes with a held version that carries its model_upgrade card", async () => {
    const db = fakeDb();
    const connector = await connectorWith([]);
    const [family] = FAMILIES;
    const rows = FAMILIES.map((name) =>
      name === family
        ? { family: name, version: `${name}-2`, held: true, reason: `held: pinned ${name}-1` }
        : { family: name, version: `${name}-1`, held: false, reason: "confirmed" },
    );
    const written = await connector.recordPinResolutions({ ownerId: OWNER, since: "2026-10-08T00:00:00.000Z", at: "2026-10-08T00:00:01.000Z", rows });
    expect(written.approvals.map((row) => row.action)).toEqual([MODEL_UPGRADE_ACTION]);
    await run(db, { connector });
    expect(check(db.records[0], "pins_present")).toMatchObject({ ok: true });
    expect(check(db.records[0], "held_versions")).toMatchObject({ ok: true, detail: "1 held version(s) awaiting the owner" });
  });
});
