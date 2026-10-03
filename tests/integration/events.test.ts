import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { insertRequest, newPool, withUser } from "./db.ts";

let pool: pg.Pool;

beforeAll(() => {
  pool = newPool();
});

afterAll(async () => {
  await pool.end();
});

describe("append-only events", () => {
  it("rejects updates and deletes, and hides rows from another owner", async () => {
    const client = await pool.connect();
    const owner = randomUUID();
    const other = randomUUID();
    try {
      const requestId = await withUser(client, owner, () => insertRequest(client, owner, null));
      const taskId = await withUser(client, owner, async () => {
        const { rows } = await client.query<{ id: string }>(
          `insert into public.tasks (owner_id, request_id, persona, role) values ($1, $2, 'maker', 'builder') returning id`,
          [owner, requestId],
        );
        return rows[0]?.id ?? "";
      });
      await withUser(client, owner, () => client.query("select id from public.claim_ready_tasks(1)"));
      const event = await client.query<{ id: string }>(
        "select id from public.events where target = $1 and action = 'task.claim'",
        [taskId],
      );
      const eventId = event.rows[0]?.id ?? "";
      expect(eventId).not.toBe("");

      await expect(client.query("update public.events set action = 'rewritten' where id = $1", [eventId])).rejects.toThrow(
        /events_append_only/,
      );
      await expect(client.query("delete from public.events where id = $1", [eventId])).rejects.toThrow(/events_append_only/);

      const hidden = await withUser(client, other, async () => {
        const { rows } = await client.query("select id from public.events where id = $1", [eventId]);
        return rows.length;
      });
      expect(hidden).toBe(0);
      await expect(
        withUser(client, other, () =>
          client.query(
            "insert into public.events (owner_id, actor, action, target) values ($1, 'x', 'y', 'z')",
            [other],
          ),
        ),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });
});
