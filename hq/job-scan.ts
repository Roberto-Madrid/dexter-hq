import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { buildJobScanBrief, renderJobScanBrief, type JobScanBrief, type JobScanPrefs } from "../kernel/job-scan.ts";
import { bundledCrews } from "./bundled-assets.ts";
import type { ConnectorPost, ConnectorStore } from "./connector-store.ts";
import { WEEK_KEY, dueFleetWeek } from "./fleet-report.ts";

/**
 * Weekly job scan on the per-minute tick. It reads the week's job leads from the board (posted by the career persona),
 * ranks them with kernel/job-scan.ts, and writes one HQ alert post (kind `job_scan`) plus one `job_scan` event per PT
 * week. It never applies, messages, or launches anything.
 *
 * dexter-shortcut: the plan names no cadence for job scans, so this reuses the fleet report's (the week before, due
 * Monday 07:00 PT); upgrade path: read the cadence from a schedule row once the `automate` crew's schedules exist.
 */
export const JOB_SCAN_KIND = "job_scan";
const SYSTEM_ACTOR = "hq";
const CREW_FILE = "job-scan.yaml";
const NO_BRIEF = "No job scan yet. HQ writes one on the first tick after Monday 07:00 PT.";

export const DEFAULT_JOB_SCAN_PREFS: JobScanPrefs = { include: [], exclude: [], remoteOnly: false, minScore: 0, top: 10 };

export type StoredJobScan = { id: string; week: string; ownerId: string; text: string; brief: JobScanBrief; generatedAt: string };

export interface JobScanStore {
  getBrief(week: string): Promise<StoredJobScan | null>;
  latestBrief(): Promise<StoredJobScan | null>;
  /** Atomic: inserts the post and its `job_scan` event together, only when the week's id is new. */
  insertBriefOnce(row: StoredJobScan): Promise<boolean>;
}

export type JobScanDb = JobScanStore & {
  listPosts(): Promise<ConnectorPost[]>;
  listOwnerIds(): Promise<string[]>;
};

export type JobScanTickResult = { status: "not_due" } | { status: "written" | "exists"; week: string; postId: string; ranked?: number };

/** Deterministic uuid (v5 layout) per week, so a second write hits the posts primary key. */
export function jobScanId(week: string): string {
  const h = createHash("sha256").update(`dexter-hq:job-scan:${week}`).digest("hex");
  const variant = ((parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Preferences live in the crew file (`prefs:`), which ships with the app bundle. Missing fields fall back to defaults. */
export function loadJobScanPrefs(dir = "crews"): JobScanPrefs {
  let text: string | null = null;
  try {
    text = readFileSync(join(dir, CREW_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    text = bundledCrews()?.[CREW_FILE] ?? null;
  }
  if (!text) return { ...DEFAULT_JOB_SCAN_PREFS };
  const raw = ((parse(text) as { prefs?: Record<string, unknown> }).prefs ?? {}) as Record<string, unknown>;
  return {
    include: list(raw.include),
    exclude: list(raw.exclude),
    remoteOnly: raw.remote_only === true,
    minScore: number(raw.min_score, DEFAULT_JOB_SCAN_PREFS.minScore),
    top: Math.max(1, Math.floor(number(raw.top, DEFAULT_JOB_SCAN_PREFS.top))),
  };
}

export function jobScanEventResult(row: StoredJobScan): Record<string, unknown> {
  return { status: "written", week: row.week, postId: row.id, collected: row.brief.collected, ranked: row.brief.ranked.length };
}

/** Called from the per-minute tick. Safe to repeat: the week's post id is fixed and only the first insert wins. */
export async function runJobScanTick(input: { db: JobScanDb; now: Date; prefs?: JobScanPrefs; ownerId?: string }): Promise<JobScanTickResult> {
  const week = dueFleetWeek(input.now);
  if (!week) return { status: "not_due" };
  const postId = jobScanId(week.key);
  if (await input.db.getBrief(week.key)) return { status: "exists", week: week.key, postId };
  const posts = await input.db.listPosts();
  const generatedAt = input.now.toISOString();
  const brief = buildJobScanBrief({ week, generatedAt, posts, prefs: input.prefs ?? loadJobScanPrefs() });
  const ownerId = input.ownerId ?? (await input.db.listOwnerIds())[0] ?? posts[0]?.ownerId ?? "00000000-0000-4000-8000-000000000000";
  const inserted = await input.db.insertBriefOnce({ id: postId, week: week.key, ownerId, text: renderJobScanBrief(brief), brief, generatedAt });
  return inserted ? { status: "written", week: week.key, postId, ranked: brief.ranked.length } : { status: "exists", week: week.key, postId };
}

export type JobScanView = { week: string | null; text: string; brief: JobScanBrief | null };

/** Owner read path for `GET /api/board?view=jobs`. Reads only; never generates. */
export async function readJobScanView(db: JobScanStore | undefined, week: string | null | undefined): Promise<JobScanView> {
  if (week && !WEEK_KEY.test(week)) return { week: null, text: "Unknown week. Use a key like 2026-W40.", brief: null };
  const row = db ? (week ? await db.getBrief(week) : await db.latestBrief()) : null;
  if (!row) return { week: null, text: week ? `No job scan for ${week}.` : NO_BRIEF, brief: null };
  return { week: row.week, text: row.text, brief: row.brief };
}

/** In-memory store over a ConnectorStore, for tests and the no-database mode. */
export function createMemoryJobScans(connector: ConnectorStore): JobScanDb {
  const briefs = new Map<string, StoredJobScan>();
  return {
    listPosts: () => connector.listPosts(),
    async listOwnerIds() {
      return [...new Set((await connector.listBots()).map((bot) => bot.ownerId))];
    },
    async getBrief(week) {
      return briefs.get(week) ?? null;
    },
    async latestBrief() {
      const key = [...briefs.keys()].sort().at(-1);
      return key ? (briefs.get(key) ?? null) : null;
    },
    async insertBriefOnce(row) {
      // Check and claim before any await, so concurrent callers cannot both win.
      if (briefs.has(row.week)) return false;
      briefs.set(row.week, row);
      await connector.savePost({
        id: row.id,
        ownerId: row.ownerId,
        type: "alert",
        author: SYSTEM_ACTOR,
        body: row.text,
        repo: null,
        verified: false,
        kind: JOB_SCAN_KIND,
        createdAt: row.generatedAt,
      });
      await connector.appendEvent({
        ownerId: row.ownerId,
        actor: SYSTEM_ACTOR,
        action: "job_scan",
        target: row.week,
        result: jobScanEventResult(row),
        at: row.generatedAt,
      });
      return true;
    },
  };
}
