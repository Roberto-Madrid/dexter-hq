import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import { handleChat } from "../../hq/chat.ts";
import { classifyQuestion } from "../../hq/classify.ts";
import { createMemoryConnectorStore, type ConnectorBot, type ConnectorEvent, type ConnectorPost } from "../../hq/connector-store.ts";
import { SHIPPED_CREWS } from "../../hq/crews.ts";
import type { HqDeps } from "../../hq/deps.ts";
import {
  COUNCIL_WEEKLY_CAP,
  buildFleetReport,
  createMemoryFleetReports,
  dueFleetWeek,
  fleetReportId,
  ptWeekContaining,
  readFleetView,
  renderFleetReport,
  runFleetReportTick,
} from "../../hq/fleet-report.ts";
import { MemoryStore } from "../../hq/memory.ts";
import { createScriptedCeo } from "../../hq/scripted-ceo.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const BARBER = "Roberto-Madrid/dexter-barber";
const HQ = "Roberto-Madrid/dexter-hq";
// W40 in America/Tijuana (PDT, UTC-7): Mon Sep 28 00:00 PT to Mon Oct 5 00:00 PT.
const W40 = { key: "2026-W40", start: "2026-09-28T07:00:00.000Z", end: "2026-10-05T07:00:00.000Z" };
const GENERATED_AT = "2026-10-08T09:00:00.000Z";

function bot(id: string, name: string, kind: string, repos: string[], heartbeatAt: string | null): ConnectorBot {
  return { id, ownerId: OWNER, name, kind, repos, tools: [], currentTask: null, heartbeatAt };
}

const BOTS: ConnectorBot[] = [
  bot("b-ceo", "dexter", "ceo", [], "2026-10-08T08:00:00.000Z"),
  bot("b-barber", "barber-lead", "lead", [BARBER], "2026-10-06T00:00:00.000Z"),
  bot("b-hq", "hq-dev", "lead", [HQ], "2026-10-08T08:30:00.000Z"),
  bot("b-scout", "scout", "scout", [], null),
];

const POSTS: ConnectorPost[] = [
  // Expired before GENERATED_AT: no longer on the board.
  { id: "p0", ownerId: OWNER, type: "dead_end", author: "hq-dev", body: "older dead end", repo: HQ, verified: false, expiresAt: "2026-10-01T00:00:00.000Z" },
  { id: "p1", ownerId: OWNER, type: "finding", author: "barber-lead", body: "finding", repo: BARBER, verified: true },
  { id: "p2", ownerId: OWNER, type: "dead_end", author: "hq-dev", body: "dead end", repo: HQ, verified: false, expiresAt: "2026-11-01T00:00:00.000Z" },
];

let seq = 0;
function ev(actor: string, action: string, target: string, result: Record<string, unknown>, at?: string): ConnectorEvent {
  seq += 1;
  const minute = String(seq % 60).padStart(2, "0");
  return { id: `e${seq}`, ownerId: OWNER, actor, action, target, result, at: at ?? `2026-10-01T12:${minute}:00.000Z` };
}

function fixtureEvents(): ConnectorEvent[] {
  return [
    ev("dexter", "open_request", "r1", { status: "opened", requestId: "r1", requestStatus: "queued" }),
    ev("dexter", "open_request", "r2", { status: "opened", requestId: "r2", requestStatus: "queued" }),
    ev("dexter", "open_request", "refused", { status: "refused", reason: "invalid_plan_card" }),
    ev("barber-lead", "launch_agent", "bc-1", { status: "launched", launched: true, agentId: "bc-1" }),
    ev("barber-lead", "launch_agent", "bc-2", { status: "launched", launched: true, agentId: "bc-2" }),
    ev("barber-lead", "launch_agent", BARBER, { status: "refused", reason: "per_repo_cap", cap: 2 }),
    ev("hq-dev", "launch_agent", "bc-3", { status: "launched", launched: true, agentId: "bc-3" }),
    ev("hq-dev", "launch_agent", "key-4", { status: "refused", reason: "agent_cap", cap: 3 }),
    ev("hq-dev", "launch_agent", "key-5", { status: "error", launched: false, reason: "launch_failed" }),
    ev("hq", "agent_finished", "bc-1", { status: "finished", state: "FINISHED", repo: BARBER, botId: "b-barber" }),
    ev("barber-lead", "agent_status", "bc-2", { status: "ERROR" }),
    ev("barber-lead", "agent_status", "bc-2", { status: "ERROR" }),
    ev("hq-dev", "cancel_agent", "bc-3", { status: "confirmed", agentId: "bc-3" }),
    ev("barber-lead", "update_request", "r1", { status: "updated", requestId: "r1", requestStatus: "done" }),
    ev("hq-dev", "update_request", "r2", { status: "updated", requestId: "r2", requestStatus: "blocked" }),
    ev("barber-lead", "request_checks", "r1", { status: "ready", ready: true }),
    ev("barber-lead", "request_checks", "r1", { status: "failed", ready: false }),
    ev("barber-lead", "council_seat", "r1", { seat: "critic" }),
    ev("barber-lead", "request_council", "r1", { status: "verdict", seat: "critic", result: "pass", actions: [] }),
    ev("hq-dev", "council_seat", "r2", { seat: "critic" }),
    ev("hq-dev", "request_council", "r2", { status: "error", reason: "invalid_verdict" }),
    ev("hq-dev", "request_council", "r2", { status: "refused", reason: "council_weekly_cap", cap: 40 }),
    ev("barber-lead", "post", "p1", { status: "posted", postId: "p1", verified: false }),
    ev("hq-dev", "post", "p2", { status: "posted", postId: "p2", verified: false }),
    ev("hq-dev", "verify_post", "p1", { status: "verified", postId: "p1" }),
    ev("barber-lead", "heartbeat", "b-barber", { status: "ok" }),
    ev("owner", "add_venture", "b-barber", { status: "created", repo: BARBER }),
    // Outside the PT week: one millisecond before it starts, and exactly at its end.
    ev("barber-lead", "launch_agent", "bc-early", { status: "launched", agentId: "bc-early" }, "2026-09-28T06:59:59.999Z"),
    ev("hq-dev", "launch_agent", "bc-late", { status: "launched", agentId: "bc-late" }, "2026-10-05T07:00:00.000Z"),
  ];
}

