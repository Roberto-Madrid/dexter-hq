import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { newPool, withUser } from "./db.ts";

let pool: pg.Pool;

beforeAll(() => {
  pool = newPool();
});

afterAll(async () => {
  await pool.end();
});

describe("caps", () => {
  it("never reserves more sandbox slots than the cap", async () => {
    const client = await pool.connect();
    const owner = randomUUID();
    try {
      const results: boolean[] = [];
      for (let i = 0; i < 5; i += 1) {
        const ok = await withUser(client, owner, async () => {
          const { rows } = await client.query<{ reserve_slot: boolean }>("select public.reserve_slot()");
          return rows[0]?.reserve_slot ?? false;
        });
        results.push(ok);
      }
      expect(results.filter(Boolean)).toHaveLength(3);
      const released = await withUser(client, owner, async () => {
        const { rows } = await client.query<{ release_slot: number }>("select public.release_slot()");
        return rows[0]?.release_slot;
      });
      expect(released).toBe(2);
    } finally {
      client.release();
    }
  });

  it("never lets concurrent reservations exceed the weekly cap", async () => {
    const owner = randomUUID();
    const cap = 4;
    async function once(): Promise<boolean> {
      const client = await pool.connect();
      try {
        return await withUser(client, owner, async () => {
          const { rows } = await client.query<{ reserve_pool_run: boolean }>(
            "select public.reserve_pool_run($1, $2)",
            ["weekly", cap],
          );
          return rows[0]?.reserve_pool_run ?? false;
        });
      } finally {
        client.release();
      }
    }
    const results = await Promise.all(Array.from({ length: 12 }, () => once()));
    expect(results.filter(Boolean)).toHaveLength(cap);
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ runs_reserved: number }>(
        "select runs_reserved from public.pool_usage where owner_id = $1 and pool = 'weekly'",
        [owner],
      );
      expect(rows[0]?.runs_reserved).toBe(cap);
    } finally {
      client.release();
    }
  });
});
