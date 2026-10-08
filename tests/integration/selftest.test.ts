import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPgConnectorStore } from "../../hq/connector-pg.ts";
import { createPgSelftestDb } from "../../hq/selftest-pg.ts";
import { alertApprovalId, runSelftestChecks, type SelftestRecord } from "../../hq/selftest.ts";
import { databaseUrl, newPool } from "./db.ts";

// Day keys carry a run id so this suite can share the local database with other suites and reruns.
const run = randomUUID().slice(0, 8);
let pool: pg.Pool;

beforeAll(async () => {
  pool = newPool();
  // Local Postgres has no vault, so 0006 is not applied there; CI's Supabase has the real table.
  await pool.query(
    "create table if not exists public.spike_heartbeats (id bigint generated always as identity primary key, beat_at timestamptz not null default now())",
  );
});

afterAll(async () => {
  await pool.query("delete from public.approvals where target like $1", [`it-${run}%`]);
  await pool.end();
});

function record(day: string, ok: boolean): SelftestRecord {
  return {
    day,
    at: new Date().toISOString(),
    ok,
    failed: ok ? [] : ["tick_fresh"],
    checks: [{ name: "tick_fresh", ok, detail: ok ? "last beat 10s ago" : "last beat 900s ago" }],
  };
}

describe("self-test on Postgres", () => {
  it("reads control rows, token suspension and tick stats that match SQL", async () => {
    const db = createPgSelftestDb(databaseUrl());
    await db.ping();
    const control = await pool.query<{ n: number }>("select count(*)::int as n from public.control");
    expect((await db.controlRows()).length).toBe(control.rows[0]?.n);
    // Other integration files add bot tokens in parallel on the shared DB: bracket the read with SQL counts.
    const countTokens = async () =>
      (
        await pool.query<{ total: number; suspended: number }>(
          "select count(*)::int as total, (count(*) filter (where suspended))::int as suspended from public.bot_tokens",
        )
      ).rows[0]!;
    const before = await countTokens();
    const read = await db.tokenSuspension();
    const after = await countTokens();
    expect(read.total).toBeGreaterThanOrEqual(Math.min(before.total, after.total));
    expect(read.total).toBeLessThanOrEqual(Math.max(before.total, after.total));
    expect(read.suspended).toBeGreaterThanOrEqual(Math.min(before.suspended, after.suspended));
    expect(read.suspended).toBeLessThanOrEqual(Math.max(before.suspended, after.suspended));
    await pool.query("insert into public.spike_heartbeats default values");
    const stats = await db.tickStats(new Date(Date.now() - 24 * 3_600_000).toISOString());
    expect(Date.now() - Date.parse(stats.lastBeatAt ?? "1970-01-01")).toBeLessThan(10_000);
    expect(stats.maxGapSeconds).not.toBeNull();
  });

  it("records a day exactly once under concurrency, with one Needs-you approval when it failed", async () => {
    const db = createPgSelftestDb(databaseUrl());
    const day = `it-${run}-fail`;
    expect(await db.hasRun(day, new Date(Date.now() - 3_600_000).toISOString())).toBe(false);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => db.recordOnce(record(day, false))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.hasRun(day, new Date(Date.now() - 3_600_000).toISOString())).toBe(true);
    const events = await pool.query("select result from public.events where action = 'self_test' and target = $1", [`self_test:${day}`]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.result).toMatchObject({ day, ok: false, failed: ["tick_fresh"] });

    const approvals = await createPgConnectorStore(databaseUrl()).listApprovals();
    const alert = approvals.filter((row) => row.id === alertApprovalId(day));
    expect(alert).toHaveLength(1);
    expect(alert[0]).toMatchObject({ status: "pending", action: "self_test_failed", target: `${day}: tick_fresh` });

    const latest = await db.latest();
    expect(latest?.day).toBe(day);
  });

  it("writes no approval for a passing day and runs every check against Postgres", async () => {
    const db = createPgSelftestDb(databaseUrl());
    const day = `it-${run}-pass`;
    expect(await db.recordOnce(record(day, true))).toBe(true);
    const approvals = await pool.query("select id from public.approvals where id = $1", [alertApprovalId(day)]);
    expect(approvals.rows).toHaveLength(0);

    await pool.query("insert into public.spike_heartbeats default values");
    const checked = await runSelftestChecks({
      db,
      connector: createPgConnectorStore(databaseUrl()),
      env: { GH_HQ_TOKEN: "ghp_integration_value_not_real", GH_WORKERS_REPO: "o/w" },
      now: new Date(),
      sheetText: readFileSync("gateway/role-sheet.yaml", "utf8"),
      day: `it-${run}-checks`,
    });
    for (const name of ["database", "connector_whoami", "role_sheet", "checker_credential", "tick_fresh"]) {
      expect(checked.checks.find((item) => item.name === name)).toMatchObject({ ok: true });
    }
    // The pin checks read model_resolutions, bots and approvals from Postgres; their verdict depends on shared rows,
    // but the reads themselves must work (a driver error would surface as "error <code>").
    for (const name of ["pins_present", "held_versions"]) {
      const found = checked.checks.find((item) => item.name === name);
      expect(found).toBeDefined();
      expect(found?.detail).not.toMatch(/^error /);
    }
    expect(JSON.stringify(checked)).not.toContain("ghp_integration_value_not_real");
  });
});
