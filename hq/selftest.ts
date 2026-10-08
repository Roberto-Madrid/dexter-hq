// Stage 3 unit 6: daily self-tests. Cheap, read-only checks run once per America/Tijuana day from the
// existing tick. Failures raise one Needs-you approval; the owner reads them from chat or
// GET /api/board?view=selftest. No new screen. Pin checks read `model_resolutions` the way launches do (hq/pins.ts).
import { createHash, timingSafeEqual } from "node:crypto";
import { readCatalogMatch } from "../gateway/catalog.ts";
import { parseRoleSheet } from "../kernel/role-sheet.ts";
import { SANDBOX_SLOT_CAP } from "../kernel/police.ts";
import {
  AGENT_SURGE_CAP,
  PER_REPO_CAP,
  callConnectorTool,
  createDefaultConnectorDeps,
  loadConnectorSheetText,
} from "./connector.ts";
import {
  MODEL_UPGRADE_ACTION,
  isActiveAgent,
  latestPins,
  modelUpgradeTarget,
  type ConnectorAgent,
  type ConnectorStore,
} from "./connector-store.ts";
import { redact } from "../kernel/redact.ts";

export const SELFTEST_CHECKS = [
  "database",
  "connector_whoami",
  "stop_state",
  "caps",
  "stuck_reserving",
  "long_running_agents",
  "tick_fresh",
  "tick_gaps",
  "checker_credential",
  "role_sheet",
  "pins_present",
  "held_versions",
] as const;

export type SelftestCheckName = (typeof SELFTEST_CHECKS)[number];
export type SelftestCheck = { name: SelftestCheckName; ok: boolean; detail: string };
export type SelftestRecord = {
  day: string;
  at: string;
  ok: boolean;
  failed: SelftestCheckName[];
  checks: SelftestCheck[];
};

export type SelftestTickResult =
  | { status: "ran"; day: string; ok: boolean; failed: SelftestCheckName[] }
  | { status: "already_ran"; day: string; ok: boolean; failed: SelftestCheckName[] }
  | { status: "not_due"; day: string }
  | { status: "not_configured" }
  | { status: "error" };

export type SelftestHealth = {
  ok: boolean;
  tickAgeSeconds: number | null;
  selfTestDay: string | null;
  selfTestOk: boolean | null;
  selfTestAgeHours: number | null;
  reasons: string[];
};

/** DB surface the self-test needs. The memory fake and the Postgres adapter both implement this. */
export interface SelftestDb {
  ping(): Promise<void>;
  /** Every `control.stop_all` value, in row order. More than one row is itself a defect. */
  controlRows(): Promise<boolean[]>;
  tokenSuspension(): Promise<{ total: number; suspended: number }>;
  /** Beats since `since` (ISO). `maxGapSeconds` is the largest gap from `since` through the last beat. */
  tickStats(since: string): Promise<{ lastBeatAt: string | null; maxGapSeconds: number | null }>;
  hasRun(day: string, since?: string): Promise<boolean>;
  latest(): Promise<SelftestRecord | null>;
  /** Inserts the day's event (and a Needs-you approval on failure). Returns false when the day already exists. */
  recordOnce(record: SelftestRecord): Promise<boolean>;
}