async function seededConnector(events = fixtureEvents()) {
  const connector = createMemoryConnectorStore({ bots: BOTS });
  for (const item of events) await connector.appendEvent(item);
  for (const post of POSTS) await connector.savePost(post);
  return connector;
}

describe("PT week boundary (America/Tijuana)", () => {
  it("puts Sunday 23:59 PT in the old week and Monday 00:00 PT in the new one", () => {
    expect(ptWeekContaining(new Date("2026-10-05T06:59:59.999Z"))).toEqual(W40);
    expect(ptWeekContaining(new Date("2026-10-05T07:00:00.000Z"))).toEqual({
      key: "2026-W41",
      start: "2026-10-05T07:00:00.000Z",
      end: "2026-10-12T07:00:00.000Z",
    });
  });

  it("is 169 hours long across the November DST change", () => {
    expect(ptWeekContaining(new Date("2026-10-30T19:00:00.000Z"))).toEqual({
      key: "2026-W44",
      start: "2026-10-26T07:00:00.000Z",
      end: "2026-11-02T08:00:00.000Z",
    });
  });

  it("uses the ISO week-year at the turn of the year", () => {
    expect(ptWeekContaining(new Date("2025-12-31T20:00:00.000Z")).key).toBe("2026-W01");
  });

  it("makes last week due from Monday 07:00 PT, not before", () => {
    expect(dueFleetWeek(new Date("2026-10-05T13:59:59.999Z"))).toBeNull();
    expect(dueFleetWeek(new Date("2026-10-05T14:00:00.000Z"))).toEqual(W40);
    expect(dueFleetWeek(new Date("2026-10-08T09:00:00.000Z"))).toEqual(W40);
    expect(dueFleetWeek(new Date("2026-10-12T06:59:00.000Z"))).toEqual(W40);
  });

  it("derives one stable post id per week", () => {
    expect(fleetReportId("2026-W40")).toBe(fleetReportId("2026-W40"));
    expect(fleetReportId("2026-W40")).not.toBe(fleetReportId("2026-W41"));
    expect(fleetReportId("2026-W40")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("fleet report aggregation", () => {
  it("counts a fixture week exactly", () => {
    const report = buildFleetReport({ week: W40, events: fixtureEvents(), bots: BOTS, posts: POSTS, generatedAt: GENERATED_AT });
    expect(report.totals).toEqual({
      requests: { opened: 2, done: 1, blocked: 1, failed: 0 },
      agents: { launched: 3, finished: 1, errored: 1, cancelled: 1, expired: 0, launchFailed: 1 },
      refusals: { invalid_plan_card: 1, per_repo_cap: 1, agent_cap: 1, council_weekly_cap: 1 },
      refused: 4,
      capRefusals: 3,
      council: { seatsUsed: 2, cap: COUNCIL_WEEKLY_CAP, verdicts: { pass: 1 } },
      checks: { passed: 1, failed: 1 },
      findings: { posted: 1, verified: 1 },
      deadEnds: { posted: 1, onBoard: 1 },
      waste: { cancelled: 1, errored: 1, launchFailed: 1, refused: 4, total: 7 },
      usage: { receipts: 0, unavailable: 0, inputTokens: 0, outputTokens: 0, chargedCents: null },
    });
    const barber = report.bots.find((line) => line.bot === "barber-lead");
    expect(barber).toMatchObject({
      kind: "lead",
      repos: [BARBER],
      requests: { opened: 0, done: 1, blocked: 0, failed: 0 },
      agents: { launched: 2, finished: 1, errored: 1, cancelled: 0, expired: 0, launchFailed: 0 },
      refusals: { per_repo_cap: 1 },
      capRefusals: 1,
      council: { seats: 1, verdicts: { pass: 1 } },
      checks: { passed: 1, failed: 1 },
      findings: { posted: 1, verified: 0 },
      stale: true,
      neverSeen: false,
      idle: false,
    });
    const hq = report.bots.find((line) => line.bot === "hq-dev");
    expect(hq).toMatchObject({
      agents: { launched: 1, finished: 0, errored: 0, cancelled: 1, expired: 0, launchFailed: 1 },
      refusals: { agent_cap: 1, council_weekly_cap: 1 },
      capRefusals: 2,
      requests: { opened: 0, done: 0, blocked: 1, failed: 0 },
      council: { seats: 1, verdicts: {} },
      findings: { posted: 0, verified: 1 },
      deadEnds: { posted: 1 },
      stale: false,
    });
    expect(report.bots.find((line) => line.bot === "dexter")).toMatchObject({
      requests: { opened: 2, done: 0, blocked: 0, failed: 0 },
      refusals: { invalid_plan_card: 1 },
      capRefusals: 0,
    });
    expect(report.staleBots).toEqual(["barber-lead"]);
    expect(report.neverSeenBots).toEqual(["scout"]);
    expect(report.idleBots).toEqual(["scout"]);
    expect(report.bots.map((line) => line.bot)).not.toContain("hq");
    expect(report.bots.map((line) => line.bot)).not.toContain("owner");
  });

  it("reports zeros for an empty week and lists every bot as idle", () => {
    const report = buildFleetReport({ week: W40, events: [], bots: BOTS, posts: [], generatedAt: GENERATED_AT });
    expect(report.totals.requests).toEqual({ opened: 0, done: 0, blocked: 0, failed: 0 });
    expect(report.totals.agents).toEqual({ launched: 0, finished: 0, errored: 0, cancelled: 0, expired: 0, launchFailed: 0 });
    expect(report.totals.refused).toBe(0);
    expect(report.totals.council).toEqual({ seatsUsed: 0, cap: 40, verdicts: {} });
    expect(report.totals.waste.total).toBe(0);
    expect(report.idleBots).toEqual(["dexter", "barber-lead", "hq-dev", "scout"]);
    expect(renderFleetReport(report)).toContain("0 of 40 Council seats");
  });

  it("renders a readable text report", () => {
    const text = renderFleetReport(
      buildFleetReport({ week: W40, events: fixtureEvents(), bots: BOTS, posts: POSTS, generatedAt: GENERATED_AT }),
    );
    expect(text.split("\n")[0]).toBe("Fleet report 2026-W40, Mon Sep 28 to Sun Oct 4 (PT).");
    expect(text).toContain("Requests: 2 opened, 1 done, 1 blocked, 0 failed.");
    expect(text).toContain("Agents: 3 launched, 1 finished, 1 errored, 1 cancelled, 0 expired, 1 failed to launch.");
    expect(text).toContain("Refusals: 4 (3 at a cap).");
    expect(text).toContain("2 of 40 Council seats");
    expect(text).toContain(`barber-lead [${BARBER}]`);
    expect(text).toContain("Stale (no heartbeat in 24h): barber-lead.");
    expect(text).toContain("Never seen: scout.");
    expect(text).toContain("Idle this week: scout.");
    expect(text).toContain("Dead ends: 1 posted, 1 on the board.");
  });

  it("counts only active dead ends on the board", () => {
    const deadEnd = (id: string, expiresAt: string | null | undefined, extra: Partial<ConnectorPost> = {}): ConnectorPost => ({
      id,
      ownerId: OWNER,
      type: "dead_end",
      author: "hq-dev",
      body: id,
      repo: HQ,
      verified: false,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...extra,
    });
    const posts = [
      deadEnd("expired", "2026-10-01T00:00:00.000Z"),
      deadEnd("expires-now", GENERATED_AT),
      deadEnd("no-expiry", undefined),
      deadEnd("null-expiry", null),
      deadEnd("stale", "2026-12-01T00:00:00.000Z", { status: "stale" }),
      deadEnd("active-1", "2026-10-09T00:00:00.000Z"),
      deadEnd("active-2", "2027-01-01T00:00:00.000Z"),
    ];
    const report = buildFleetReport({ week: W40, events: [], bots: BOTS, posts, generatedAt: GENERATED_AT });
    expect(report.totals.deadEnds).toEqual({ posted: 0, onBoard: 2 });
    // The same rows read a month later: every dead end has expired.
    const later = buildFleetReport({ week: W40, events: [], bots: BOTS, posts, generatedAt: "2027-02-01T00:00:00.000Z" });
    expect(later.totals.deadEnds.onBoard).toBe(0);
  });
});

describe("weekly generation", () => {
  it("writes one post and one event per week, however many ticks run", async () => {
    const connector = await seededConnector();
    const db = createMemoryFleetReports(connector);
    const now = new Date(GENERATED_AT);
    const first = await runFleetReportTick({ db, now });
    expect(first).toEqual({ status: "written", week: "2026-W40", postId: fleetReportId("2026-W40") });
    const second = await runFleetReportTick({ db, now: new Date("2026-10-08T09:01:00.000Z") });
    expect(second).toEqual({ status: "exists", week: "2026-W40", postId: fleetReportId("2026-W40") });
    const raced = await Promise.all([runFleetReportTick({ db, now }), runFleetReportTick({ db, now })]);
    expect(raced.map((item) => item.status)).toEqual(["exists", "exists"]);
    const posts = (await connector.listPosts()).filter((post) => post.id === fleetReportId("2026-W40"));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ type: "alert", author: "hq", repo: null, ownerId: OWNER });
    const events = (await connector.listEvents()).filter((item) => item.action === "fleet_report");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "hq", target: "2026-W40", ownerId: OWNER });
    const stored = await db.getReport("2026-W40");
    expect(stored?.report.totals.agents.launched).toBe(3);
  });

  it("writes exactly once when two ticks race on a fresh week", async () => {
    const connector = await seededConnector();
    const db = createMemoryFleetReports(connector);
    const now = new Date(GENERATED_AT);
    const results = await Promise.all([runFleetReportTick({ db, now }), runFleetReportTick({ db, now })]);
    expect(results.map((item) => item.status).sort()).toEqual(["exists", "written"]);
    expect((await connector.listEvents()).filter((item) => item.action === "fleet_report")).toHaveLength(1);
  });

  it("writes nothing before Monday 07:00 PT", async () => {
    const connector = await seededConnector();
    const db = createMemoryFleetReports(connector);
    expect(await runFleetReportTick({ db, now: new Date("2026-10-05T13:59:00.000Z") })).toEqual({ status: "not_due" });
    expect(await connector.listPosts()).toHaveLength(POSTS.length);
    expect((await connector.listEvents()).filter((item) => item.action === "fleet_report")).toHaveLength(0);
  });

  it("reads the latest report, or a named week, for the board view", async () => {
    const db = createMemoryFleetReports(await seededConnector());
    expect(await readFleetView(db, null)).toEqual({ week: null, text: expect.stringContaining("No fleet report yet"), report: null });
    await runFleetReportTick({ db, now: new Date(GENERATED_AT) });
    const latest = await readFleetView(db, null);
    expect(latest.week).toBe("2026-W40");
    expect(latest.report?.totals.requests.opened).toBe(2);
    expect((await readFleetView(db, "2026-W40")).week).toBe("2026-W40");
    expect((await readFleetView(db, "2026-W39")).report).toBeNull();
    expect((await readFleetView(db, "not-a-week")).report).toBeNull();
  });
});

describe("HQ chat reads the fleet report", () => {
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

  it("classifies fleet report asks before list asks", () => {
    for (const text of ["fleet report", "Fleet report please", "show the fleet report", "weekly report", "what's in this week's fleet report?"]) {
      expect(classifyQuestion(text)).toBe("fleet");
    }
    expect(classifyQuestion("show requests")).toBe("list");
    expect(classifyQuestion("Fix the fleet report layout bug in the repo")).toBe("work");
  });

  it("answers from the stored report with no model call", async () => {
    const db = createMemoryFleetReports(await seededConnector());
    await runFleetReportTick({ db, now: new Date(GENERATED_AT) });
    const wired = deps({ fleetReports: db });
    const store = new MemoryStore(() => new Date(GENERATED_AT));
    const result = await handleChat(store, wired, "fleet report");
    expect(result.kind).toBe("status");
    expect(result.modelCalls).toBe(0);
    expect(wired.ceo.calls).toBe(0);
    expect(result.text.split("\n")[0]).toBe("Fleet report 2026-W40, Mon Sep 28 to Sun Oct 4 (PT).");
    const messages = await store.listMessages();
    expect(messages.map((item) => item.role)).toEqual(["owner", "dexter"]);
  });

  it("says so when no report is stored yet", async () => {
    const wired = deps();
    const result = await handleChat(new MemoryStore(), wired, "fleet report");
    expect(result.kind).toBe("status");
    expect(result.modelCalls).toBe(0);
    expect(result.text).toContain("No fleet report yet");
  });
});
