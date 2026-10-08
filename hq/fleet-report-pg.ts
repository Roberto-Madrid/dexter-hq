import pg from "pg";
import { createPgConnectorStore } from "./connector-pg.ts";
import type { ConnectorEvent } from "./connector-store.ts";
import { fleetEventResult, fleetReportId, type FleetDb, type FleetReport, type StoredFleetReport } from "./fleet-report.ts";
import { pgConfig } from "./snapshot-db.ts";

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(pgConfig(url));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

type PostRow = { id: string; owner_id: string; evidence: unknown };

function storedFromRow(row: PostRow | undefined): StoredFleetReport | null {
  if (!row) return null;
  const evidence = row.evidence && typeof row.evidence === "object" ? (row.evidence as Record<string, unknown>) : {};
  const report = evidence.report as FleetReport | undefined;
  if (evidence.kind !== "fleet_report" || typeof evidence.week !== "string" || !report || typeof report !== "object") return null;
  return {
    id: row.id,
    week: evidence.week,
    ownerId: row.owner_id,
    text: typeof evidence.body === "string" ? evidence.body : "",
    report,
    generatedAt: report.generatedAt,
  };
}

const REPORT_POSTS = "from public.posts where type = 'alert' and author = 'hq' and evidence->>'kind' = 'fleet_report'";

/** Fleet report storage on the existing `posts` and `events` tables. No migration. */
export function createPgFleetReports(url: string): FleetDb {
  const connector = createPgConnectorStore(url);
  return {
    listBots: () => connector.listBots(),
    listPosts: () => connector.listPosts(),
    async eventsBetween(start, end) {
      return withClient(url, async (client) => {
        const found = await client.query<{
          id: string;
          owner_id: string;
          actor: string;
          action: string;
          target: string;
          result: unknown;
          at: Date | string;
        }>(
          `select id, owner_id, actor, action, target, result, at from public.events
           where at >= $1::timestamptz and at < $2::timestamptz order by at asc`,
          [start, end],
        );
        return found.rows.map(
          (row): ConnectorEvent => ({
            id: row.id,
            ownerId: row.owner_id,
            actor: row.actor,
            action: row.action,
            target: row.target,
            result: row.result && typeof row.result === "object" && !Array.isArray(row.result) ? (row.result as Record<string, unknown>) : null,
            at: new Date(row.at).toISOString(),
          }),
        );
      });
    },
    async getReport(week) {
      return withClient(url, async (client) => {
        const found = await client.query<PostRow>(`select id, owner_id, evidence ${REPORT_POSTS} and id = $1`, [fleetReportId(week)]);
        return storedFromRow(found.rows[0]);
      });
    },
    async latestReport() {
      return withClient(url, async (client) => {
        const found = await client.query<PostRow>(`select id, owner_id, evidence ${REPORT_POSTS} order by evidence->>'week' desc limit 1`);
        return storedFromRow(found.rows[0]);
      });
    },
    async insertReportOnce(row) {
      return withClient(url, async (client) => {
        await client.query("begin");
        try {
          const inserted = await client.query(
            `insert into public.posts (id, owner_id, type, author, evidence)
             values ($1, $2, 'alert', 'hq', $3::jsonb)
             on conflict (id) do nothing
             returning id`,
            [row.id, row.ownerId, { kind: "fleet_report", week: row.week, scope: "shared", body: row.text, repo: null, report: row.report }],
          );
          if (inserted.rowCount === 0) {
            await client.query("rollback");
            return false;
          }
          const result = fleetEventResult(row);
          const helper = await client.query<{ ok: boolean }>(
            "select to_regprocedure('public.append_event(uuid,text,text,text,jsonb,jsonb,uuid)') is not null as ok",
          );
          if (helper.rows[0]?.ok) {
            await client.query("select public.append_event($1, 'hq', 'fleet_report', $2, $3::jsonb, null, null)", [row.ownerId, row.week, result]);
          } else {
            await client.query(
              "insert into public.events (owner_id, actor, action, target, result) values ($1, 'hq', 'fleet_report', $2, $3::jsonb)",
              [row.ownerId, row.week, result],
            );
          }
          await client.query("commit");
          return true;
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        }
      });
    },
  };
}
