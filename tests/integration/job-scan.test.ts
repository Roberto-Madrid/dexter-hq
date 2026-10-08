import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { jobScanId, type StoredJobScan } from "../../hq/job-scan.ts";
import { createPgJobScans } from "../../hq/job-scan-pg.ts";
import { buildJobScanBrief, renderJobScanBrief } from "../../kernel/job-scan.ts";
import { databaseUrl, newPool } from "./db.ts";

let pool: pg.Pool;

beforeAll(() => {
  pool = newPool();
});

afterAll(async () => {
  await pool.end();
});

function randomWeek(): string {
  // Events are append-only, so each run uses a fresh week key in a far-future year.
  const year = 3000 + Math.floor(Math.random() * 6000);
  return `${year}-W${String(1 + Math.floor(Math.random() * 52)).padStart(2, "0")}`;
}

function stored(week: string, ownerId: string): StoredJobScan {
  const span = { key: week, start: "2026-09-28T07:00:00.000Z", end: "2026-10-05T07:00:00.000Z" };
  const prefs = { include: ["ai"], exclude: [], remoteOnly: false, minScore: 0, top: 5 };
  const brief = buildJobScanBrief({ week: span, generatedAt: "2026-10-05T14:00:00.000Z", posts: [], prefs });
  return { id: jobScanId(week), week, ownerId, text: renderJobScanBrief(brief), brief, generatedAt: brief.generatedAt };
}

describe("job scan on Postgres", () => {
  it("inserts one brief post and one job_scan event per week, even when writers race, and reads it back", async () => {
    const db = createPgJobScans(databaseUrl());
    const owner = randomUUID();
    const week = randomWeek();
    const row = stored(week, owner);
    const results = await Promise.all([db.insertBriefOnce(row), db.insertBriefOnce(row), db.insertBriefOnce(row)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.insertBriefOnce(row)).toBe(false);
    const posts = await pool.query("select type, author, owner_id, evidence from public.posts where id = $1", [row.id]);
    expect(posts.rows).toHaveLength(1);
    expect(posts.rows[0]).toMatchObject({ type: "alert", author: "hq", owner_id: owner });
    expect(posts.rows[0].evidence).toMatchObject({ kind: "job_scan", week, scope: "shared", repo: null });
    const events = await pool.query("select actor, result from public.events where action = 'job_scan' and target = $1", [week]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ actor: "hq", result: { status: "written", week, postId: row.id, ranked: 0 } });
    expect(await db.getBrief(week)).toMatchObject({ id: row.id, week, ownerId: owner, brief: { outwardActions: [] } });
    expect(await db.getBrief(`${randomWeek()}x`)).toBeNull();
  });
});
