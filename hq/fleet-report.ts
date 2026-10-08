import { createHash } from "node:crypto";
import { COUNCIL_WEEKLY_SEAT_CAP } from "./connector.ts";
import type { ConnectorBot, ConnectorEvent, ConnectorPost, ConnectorStore } from "./connector-store.ts";

/**
 * Weekly fleet report (Stage 3 U5). Pure aggregation over rows HQ already keeps:
 * the connector `events` log, `bots`, and `posts`. No new table: the report is one
 * `posts` row (type alert, author hq) with a week-derived id, plus one `fleet_report` event.
 */

export const FLEET_TIME_ZONE = "America/Tijuana";
/** The report for a finished week is due from this hour (PT) on the following Monday. */
export const FLEET_DUE_HOUR = 7;
/** V6 §5: the weekly Council seat cap the connector enforces (40). */
export const COUNCIL_WEEKLY_CAP = COUNCIL_WEEKLY_SEAT_CAP;
export const CAP_REASONS: ReadonlySet<string> = new Set([
  "agent_cap",
  "surge_cap",
  "per_repo_cap",
  "request_cap",
  "council_weekly_cap",
]);
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const WEEK_KEY = /^\d{4}-W\d{2}$/;
const SYSTEM_ACTOR = "hq";
/** Actors that are not bots: HQ itself and the owner (add_venture, rotate_token). */
const NON_BOT_ACTORS = new Set([SYSTEM_ACTOR, "owner"]);
const PASSIVE_ACTIONS = new Set(["heartbeat", "whoami"]);
const NO_REPORT = "No fleet report yet. HQ writes one on the first tick after Monday 07:00 PT.";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type FleetWeek = { key: string; start: string; end: string };

type Counts = {
  requests: { opened: number; done: number; blocked: number; failed: number };
  agents: { launched: number; finished: number; errored: number; cancelled: number; expired: number; launchFailed: number };
  refusals: Record<string, number>;
  capRefusals: number;
  checks: { passed: number; failed: number };
  findings: { posted: number; verified: number };
};

export type FleetBotLine = Counts & {
  bot: string;
  kind: string | null;
  repos: string[];
  council: { seats: number; verdicts: Record<string, number> };
  deadEnds: { posted: number };
  lastHeartbeat: string | null;
  stale: boolean;
  neverSeen: boolean;
  idle: boolean;
};

export type FleetTotals = Omit<Counts, "refusals" | "capRefusals"> & {
  refusals: Record<string, number>;
  refused: number;
  capRefusals: number;
  council: { seatsUsed: number; cap: number; verdicts: Record<string, number> };
  deadEnds: { posted: number; onBoard: number };
  waste: { cancelled: number; errored: number; launchFailed: number; refused: number; total: number };
};

export type FleetReport = {
  week: string;
  start: string;
  end: string;
  label: string;
  timeZone: string;
  generatedAt: string;
  totals: FleetTotals;
  bots: FleetBotLine[];
  staleBots: string[];
  neverSeenBots: string[];
  idleBots: string[];
  notTracked: string[];
};

export type StoredFleetReport = {
  id: string;
  week: string;
  ownerId: string;
  text: string;
  report: FleetReport;
  generatedAt: string;
};

export interface FleetSource {
  eventsBetween(start: string, end: string): Promise<ConnectorEvent[]>;
  listBots(): Promise<ConnectorBot[]>;
  listPosts(): Promise<ConnectorPost[]>;
}

export interface FleetReportStore {
  getReport(week: string): Promise<StoredFleetReport | null>;
  latestReport(): Promise<StoredFleetReport | null>;
  /** Writes the post and its `fleet_report` event together. False when the week already has one. */
  insertReportOnce(row: StoredFleetReport): Promise<boolean>;
}

export type FleetDb = FleetSource & FleetReportStore;

// ---------- PT week math ----------

const wallFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: FLEET_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const labelFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: FLEET_TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
});

function wall(ms: number): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
  const parts: Record<string, number> = {};
  for (const part of wallFormat.formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { y: parts.year ?? 0, m: parts.month ?? 1, d: parts.day ?? 1, hh: parts.hour ?? 0, mm: parts.minute ?? 0, ss: parts.second ?? 0 };
}

function offsetMs(ms: number): number {
  const base = Math.floor(ms / 1000) * 1000;
  const w = wall(base);
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) - base;
}

/** UTC instant of 00:00 PT on a calendar date. Midnight never falls inside a DST jump here (they happen at 02:00). */
function ptMidnight(y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(guess);
  return guess - offsetMs(first);
}

