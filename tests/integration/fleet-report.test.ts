import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { buildFleetReport, fleetReportId, renderFleetReport, type StoredFleetReport } from "../../hq/fleet-report.ts";
import { createPgFleetReports } from "../../hq/fleet-report-pg.ts";
import { databaseUrl, newPool } from "./db.ts";

let pool: pg.Pool;

beforeAll(() => {
  pool = newPool();
});

afterAll(async () => {
  await pool.end();
});

function stored(week: string, ownerId: string): StoredFleetReport {
  const span = { key: week, start: "2026-09-28T07:00:00.000Z", end: "2026-10-05T07:00:00.000Z" };
  const report = buildFleetReport({ week: span, events: [], bots: [], posts: [], generatedAt: "2026-10-08T09:00:00.000Z" });
  return { id: fleetReportId(week), week, ownerId, text: renderFleetReport(report), report, generatedAt: report.generatedAt };
}

function randomWeek(): string {
  // Events are append-only, so each run uses a fresh week key in a far-future year.
  const year = 3000 + Math.floor(Math.random() * 6000);
  return `${year}-W${String(1 + Math.floor(Math.random() * 52)).padStart(2, "0")}`;
}

describe("fleet report on Postgres", () => {
  it("inserts one post and one fleet_report event per week, even when two writers race", async () => {
    const db = createPgFleetReports(databaseUrl());
    const owner = randomUUID();
    const week = randomWeek();
    const row = stored(week, owner);
    const results = await Promise.all([db.insertReportOnce(row), db.insertReportOnce(row), db.insertReportOnce(row)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.insertReportOnce(row)).toBe(false);
    const posts = await pool.query("select type, author, owner_id, evidence from public.posts where id = $1", [row.id]);
    expect(posts.rows).toHaveLength(1);
    expect(posts.rows[0]).toMatchObject({ type: "alert", author: "hq", owner_id: owner });
    expect(posts.rows[0].evidence).toMatchObject({ kind: "fleet_report", week, scope: "shared", repo: null });
    const events = await pool.query("select actor, result from public.events where action = 'fleet_report' and target = $1", [week]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ actor: "hq", result: { status: "written", week, postId: row.id } });
  });

  it("round-trips the stored report and finds the latest week", async () => {
    const db = createPgFleetReports(databaseUrl());
    const owner = randomUUID();
    const week = randomWeek();
    await db.insertReportOnce(stored(week, owner));
    const read = await db.getReport(week);
    expect(read).toMatchObject({ id: fleetReportId(week), week, ownerId: owner });
    expect(read?.report.totals.requests).toEqual({ opened: 0, done: 0, blocked: 0, failed: 0 });
    expect(read?.text).toContain(`Fleet report ${week}`);
    expect(await db.getReport(randomWeek() + "x")).toBeNull();
    await db.insertReportOnce(stored("9999-W53", owner));
    expect((await db.latestReport())?.week).toBe("9999-W53");
  });

  it("reads events in [start, end) only", async () => {
    const db = createPgFleetReports(databaseUrl());
    const owner = randomUUID();
    const target = randomUUID();
    const times = ["1990-01-01T07:59:59.999Z", "1990-01-01T08:00:00.000Z", "1990-01-08T07:59:59.999Z", "1990-01-08T08:00:00.000Z"];
    for (const at of times) {
      await pool.query(
        "insert into public.events (owner_id, actor, action, target, result, at) values ($1, 'x', 'probe', $2, $3::jsonb, $4::timestamptz)",
        [owner, target, { at }, at],
      );
    }
    const found = (await db.eventsBetween("1990-01-01T08:00:00.000Z", "1990-01-08T08:00:00.000Z")).filter(
      (item) => item.target === target,
    );
    expect(found.map((item) => item.at)).toEqual(["1990-01-01T08:00:00.000Z", "1990-01-08T07:59:59.999Z"]);
  });
});
