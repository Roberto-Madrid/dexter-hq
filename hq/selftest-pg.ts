// Postgres adapter for Stage 3 unit 6 self-tests. Events + approvals only; no migration.
import pg from "pg";
import { pgConfig } from "./snapshot-db.ts";
import { STUB_OWNER_ID } from "./connector.ts";
import { alertApprovalId, type SelftestDb, type SelftestRecord } from "./selftest.ts";

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(pgConfig(url));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function recordFromResult(day: string, at: string, result: unknown): SelftestRecord {
  const body = asRecord(result) ?? {};
  const checks = Array.isArray(body.checks)
    ? body.checks
        .map((item) => {
          const row = asRecord(item);
          if (!row || typeof row.name !== "string") return null;
          return { name: row.name as SelftestRecord["checks"][number]["name"], ok: row.ok === true, detail: String(row.detail ?? "") };
        })
        .filter((item): item is SelftestRecord["checks"][number] => item !== null)
    : [];
  const failed = Array.isArray(body.failed)
    ? body.failed.map((item) => String(item)).filter(Boolean)
    : checks.filter((item) => !item.ok).map((item) => item.name);
  return {
    day: typeof body.day === "string" ? body.day : day,
    at,
    ok: body.ok === true,
    failed: failed as SelftestRecord["failed"],
    checks,
  };
}

export function createPgSelftestDb(url: string): SelftestDb {
  return {
    async ping() {
      await withClient(url, (client) => client.query("select 1"));
    },
    async controlRows() {
      return withClient(url, async (client) => {
        const found = await client.query<{ stop_all: boolean }>("select stop_all from public.control order by owner_id");
        return found.rows.map((row) => row.stop_all);
      });
    },
    async tokenSuspension() {
      return withClient(url, async (client) => {
        const found = await client.query<{ total: string; suspended: string }>(
          "select count(*)::text as total, (count(*) filter (where suspended))::text as suspended from public.bot_tokens",
        );
        return { total: Number(found.rows[0]?.total ?? 0), suspended: Number(found.rows[0]?.suspended ?? 0) };
      });
    },
    async tickStats(since) {
      return withClient(url, async (client) => {
        const last = await client.query<{ beat_at: Date | string | null }>(
          "select max(beat_at) as beat_at from public.spike_heartbeats",
        );
        const lastBeatAt = last.rows[0]?.beat_at ? new Date(last.rows[0].beat_at).toISOString() : null;
        // Gaps from `since` through each beat; an empty window means no coverage of the last 24h.
        const gaps = await client.query<{ gap_s: number | null }>(
          `with windowed as (
             select beat_at from public.spike_heartbeats where beat_at > $1::timestamptz
             union all select $1::timestamptz
           ), ordered as (
             select beat_at, lag(beat_at) over (order by beat_at) as previous from windowed
           )
           select max(extract(epoch from (beat_at - previous)))::float as gap_s from ordered where previous is not null`,
          [since],
        );
        const gap = gaps.rows[0]?.gap_s;
        return { lastBeatAt, maxGapSeconds: gap == null ? null : Number(gap) };
      });
    },
    async hasRun(day) {
      return withClient(url, async (client) => {
        const found = await client.query(
          "select 1 from public.events where action = 'self_test' and target = $1 limit 1",
          [`self_test:${day}`],
        );
        return found.rows.length > 0;
      });
    },
    async latest() {
      return withClient(url, async (client) => {
        const found = await client.query<{ target: string; result: unknown; at: Date | string }>(
          "select target, result, at from public.events where action = 'self_test' order by at desc limit 1",
        );
        const row = found.rows[0];
        if (!row) return null;
        const day = row.target.startsWith("self_test:") ? row.target.slice("self_test:".length) : row.target;
        return recordFromResult(day, new Date(row.at).toISOString(), row.result);
      });
    },
    async recordOnce(record) {
      return withClient(url, async (client) => {
        await client.query("begin");
        try {
          await client.query("select pg_advisory_xact_lock(hashtext('dexter.selftest'))");
          const existing = await client.query(
            "select 1 from public.events where action = 'self_test' and target = $1 limit 1",
            [`self_test:${record.day}`],
          );
          if (existing.rows.length > 0) {
            await client.query("rollback");
            return false;
          }
          const owner = await client.query<{ owner_id: string }>(
            "select owner_id from public.bots where kind = 'ceo' order by created_at asc limit 1",
          );
          const ownerId = owner.rows[0]?.owner_id ?? STUB_OWNER_ID;
          const result = {
            day: record.day,
            ok: record.ok,
            failed: record.failed,
            checks: record.checks,
          };
          // append_event is the only write path for events (append-only; no fallback insert in this transaction).
          await client.query("select public.append_event($1, $2, 'self_test', $3, $4::jsonb, null, null)", [
            ownerId,
            "hq",
            `self_test:${record.day}`,
            result,
          ]);
          if (!record.ok) {
            // Needs you is driven by pending approvals (tower-model). One card per failed day.
            await client.query(
              `insert into public.approvals (id, owner_id, request_id, action, target, plan_version)
               values ($1, $2, null, $3, $4, 1)
               on conflict (id) do nothing`,
              [alertApprovalId(record.day), ownerId, `pending:self_test_failed`, `${record.day}: ${record.failed.join(", ")}`],
            );
          }
          await client.query("commit");
          return true;
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      });
    },
  };
}