function isoWeekKey(y: number, m: number, d: number): string {
  const thursday = new Date(Date.UTC(y, m - 1, d + 3));
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The America/Tijuana week (Monday 00:00 to the next Monday 00:00) that contains `at`. */
export function ptWeekContaining(at: Date): FleetWeek {
  const w = wall(at.getTime());
  const sinceMonday = (new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(w.y, w.m - 1, w.d - sinceMonday));
  const next = new Date(Date.UTC(w.y, w.m - 1, w.d - sinceMonday + 7));
  const start = ptMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
  const end = ptMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return {
    key: isoWeekKey(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}

/** The finished week whose report is due at `now`, or null before Monday 07:00 PT. */
export function dueFleetWeek(now: Date): FleetWeek | null {
  const current = ptWeekContaining(now);
  const startMs = Date.parse(current.start);
  if (now.getTime() < startMs + FLEET_DUE_HOUR * HOUR_MS) return null;
  return ptWeekContaining(new Date(startMs - 1));
}

/** Deterministic uuid (v5 layout) per week, so a second write hits the primary key. */
export function fleetReportId(week: string): string {
  const h = createHash("sha256").update(`dexter-hq:fleet-report:${week}`).digest("hex");
  const variant = ((parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function dayLabel(ms: number): string {
  const parts: Record<string, string> = {};
  for (const part of labelFormat.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return `${parts.weekday} ${parts.month} ${parts.day}`;
}

function weekLabel(week: FleetWeek): string {
  return `${dayLabel(Date.parse(week.start))} to ${dayLabel(Date.parse(week.end) - 1)}`;
}

// ---------- aggregation ----------

function emptyCounts(): Counts {
  return {
    requests: { opened: 0, done: 0, blocked: 0, failed: 0 },
    agents: { launched: 0, finished: 0, errored: 0, cancelled: 0, expired: 0, launchFailed: 0 },
    refusals: {},
    capRefusals: 0,
    checks: { passed: 0, failed: 0 },
    findings: { posted: 0, verified: 0 },
  };
}

type Acc = Counts & {
  seatEvents: number;
  seatAttempts: number;
  verdicts: Record<string, number>;
  deadEndsPosted: number;
  active: boolean;
  requestStates: Set<string>;
};

function emptyAcc(): Acc {
  return { ...emptyCounts(), seatEvents: 0, seatAttempts: 0, verdicts: {}, deadEndsPosted: 0, active: false, requestStates: new Set() };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

type Outcome = "finished" | "errored" | "cancelled" | "expired";

function terminal(status: string | null): Outcome | null {
  const value = status?.toLowerCase() ?? "";
  if (value === "finished" || value === "completed") return "finished";
  if (value === "error" || value === "errored" || value === "failed") return "errored";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  if (value === "expired") return "expired";
  return null;
}

function agentOutcome(event: ConnectorEvent): Outcome | null {
  const status = text(event.result?.status);
  if (event.action === "agent_finished") return terminal(status ?? text(event.result?.state));
  if (event.action === "agent_status") return terminal(status);
  if (event.action === "cancel_agent") {
    if (!status || ["refused", "error", "not-configured", "stopped"].includes(status)) return null;
    return "cancelled";
  }
  return null;
}

export function buildFleetReport(input: {
  week: FleetWeek;
  events: readonly ConnectorEvent[];
  bots: readonly ConnectorBot[];
  posts: readonly ConnectorPost[];
  generatedAt: string;
}): FleetReport {
  const startMs = Date.parse(input.week.start);
  const endMs = Date.parse(input.week.end);
  const events = input.events
    .filter((item) => {
      const at = Date.parse(item.at);
      return at >= startMs && at < endMs;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const botNames = new Map(input.bots.map((bot) => [bot.id, bot.name]));
  const postTypes = new Map(input.posts.map((post) => [post.id, post.type]));
  const accs = new Map<string, Acc>();
  const acc = (name: string): Acc => {
    let found = accs.get(name);
    if (!found) {
      found = emptyAcc();
      accs.set(name, found);
    }
    return found;
  };
  for (const bot of input.bots) acc(bot.name);
  const totalRequestStates = new Set<string>();
  const outcomes = new Map<string, { bot: string; outcome: Outcome }>();

  for (const event of events) {
    const status = text(event.result?.status);
    const owner =
      event.action === "agent_finished"
        ? (botNames.get(text(event.result?.botId) ?? "") ?? text(event.result?.botId) ?? event.actor)
        : event.actor;
    if (NON_BOT_ACTORS.has(owner)) continue;
    const line = acc(owner);
    if (!PASSIVE_ACTIONS.has(event.action)) line.active = true;

    const outcome = agentOutcome(event);
    if (outcome) outcomes.set(event.target, { bot: owner, outcome });

    if (status === "refused") {
      const reason = text(event.result?.reason) ?? "unknown";
      bump(line.refusals, reason);
      if (CAP_REASONS.has(reason)) line.capRefusals += 1;
    }
    if (event.action === "launch_agent") {
      if (status === "launched") line.agents.launched += 1;
      if (status === "error") line.agents.launchFailed += 1;
    }
    if (event.action === "open_request" && status === "opened") line.requests.opened += 1;
    if (event.action === "update_request" && status === "updated") {
      const requestStatus = text(event.result?.requestStatus);
      const requestId = text(event.result?.requestId) ?? event.target;
      if (requestStatus === "done" || requestStatus === "blocked" || requestStatus === "failed") {
        line.requestStates.add(`${requestStatus}:${requestId}`);
        totalRequestStates.add(`${requestStatus}:${requestId}`);
      }
    }
    if (event.action === "request_checks") {
      if (status === "ready") line.checks.passed += 1;
      if (status === "failed") line.checks.failed += 1;
    }
    if (event.action === "council_seat") line.seatEvents += 1;
    if (event.action === "request_council") {
      if (status === "verdict" || status === "error") line.seatAttempts += 1;
      if (status === "verdict") bump(line.verdicts, text(event.result?.result) ?? "unknown");
    }
    if (event.action === "post" && status === "posted") {
      const type = postTypes.get(text(event.result?.postId) ?? event.target);
      if (type === "finding") line.findings.posted += 1;
      if (type === "dead_end") line.deadEndsPosted += 1;
    }
    if (event.action === "verify_post" && status === "verified") {
      if (postTypes.get(text(event.result?.postId) ?? event.target) === "finding") line.findings.verified += 1;
    }
  }
  for (const { bot, outcome } of outcomes.values()) acc(bot).agents[outcome] += 1;

  const generatedMs = Date.parse(input.generatedAt);
  const known = new Map(input.bots.map((bot) => [bot.name, bot]));
  const order = [...input.bots.map((bot) => bot.name), ...[...accs.keys()].filter((name) => !known.has(name)).sort()];
  const lines: FleetBotLine[] = [];
  for (const name of order) {
    const item = accs.get(name) ?? emptyAcc();
    const bot = known.get(name);
    if (!bot && !item.active) continue;
    const countState = (state: string) => [...item.requestStates].filter((key) => key.startsWith(`${state}:`)).length;
    const heartbeat = bot?.heartbeatAt ?? null;
    lines.push({
      bot: name,
      kind: bot?.kind ?? null,
      repos: bot ? [...bot.repos] : [],
      requests: { opened: item.requests.opened, done: countState("done"), blocked: countState("blocked"), failed: countState("failed") },
      agents: item.agents,
      refusals: item.refusals,
      capRefusals: item.capRefusals,
      council: { seats: Math.max(item.seatEvents, item.seatAttempts), verdicts: item.verdicts },
      checks: item.checks,
      findings: item.findings,
      deadEnds: { posted: item.deadEndsPosted },
      lastHeartbeat: heartbeat,
      stale: Boolean(bot && heartbeat && generatedMs - Date.parse(heartbeat) > STALE_AFTER_MS),
      neverSeen: Boolean(bot && !heartbeat),
      idle: Boolean(bot && !item.active),
    });
  }

  const totals: FleetTotals = {
    requests: {
      opened: 0,
      done: [...totalRequestStates].filter((key) => key.startsWith("done:")).length,
      blocked: [...totalRequestStates].filter((key) => key.startsWith("blocked:")).length,
      failed: [...totalRequestStates].filter((key) => key.startsWith("failed:")).length,
    },
    agents: { launched: 0, finished: 0, errored: 0, cancelled: 0, expired: 0, launchFailed: 0 },
    refusals: {},
    refused: 0,
    capRefusals: 0,
    council: { seatsUsed: 0, cap: COUNCIL_WEEKLY_CAP, verdicts: {} },
    checks: { passed: 0, failed: 0 },
    findings: { posted: 0, verified: 0 },
    // dexter-shortcut: counts every dead_end post because ConnectorPost has no expiry yet; upgrade path: count only deadEndActive() rows once U4 reads expires_at.
    deadEnds: { posted: 0, onBoard: input.posts.filter((post) => post.type === "dead_end").length },
    waste: { cancelled: 0, errored: 0, launchFailed: 0, refused: 0, total: 0 },
  };
  for (const line of lines) {
    totals.requests.opened += line.requests.opened;
    for (const key of Object.keys(totals.agents) as (keyof FleetTotals["agents"])[]) totals.agents[key] += line.agents[key];
    for (const [reason, count] of Object.entries(line.refusals)) {
      totals.refusals[reason] = (totals.refusals[reason] ?? 0) + count;
      totals.refused += count;
    }
    totals.capRefusals += line.capRefusals;
    totals.council.seatsUsed += line.council.seats;
    for (const [verdict, count] of Object.entries(line.council.verdicts)) {
      totals.council.verdicts[verdict] = (totals.council.verdicts[verdict] ?? 0) + count;
    }
    totals.checks.passed += line.checks.passed;
    totals.checks.failed += line.checks.failed;
    totals.findings.posted += line.findings.posted;
    totals.findings.verified += line.findings.verified;
    totals.deadEnds.posted += line.deadEnds.posted;
  }
  totals.waste = {
    cancelled: totals.agents.cancelled,
    errored: totals.agents.errored,
    launchFailed: totals.agents.launchFailed,
    refused: totals.refused,
    total: totals.agents.cancelled + totals.agents.errored + totals.agents.launchFailed + totals.refused,
  };

  return {
    week: input.week.key,
    start: input.week.start,
    end: input.week.end,
    label: weekLabel(input.week),
    timeZone: FLEET_TIME_ZONE,
    generatedAt: input.generatedAt,
    totals,
    bots: lines,
    staleBots: lines.filter((line) => line.stale).map((line) => line.bot),
    neverSeenBots: lines.filter((line) => line.neverSeen).map((line) => line.bot),
    idleBots: lines.filter((line) => line.idle).map((line) => line.bot),
    // dexter-shortcut: tick gaps, self-test results and Cursor usage are not in the report; upgrade path: add them from spike_heartbeats, the U6 self-test events and U1's result.usage.
    notTracked: ["tick gaps", "self-test failures", "Cursor usage per agent"],
  };
}

// ---------- text ----------

function reasons(record: Record<string, number>): string {
  return Object.entries(record)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key} ${count}`)
    .join(", ");
}

function botLine(line: FleetBotLine): string {
  const name = `- ${line.bot}${line.repos.length > 0 ? ` [${line.repos.join(", ")}]` : line.kind ? ` (${line.kind})` : ""}`;
  if (line.idle) return `${name}: no activity.`;
  const r = line.requests;
  const a = line.agents;
  const parts = [
    `requests ${r.opened} opened/${r.done} done/${r.blocked} blocked/${r.failed} failed`,
    `agents ${a.launched} launched/${a.finished} finished/${a.errored} errored/${a.cancelled} cancelled/${a.expired} expired/${a.launchFailed} failed to launch`,
    `refusals ${Object.keys(line.refusals).length > 0 ? reasons(line.refusals) : "none"}`,
    `council ${line.council.seats} seat${line.council.seats === 1 ? "" : "s"}${Object.keys(line.council.verdicts).length > 0 ? ` (${reasons(line.council.verdicts)})` : ""}`,
    `checks ${line.checks.passed} passed/${line.checks.failed} failed`,
    `findings ${line.findings.posted} posted/${line.findings.verified} verified`,
    `dead ends ${line.deadEnds.posted} posted`,
  ];
  return `${name}: ${parts.join("; ")}.`;
}

function list(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "none";
}

export function renderFleetReport(report: FleetReport): string {
  const t = report.totals;
  const verdicts = Object.keys(t.council.verdicts).length > 0 ? ` Verdicts: ${reasons(t.council.verdicts)}.` : "";
  const byReason = t.refused > 0 ? ` By reason: ${reasons(t.refusals)}.` : "";
  return [
    `Fleet report ${report.week}, ${report.label} (PT).`,
    `Requests: ${t.requests.opened} opened, ${t.requests.done} done, ${t.requests.blocked} blocked, ${t.requests.failed} failed.`,
    `Agents: ${t.agents.launched} launched, ${t.agents.finished} finished, ${t.agents.errored} errored, ${t.agents.cancelled} cancelled, ${t.agents.expired} expired, ${t.agents.launchFailed} failed to launch.`,
    `Refusals: ${t.refused} (${t.capRefusals} at a cap).${byReason}`,
    `Council: ${t.council.seatsUsed} of ${t.council.cap} Council seats used.${verdicts}`,
    `Checks: ${t.checks.passed} passed, ${t.checks.failed} failed.`,
    `Findings: ${t.findings.posted} posted, ${t.findings.verified} verified. Dead ends: ${t.deadEnds.posted} posted, ${t.deadEnds.onBoard} on the board.`,
    `Waste: ${t.waste.total} (${t.waste.cancelled} cancelled, ${t.waste.errored} errored, ${t.waste.launchFailed} failed to launch, ${t.waste.refused} refused).`,
    "Per bot:",
    ...(report.bots.length > 0 ? report.bots.map(botLine) : ["- no bots."]),
    `Stale (no heartbeat in 24h): ${list(report.staleBots)}.`,
    `Never seen: ${list(report.neverSeenBots)}.`,
    `Idle this week: ${list(report.idleBots)}.`,
    `Not tracked yet: ${report.notTracked.join(", ")}.`,
  ].join("\n");
}

// ---------- weekly write and reads ----------

function ownerOf(bots: readonly ConnectorBot[], events: readonly ConnectorEvent[], fallback: string): string {
  return bots[0]?.ownerId ?? events[0]?.ownerId ?? fallback;
}

export type FleetTickResult = { status: "not_due" } | { status: "written" | "exists"; week: string; postId: string };

/**
 * Called from the per-minute tick. Safe to repeat: the week's post id is fixed, and the
 * store inserts post and event together only when that id is new.
 */
export async function runFleetReportTick(input: { db: FleetDb; now: Date; ownerId?: string }): Promise<FleetTickResult> {
  const week = dueFleetWeek(input.now);
  if (!week) return { status: "not_due" };
  const postId = fleetReportId(week.key);
  if (await input.db.getReport(week.key)) return { status: "exists", week: week.key, postId };
  const [events, bots, posts] = await Promise.all([
    input.db.eventsBetween(week.start, week.end),
    input.db.listBots(),
    input.db.listPosts(),
  ]);
  const generatedAt = input.now.toISOString();
  const report = buildFleetReport({ week, events, bots, posts, generatedAt });
  const inserted = await input.db.insertReportOnce({
    id: postId,
    week: week.key,
    ownerId: input.ownerId ?? ownerOf(bots, events, "00000000-0000-4000-8000-000000000000"),
    text: renderFleetReport(report),
    report,
    generatedAt,
  });
  return { status: inserted ? "written" : "exists", week: week.key, postId };
}

export type FleetView = { week: string | null; text: string; report: FleetReport | null };

/** Owner read path for the HQ chat and `GET /api/board?view=fleet`. Reads only; never generates. */
export async function readFleetView(db: FleetReportStore | undefined, week: string | null | undefined): Promise<FleetView> {
  if (week && !WEEK_KEY.test(week)) return { week: null, text: "Unknown week. Use a key like 2026-W40.", report: null };
  const row = db ? (week ? await db.getReport(week) : await db.latestReport()) : null;
  if (!row) return { week: null, text: week ? `No fleet report for ${week}.` : NO_REPORT, report: null };
  return { week: row.week, text: row.text, report: row.report };
}

export async function fleetChatAnswer(db: FleetReportStore | undefined): Promise<string> {
  return (await readFleetView(db, null)).text;
}

export function fleetEventResult(row: StoredFleetReport): Record<string, unknown> {
  const t = row.report.totals;
  return {
    status: "written",
    week: row.week,
    postId: row.id,
    launched: t.agents.launched,
    refused: t.refused,
    councilSeats: t.council.seatsUsed,
  };
}

/** In-memory store over a ConnectorStore, for tests and the no-database mode. */
export function createMemoryFleetReports(connector: ConnectorStore): FleetDb {
  const reports = new Map<string, StoredFleetReport>();
  return {
    async eventsBetween(start, end) {
      const from = Date.parse(start);
      const to = Date.parse(end);
      return (await connector.listEvents()).filter((item) => {
        const at = Date.parse(item.at);
        return at >= from && at < to;
      });
    },
    listBots: () => connector.listBots(),
    listPosts: () => connector.listPosts(),
    async getReport(week) {
      return reports.get(week) ?? null;
    },
    async latestReport() {
      const key = [...reports.keys()].sort().at(-1);
      return key ? (reports.get(key) ?? null) : null;
    },
    async insertReportOnce(row) {
      // Check and claim before any await, so concurrent callers cannot both win.
      if (reports.has(row.week)) return false;
      reports.set(row.week, row);
      await connector.savePost({
        id: row.id,
        ownerId: row.ownerId,
        type: "alert",
        author: SYSTEM_ACTOR,
        body: row.text,
        repo: null,
        verified: false,
      });
      await connector.appendEvent({
        ownerId: row.ownerId,
        actor: SYSTEM_ACTOR,
        action: "fleet_report",
        target: row.week,
        result: fleetEventResult(row),
        at: row.generatedAt,
      });
      return true;
    },
  };
}
