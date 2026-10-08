import pg from "pg";
import type { JobScanBrief } from "../kernel/job-scan.ts";
import { createPgConnectorStore } from "./connector-pg.ts";
import { JOB_SCAN_KIND, jobScanEventResult, jobScanId, type JobScanDb, type StoredJobScan } from "./job-scan.ts";
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

function storedFromRow(row: PostRow | undefined): StoredJobScan | null {
  if (!row) return null;
  const evidence = row.evidence && typeof row.evidence === "object" ? (row.evidence as Record<string, unknown>) : {};
  const brief = evidence.brief as JobScanBrief | undefined;
  if (evidence.kind !== JOB_SCAN_KIND || typeof evidence.week !== "string" || !brief || typeof brief !== "object") return null;
  return {
    id: row.id,
    week: evidence.week,
    ownerId: row.owner_id,
    text: typeof evidence.body === "string" ? evidence.body : "",
    brief,
    generatedAt: brief.generatedAt,
  };
}

const BRIEF_POSTS = `from public.posts where type = 'alert' and author = 'hq' and evidence->>'kind' = '${JOB_SCAN_KIND}'`;

/** Job scan storage on the existing `posts` and `events` tables. No migration. */
export function createPgJobScans(url: string): JobScanDb {
  const connector = createPgConnectorStore(url);
  return {
    // dexter-shortcut: reads every post and keeps the week's leads in memory, like the fleet report; upgrade path: a
    // created_at-bounded query once the board passes a few thousand rows.
    listPosts: () => connector.listPosts(),
    async listOwnerIds() {
      return [...new Set((await connector.listBots()).map((bot) => bot.ownerId))];
    },
    async getBrief(week) {
      return withClient(url, async (client) => {
        const found = await client.query<PostRow>(`select id, owner_id, evidence ${BRIEF_POSTS} and id = $1`, [jobScanId(week)]);
        return storedFromRow(found.rows[0]);
      });
    },
    async latestBrief() {
      return withClient(url, async (client) => {
        const found = await client.query<PostRow>(`select id, owner_id, evidence ${BRIEF_POSTS} order by evidence->>'week' desc limit 1`);
        return storedFromRow(found.rows[0]);
      });
    },
    async insertBriefOnce(row) {
      return withClient(url, async (client) => {
        await client.query("begin");
        try {
          const inserted = await client.query(
            `insert into public.posts (id, owner_id, type, author, evidence)
             values ($1, $2, 'alert', 'hq', $3::jsonb)
             on conflict (id) do nothing
             returning id`,
            [row.id, row.ownerId, { kind: JOB_SCAN_KIND, week: row.week, scope: "shared", body: row.text, repo: null, brief: row.brief }],
          );
          if (inserted.rowCount === 0) {
            await client.query("rollback");
            return false;
          }
          const result = jobScanEventResult(row);
          const helper = await client.query<{ ok: boolean }>(
            "select to_regprocedure('public.append_event(uuid,text,text,text,jsonb,jsonb,uuid)') is not null as ok",
          );
          if (helper.rows[0]?.ok) {
            await client.query("select public.append_event($1, 'hq', 'job_scan', $2, $3::jsonb, null, null)", [row.ownerId, row.week, result]);
          } else {
            await client.query(
              "insert into public.events (owner_id, actor, action, target, result) values ($1, 'hq', 'job_scan', $2, $3::jsonb)",
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
