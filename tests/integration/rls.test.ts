import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { insertRequest, newPool, withUser } from "./db.ts";

const ownerA = randomUUID();
const ownerB = randomUUID();
let pool: pg.Pool;

beforeAll(() => {
  pool = newPool();
});

afterAll(async () => {
  await pool.end();
});

async function visible(client: pg.PoolClient, table: string, idColumn: string, id: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `select count(*)::text as n from public.${table} where ${idColumn} = $1`,
    [id],
  );
  return Number(rows[0]?.n ?? 0);
}

describe("owner isolation", () => {
  it("hides and rejects another owner's rows on every owned table", async () => {
    const client = await pool.connect();
    try {
      const requestId = await withUser(client, ownerA, async () => insertRequest(client, ownerA, "sketch"));
      const taskId = await withUser(client, ownerA, async () => {
        const { rows } = await client.query<{ id: string }>(
          `insert into public.tasks (owner_id, request_id, persona, role) values ($1, $2, 'maker', 'builder') returning id`,
          [ownerA, requestId],
        );
        return rows[0]?.id ?? "";
      });
      const runId = await withUser(client, ownerA, async () => {
        const { rows } = await client.query<{ id: string }>(
          `insert into public.runs (owner_id, task_id, runtime, status) values ($1, $2, 'fake', 'queued') returning id`,
          [ownerA, taskId],
        );
        return rows[0]?.id ?? "";
      });

      const rows: { table: string; id: string }[] = [
        { table: "requests", id: requestId },
        { table: "tasks", id: taskId },
        { table: "runs", id: runId },
      ];

      const more: { table: string; sql: string; params: unknown[] }[] = [
        { table: "posts", sql: "insert into public.posts (owner_id, type, author) values ($1, 'finding', 'a') returning id", params: [ownerA] },
        { table: "artifacts", sql: "insert into public.artifacts (owner_id, type, content_hash, location, producer) values ($1, 'file', 'h', 'mem', 'a') returning id", params: [ownerA] },
        { table: "approvals", sql: "insert into public.approvals (owner_id, request_id, action, target, plan_version, sketch_hash) values ($1, $2, 'design', 'screen', 1, 'sketch') returning id", params: [ownerA, requestId] },
        { table: "memory_items", sql: "insert into public.memory_items (owner_id, scope, fact, provenance) values ($1, 'owner', 'fact', 'test') returning id", params: [ownerA] },
        { table: "capabilities", sql: "insert into public.capabilities (owner_id, name, permission_class, availability) values ($1, 'fetch', 'green', 'ready') returning id", params: [ownerA] },
        { table: "schedules", sql: "insert into public.schedules (owner_id, cron) values ($1, '0 * * * *') returning id", params: [ownerA] },
        { table: "messages", sql: "insert into public.messages (owner_id, role, body) values ($1, 'owner', 'hi') returning id", params: [ownerA] },
        { table: "model_catalog", sql: "insert into public.model_catalog (owner_id, family, version, variant, price_per_token, pool) values ($1, 'alpha', '1', 'standard', 1, 'p1') returning id", params: [ownerA] },
        { table: "model_resolutions", sql: "insert into public.model_resolutions (owner_id, family, version) values ($1, 'alpha', '1') returning id", params: [ownerA] },
        { table: "model_outcomes", sql: "insert into public.model_outcomes (owner_id, passed) values ($1, true) returning id", params: [ownerA] },
      ];

      for (const entry of more) {
        const id = await withUser(client, ownerA, async () => {
          const { rows: inserted } = await client.query<{ id: string }>(entry.sql, entry.params);
          return inserted[0]?.id ?? "";
        });
        rows.push({ table: entry.table, id });
      }

      await withUser(client, ownerA, () =>
        client.query("insert into public.control (owner_id, slot_cap) values ($1, 3)", [ownerA]),
      );
      await withUser(client, ownerA, () =>
        client.query(
          "insert into public.pool_usage (owner_id, pool, week_start, weekly_cap) values ($1, 'p3', date_trunc('week', now()), 10)",
          [ownerA],
        ),
      );

      await withUser(client, ownerB, async () => {
        for (const entry of rows) {
          expect(await visible(client, entry.table, "id", entry.id)).toBe(0);
          const updated = await client.query(`update public.${entry.table} set owner_id = owner_id where id = $1`, [entry.id]);
          expect(updated.rowCount).toBe(0);
          const deleted = await client.query(`delete from public.${entry.table} where id = $1`, [entry.id]);
          expect(deleted.rowCount).toBe(0);
        }
        const control = await client.query("select owner_id from public.control where owner_id = $1", [ownerA]);
        expect(control.rowCount).toBe(0);
        const usage = await client.query("select owner_id from public.pool_usage where owner_id = $1", [ownerA]);
        expect(usage.rowCount).toBe(0);
        await expect(
          client.query(
            "insert into public.requests (owner_id, goal, crew, tier, definition_of_done) values ($1, 'x', 'answer', 'T1', 'y')",
            [ownerA],
          ),
        ).rejects.toThrow();
      });

      await withUser(client, ownerA, async () => {
        expect(await visible(client, "requests", "id", requestId)).toBe(1);
      });
    } finally {
      client.release();
    }
  });
});