export const SELFTEST_DUE_HOUR_PT = 7;
export const STUCK_RESERVING_MS = 15 * 60_000;
export const LONG_RUNNING_MS = 6 * 60 * 60_000;
export const TICK_FRESH_SECONDS = 5 * 60;
export const TICK_GAP_SECONDS = 5 * 60;
export const SELFTEST_STALE_HOURS = 26;
export const WATCHDOG_TICK_STALE_SECONDS = 10 * 60;
const SELFTEST_QUESTION =
  /^(?:(?:show|give|read|get|send)(?: me)?\s+)?(?:(?:what(?:'s| is)|today'?s|the|our|latest)\s+)*(?:self[-\s]?tests?|health checks?)\b/i;

/** Deterministic approval id so a failed day raises exactly one Needs-you card across reruns. */
export function alertApprovalId(day: string): string {
  const hex = createHash("sha256").update(`self_test:${day}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function ptCalendar(now: Date): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Tijuana",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { day: `${map.year}-${map.month}-${map.day}`, hour: Number(map.hour) % 24 };
}

export function isSelftestQuestion(text: string): boolean {
  return SELFTEST_QUESTION.test(text.trim());
}

function check(name: SelftestCheckName, ok: boolean, detail: string): SelftestCheck {
  return { name, ok, detail };
}

function ageMs(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(0, now.getTime() - at);
}

function activeAgents(agents: ConnectorAgent[]): ConnectorAgent[] {
  return agents.filter((agent) => isActiveAgent(agent.status));
}

/** An error code when the driver gives one; otherwise a short redacted message. Never a connection string. */
function safeError(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return `error ${(error as { code: string }).code}`;
  }
  const message = error instanceof Error ? error.message : fallback;
  return redact(message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[db]")).slice(0, 80);
}

/**
 * `pins_present` and `held_versions`, read the way launches read them. The required families are the role sheet's
 * `catalog_match` families (the ones the daily check in hq/pins.ts resolves). A launch uses the latest non-held
 * `model_resolutions` row of its family and refuses `model_held` when there is none, so:
 * - pins_present fails when an owner has no rows, or no non-held pin for a required family;
 * - held_versions fails when a family has only held rows (every launch of it is refused), or when a held version that is
 *   not the pin has no `model_upgrade` card (the owner can never approve it).
 */
async function pinChecks(connector: ConnectorStore, sheetText: string | null): Promise<SelftestCheck[]> {
  let families: string[];
  try {
    if (sheetText === null) throw new Error("role sheet unreadable");
    families = [...new Set(readCatalogMatch(sheetText).map((row) => row.family))];
  } catch (error) {
    const detail = safeError(error, "catalog_match_unreadable");
    return [check("pins_present", false, detail), check("held_versions", false, detail)];
  }
  if (families.length === 0) {
    const detail = "role sheet has no catalog_match families";
    return [check("pins_present", false, detail), check("held_versions", false, detail)];
  }

  try {
    const owners = [...new Set((await connector.listBots()).map((bot) => bot.ownerId))].sort();
    if (owners.length === 0) {
      const detail = "no bots, so no model_resolutions rows";
      return [check("pins_present", false, detail), check("held_versions", true, "none held")];
    }
    const approvals = (await connector.listApprovals()).filter((row) => row.action === MODEL_UPGRADE_ACTION);
    const empty: string[] = [];
    const missing = new Set<string>();
    const heldOnly = new Set<string>();
    const noCard = new Set<string>();
    let awaiting = 0;
    for (const ownerId of owners) {
      const rows = await connector.listModelResolutions(ownerId);
      if (rows.length === 0) {
        empty.push(ownerId);
        continue;
      }
      const pinned = new Map(latestPins(rows).map((pin) => [pin.family, pin.version]));
      for (const family of families) {
        if (pinned.has(family)) continue;
        missing.add(family);
        if (rows.some((row) => row.family === family && row.held)) heldOnly.add(family);
      }
      const waiting = new Set(
        rows.filter((row) => row.held && pinned.get(row.family) !== row.version).map((row) => modelUpgradeTarget(row)),
      );
      for (const target of waiting) {
        const cards = approvals.filter((row) => row.ownerId === ownerId && row.target === target);
        if (cards.length === 0) noCard.add(target);
        else if (cards.some((row) => row.status === "pending")) awaiting += 1;
      }
    }

    const pinProblems: string[] = [];
    if (empty.length > 0) pinProblems.push(`no model_resolutions rows for ${empty.length} owner(s)`);
    if (missing.size > 0) pinProblems.push(`no pin for ${[...missing].join(", ")}`);
    const pinsPresent =
      pinProblems.length === 0
        ? check("pins_present", true, `${families.length} famil${families.length === 1 ? "y" : "ies"} pinned for ${owners.length} owner(s)`)
        : check("pins_present", false, pinProblems.join("; "));

    const heldProblems: string[] = [];
    if (heldOnly.size > 0) heldProblems.push(`model_held: ${[...heldOnly].join(", ")} has only held versions`);
    if (noCard.size > 0) heldProblems.push(`no Needs-you card for ${[...noCard].join(", ")}`);
    const heldVersions =
      heldProblems.length > 0
        ? check("held_versions", false, heldProblems.join("; "))
        : check("held_versions", true, awaiting === 0 ? "none held" : `${awaiting} held version(s) awaiting the owner`);
    return [pinsPresent, heldVersions];
  } catch (error) {
    const detail = safeError(error, "pins_failed");
    return [check("pins_present", false, detail), check("held_versions", false, detail)];
  }
}

export async function runSelftestChecks(input: {
  db: SelftestDb;
  connector: ConnectorStore;
  env: Record<string, string | undefined>;
  now: Date;
  sheetText?: string;
  day: string;
}): Promise<SelftestRecord> {
  const { db, connector, env, now, day } = input;
  const checks: SelftestCheck[] = [];

  try {
    await db.ping();
    checks.push(check("database", true, "reachable"));
  } catch (error) {
    checks.push(check("database", false, `unreachable (${safeError(error, "ping_failed")})`));
  }

  try {
    const deps = createDefaultConnectorDeps({
      store: connector,
      cursorConfigured: false,
      cursor: null,
      checker: null,
      councilConfigured: false,
      usage: null,
    });
    const whoami = await callConnectorTool(deps, null, "whoami", {});
    const kind = whoami.structuredContent.kind;
    checks.push(check("connector_whoami", !whoami.isError && typeof kind === "string", `kind=${String(kind)}`));
  } catch (error) {
    const message = safeError(error, "whoami_failed");
    checks.push(check("connector_whoami", false, message));
  }

  try {
    const rows = await db.controlRows();
    const tokens = await db.tokenSuspension();
    const stoppedFlag = await connector.stopped();
    const anyStopped = rows.some(Boolean) || stoppedFlag;
    if (rows.length > 1) {
      checks.push(check("stop_state", false, `${rows.length} control rows (expected 1)`));
    } else if (anyStopped && tokens.suspended < tokens.total) {
      checks.push(check("stop_state", false, `STOP on with ${tokens.total - tokens.suspended} token(s) still active`));
    } else if (!anyStopped && tokens.suspended > 0) {
      checks.push(check("stop_state", false, `${tokens.suspended} token(s) suspended while STOP is off`));
    } else {
      checks.push(check("stop_state", true, rows.length === 0 ? "no control row" : anyStopped ? "stopped and suspended" : "running"));
    }
  } catch (error) {
    checks.push(check("stop_state", false, safeError(error, "stop_state_failed")));
  }

  try {
    const agents = await connector.listAgents();
    const active = activeAgents(agents);
    if (active.length > AGENT_SURGE_CAP) {
      checks.push(check("caps", false, `${active.length} active agents over surge cap ${AGENT_SURGE_CAP}`));
    } else {
      const byRepo = new Map<string, number>();
      for (const agent of active) {
        if (!agent.repo) continue;
        byRepo.set(agent.repo, (byRepo.get(agent.repo) ?? 0) + 1);
      }
      const over = [...byRepo.entries()].find(([, count]) => count > PER_REPO_CAP);
      if (over) checks.push(check("caps", false, `${over[0]} has ${over[1]} active (cap ${PER_REPO_CAP})`));
      else checks.push(check("caps", true, `${active.length} active (cap ${SANDBOX_SLOT_CAP}, surge ${AGENT_SURGE_CAP})`));
    }
  } catch (error) {
    checks.push(check("caps", false, safeError(error, "caps_failed")));
  }

  try {
    const agents = await connector.listAgents();
    const stuck = agents.filter((agent) => {
      if (agent.status !== "reserving") return false;
      const age = ageMs(agent.createdAt ?? null, now);
      return age !== null && age > STUCK_RESERVING_MS;
    });
    checks.push(
      check("stuck_reserving", stuck.length === 0, stuck.length === 0 ? "none" : `${stuck.length} reserving >15m`),
    );
  } catch (error) {
    checks.push(check("stuck_reserving", false, safeError(error, "stuck_failed")));
  }

  try {
    const agents = await connector.listAgents();
    const long = activeAgents(agents).filter((agent) => {
      const age = ageMs(agent.createdAt ?? null, now);
      return age !== null && age > LONG_RUNNING_MS;
    });
    checks.push(
      check("long_running_agents", long.length === 0, long.length === 0 ? "none" : `${long.length} active >6h`),
    );
  } catch (error) {
    checks.push(check("long_running_agents", false, safeError(error, "long_failed")));
  }

  try {
    const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const stats = await db.tickStats(since);
    const age = ageMs(stats.lastBeatAt, now);
    if (age === null) checks.push(check("tick_fresh", false, "no spike heartbeats"));
    else if (age / 1000 > TICK_FRESH_SECONDS) checks.push(check("tick_fresh", false, `last beat ${Math.round(age / 1000)}s ago`));
    else checks.push(check("tick_fresh", true, `last beat ${Math.round(age / 1000)}s ago`));

    if (stats.maxGapSeconds === null) checks.push(check("tick_gaps", false, "no beats in the last 24h"));
    else if (stats.maxGapSeconds > TICK_GAP_SECONDS) {
      checks.push(check("tick_gaps", false, `max gap ${Math.round(stats.maxGapSeconds)}s in the last 24h`));
    } else checks.push(check("tick_gaps", true, `max gap ${Math.round(stats.maxGapSeconds)}s`));
  } catch (error) {
    const message = safeError(error, "tick_failed");
    checks.push(check("tick_fresh", false, message));
    checks.push(check("tick_gaps", false, message));
  }

  {
    const missing = (["GH_HQ_TOKEN", "GH_WORKERS_REPO"] as const).filter((name) => !env[name]?.trim());
    // Names only: never write the value into the event.
    checks.push(
      check(
        "checker_credential",
        missing.length === 0,
        missing.length === 0 ? "GH_HQ_TOKEN and GH_WORKERS_REPO set" : `missing ${missing.join(", ")}`,
      ),
    );
  }

  let sheetText: string | null = null;
  try {
    sheetText = input.sheetText ?? loadConnectorSheetText();
    parseRoleSheet(sheetText);
    checks.push(check("role_sheet", true, "parsed"));
  } catch (error) {
    checks.push(check("role_sheet", false, safeError(error, "parse_failed")));
  }

  checks.push(...(await pinChecks(connector, sheetText)));

  const failed = checks.filter((item) => !item.ok).map((item) => item.name);
  return { day, at: now.toISOString(), ok: failed.length === 0, failed, checks };
}

// Idempotency lives in db.recordOnce (an advisory lock on Postgres); a losing racer reports already_ran.
export async function runDailySelftest(input: {
  db: SelftestDb;
  connector: ConnectorStore;
  env: Record<string, string | undefined>;
  now: Date;
  sheetText?: string;
}): Promise<SelftestTickResult> {
  const { day, hour } = ptCalendar(input.now);
  if (hour < SELFTEST_DUE_HOUR_PT) return { status: "not_due", day };

  // Cheap guard first so the per-minute tick does one indexed read after the day's run.
  if (await input.db.hasRun(day)) {
    const latest = await input.db.latest();
    return { status: "already_ran", day, ok: latest?.ok ?? true, failed: latest?.failed ?? [] };
  }
  const record = await runSelftestChecks({ ...input, day });
  if (!(await input.db.recordOnce(record))) {
    return { status: "already_ran", day, ok: record.ok, failed: record.failed };
  }
  return { status: "ran", day, ok: record.ok, failed: record.failed };
}

export async function selftestChatAnswer(db: SelftestDb | undefined, now: Date): Promise<string> {
  if (!db) return "Self-tests are not configured (no database).";
  let latest: SelftestRecord | null;
  try {
    latest = await db.latest();
  } catch {
    return "Self-tests are unreachable right now.";
  }
  if (!latest) return "No self-test has run yet today.";
  const ageHours = Math.floor((now.getTime() - Date.parse(latest.at)) / 3_600_000);
  const stale = ageHours >= SELFTEST_STALE_HOURS ? " (stale)" : "";
  if (latest.ok) {
    return `Self-test ${latest.day}: ${latest.checks.length} of ${latest.checks.length} passed${stale}.`;
  }
  return `Self-test ${latest.day}: failed (${latest.failed.join(", ")})${stale}.`;
}

export async function selftestHealth(db: SelftestDb, now: Date): Promise<SelftestHealth> {
  const reasons: string[] = [];
  let tickAgeSeconds: number | null = null;
  let selfTestDay: string | null = null;
  let selfTestOk: boolean | null = null;
  let selfTestAgeHours: number | null = null;
  try {
    await db.ping();
    const stats = await db.tickStats(new Date(now.getTime() - 24 * 60 * 60_000).toISOString());
    const age = ageMs(stats.lastBeatAt, now);
    tickAgeSeconds = age === null ? null : Math.round(age / 1000);
    if (tickAgeSeconds === null || tickAgeSeconds > WATCHDOG_TICK_STALE_SECONDS) reasons.push("tick_stale");
  } catch {
    reasons.push("db_unreachable");
    return { ok: false, tickAgeSeconds, selfTestDay, selfTestOk, selfTestAgeHours, reasons };
  }
  try {
    const latest = await db.latest();
    if (!latest) reasons.push("selftest_missing");
    else {
      selfTestDay = latest.day;
      selfTestOk = latest.ok;
      selfTestAgeHours = Math.floor((now.getTime() - Date.parse(latest.at)) / 3_600_000);
      if (!latest.ok) reasons.push("selftest_failed");
      if (selfTestAgeHours >= SELFTEST_STALE_HOURS) reasons.push("selftest_stale");
    }
  } catch {
    reasons.push("selftest_unreadable");
  }
  return { ok: reasons.length === 0, tickAgeSeconds, selfTestDay, selfTestOk, selfTestAgeHours, reasons };
}

/** Constant-time compare for the watchdog secret: both sides are hashed to equal length first. Empty fails closed. */
export function watchdogSecretMatches(header: string | null, expected: string): boolean {
  if (!expected || !header) return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(header), digest(expected));
}
