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

async function seedTask(
  client: pg.PoolClient,
  owner: string,
  requestId: string,
  extra: { deps?: string[]; design?: boolean; priority?: number } = {},
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.tasks
       (owner_id, request_id, persona, role, dependencies, requires_design_approval, priority)
     values ($1, $2, 'maker', 'builder', $3, $4, $5)
     returning id`,
    [owner, requestId, extra.deps ?? [], extra.design ?? false, extra.priority ?? 0],
  );
  return rows[0]?.id ?? "";
}

describe("claim and transition", () => {
  it("uses skip locked, honors dependencies, the stop flag, the slot cap, and the design gate", async () => {
    const client = await pool.connect();
    const owner = randomUUID();
    try {
      const source = await client.query<{ prosrc: string }>(
        "select prosrc from pg_proc where proname = 'claim_ready_tasks'",
      );
      expect(source.rows[0]?.prosrc.toLowerCase()).toContain("skip locked");

      const requestId = await withUser(client, owner, () => insertRequest(client, owner, null));
      const blocked = await withUser(client, owner, () =>
        seedTask(client, owner, requestId, { design: true }),
      );
      const claimedBlocked = await withUser(client, owner, async () => {
        const { rows } = await client.query<{ id: string }>("select id from public.claim_ready_tasks(5)");
        return rows.map((row) => row.id);
      });
      expect(claimedBlocked).not.toContain(blocked);

      await withUser(client, owner, () =>
        client.query(
          `insert into public.approvals (owner_id, request_id, action, target, plan_version, sketch_hash)
           values ($1, $2, 'design', 'screen', 1, 'sketch')`,
          [owner, requestId],
        ),
      );
      await client.query("update public.requests set sketch_hash = 'sketch' where id = $1", [requestId]);
      const afterApproval = await withUser(client, owner, async () => {
        const { rows } = await client.query<{ id: string }>("select id from public.claim_ready_tasks(5)");
        return rows.map((row) => row.id);
      });
      expect(afterApproval).toContain(blocked);

      const owner2 = randomUUID();
      const request2 = await withUser(client, owner2, () => insertRequest(client, owner2, null));
      const first = await withUser(client, owner2, () => seedTask(client, owner2, request2, { priority: 0 }));
      const second = await withUser(client, owner2, () =>
        seedTask(client, owner2, request2, { deps: [first], priority: 1 }),
      );
      const onlyFirst = await withUser(client, owner2, async () => {
        const { rows } = await client.query<{ id: string }>("select id from public.claim_ready_tasks(10)");
        return rows.map((row) => row.id);
      });
      expect(onlyFirst).toContain(first);
      expect(onlyFirst).not.toContain(second);
      await client.query("update public.tasks set state = 'done' where id = $1", [first]);
      const thenSecond = await withUser(client, owner2, async () => {
        const { rows } = await client.query<{ id: string }>("select id from public.claim_ready_tasks(10)");
        return rows.map((row) => row.id);
      });
      expect(thenSecond).toContain(second);

      const owner3 = randomUUID();
      const request3 = await withUser(client, owner3, () => insertRequest(client, owner3, null));
      await withUser(client, owner3, async () => {
        await seedTask(client, owner3, request3);
        await seedTask(client, owner3, request3);
        await client.query(
          `insert into public.control (owner_id, slot_cap) values ($1, 1)
           on conflict (owner_id) do update set slot_cap = 1`,
          [owner3],
        );
      });
      const capped = await withUser(client, owner3, async () => {
        const { rows } = await client.query<{ id: string }>("select id from public.claim_ready_tasks(10)");
        return rows.length;
      });
      expect(capped).toBe(1);

      const owner4 = randomUUID();
      const request4 = await withUser(client, owner4, () => insertRequest(client, owner4, null));
      await withUser(client, owner4, async () => {
        await seedTask(client, owner4, request4);
        await client.query(
          `insert into public.control (owner_id, stop_all) values ($1, true)
           on conflict (owner_id) do update set stop_all = true`,
          [owner4],
        );
      });
      const stopped = await withUser(client, owner4, async () => {
        const { rows } = await client.query("select id from public.claim_ready_tasks(10)");
        return rows.length;
      });
      expect(stopped).toBe(0);
    } finally {
      client.release();
    }
  });

  it("rejects a stale generation and leaves no event when the transition fails", async () => {
    const client = await pool.connect();
    const owner = randomUUID();
    try {
      const requestId = await withUser(client, owner, () => insertRequest(client, owner, null));
      const taskId = await withUser(client, owner, () => seedTask(client, owner, requestId));
      await withUser(client, owner, async () => {
        await client.query("select id from public.claim_ready_tasks(1)");
      });
      const before = await client.query<{ n: string }>(
        "select count(*)::text as n from public.events where target = $1 and action = 'task.transition'",
        [taskId],
      );
      await expect(
        withUser(client, owner, () => client.query("select public.transition_task($1, 0, 'working', 'kernel')", [taskId])),
      ).rejects.toThrow(/stale_generation/);
      await expect(
        withUser(client, owner, () => client.query("select public.transition_task($1, 1, 'done', 'kernel')", [taskId])),
      ).rejects.toThrow(/illegal_transition/);
      const after = await client.query<{ n: string }>(
        "select count(*)::text as n from public.events where target = $1 and action = 'task.transition'",
        [taskId],
      );
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

      const eventId = await withUser(client, owner, async () => {
        const { rows } = await client.query<{ transition_task: string }>(
          "select public.transition_task($1, 1, 'working', 'kernel')",
          [taskId],
        );
        return rows[0]?.transition_task;
      });
      expect(eventId).toBeTruthy();
      const written = await client.query<{ n: string }>(
        "select count(*)::text as n from public.events where target = $1 and action = 'task.transition'",
        [taskId],
      );
      expect(written.rows[0]?.n).toBe("1");
      await expect(
        withUser(client, owner, () => client.query("select public.transition_task($1, 1, 'in_review', 'kernel')", [taskId])),
      ).rejects.toThrow(/stale_generation/);
      const still = await client.query<{ n: string }>(
        "select count(*)::text as n from public.events where target = $1 and action = 'task.transition'",
        [taskId],
      );
      expect(still.rows[0]?.n).toBe("1");

      await expect(
        withUser(client, owner, () =>
          client.query("select public.transition_task($1, null, 'working', 'kernel')", [taskId]),
        ),
      ).rejects.toThrow(/stale_generation/);
      const afterNull = await client.query<{ n: string }>(
        "select count(*)::text as n from public.events where target = $1 and action = 'task.transition'",
        [taskId],
      );
      expect(afterNull.rows[0]?.n).toBe(still.rows[0]?.n);
      await expect(
        withUser(client, owner, () => client.query("update public.tasks set state = 'failed' where id = $1", [taskId])),
      ).rejects.toThrow(/direct_task_mutation/);

      const renewed = await withUser(client, owner, async () => {
        const { rows } = await client.query<{ renew_lease: string }>(
          "select public.renew_lease($1, 2)",
          [taskId],
        );
        return rows[0]?.renew_lease;
      });
      expect(renewed).toBeTruthy();
    } finally {
      client.release();
    }
  });

  it("gives concurrent claimers disjoint tasks", async () => {
    const owner = randomUUID();
    const setup = await pool.connect();
    const requestId = await withUser(setup, owner, () => insertRequest(setup, owner, null));
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await withUser(setup, owner, () => seedTask(setup, owner, requestId, { priority: i })));
    }
    await withUser(setup, owner, () =>
      setup.query(
        `insert into public.control (owner_id, slot_cap) values ($1, 10)
         on conflict (owner_id) do update set slot_cap = 10`,
        [owner],
      ),
    );
    setup.release();

    async function claim(): Promise<string[]> {
      const client = await pool.connect();
      try {
        return await withUser(client, owner, async () => {
          const { rows } = await client.query<{ id: string }>("select id from public.claim_ready_tasks(4)");
          return rows.map((row) => row.id);
        });
      } finally {
        client.release();
      }
    }

    const [left, right] = await Promise.all([claim(), claim()]);
    const overlap = left.filter((id) => right.includes(id));
    expect(overlap).toEqual([]);
    expect(new Set([...left, ...right]).size).toBe(4);
    expect(ids.every((id) => left.includes(id) || right.includes(id))).toBe(true);
  });

  it("refuses to re-enter working when the slot cap is already full", async () => {
    const client = await pool.connect();
    const owner = randomUUID();
    try {
      const requestId = await withUser(client, owner, () => insertRequest(client, owner, null));
      const first = await withUser(client, owner, () => seedTask(client, owner, requestId, { priority: 0 }));
      await withUser(client, owner, () =>
        client.query(
          `insert into public.control (owner_id, slot_cap) values ($1, 1)
           on conflict (owner_id) do update set slot_cap = 1`,
          [owner],
        ),
      );
      await withUser(client, owner, () => client.query("select id from public.claim_ready_tasks(1)"));
      await withUser(client, owner, () => client.query("select public.transition_task($1, 1, 'working', 'kernel')", [first]));
      await withUser(client, owner, () => client.query("select public.transition_task($1, 2, 'in_review', 'kernel')", [first]));
      const second = await withUser(client, owner, () => seedTask(client, owner, requestId, { priority: 1 }));
      const claimed = await withUser(client, owner, async () => {
        const { rows } = await client.query<{ id: string }>("select id from public.claim_ready_tasks(1)");
        return rows.map((row) => row.id);
      });
      expect(claimed).toContain(second);
      const before = await client.query<{ n: string }>(
        "select count(*)::text as n from public.events where target = $1 and action = 'task.transition'",
        [first],
      );
      await expect(
        withUser(client, owner, () => client.query("select public.transition_task($1, 3, 'working', 'kernel')", [first])),
      ).rejects.toThrow(/slot_cap/);
      const after = await client.query<{ n: string }>(
        "select count(*)::text as n from public.events where target = $1 and action = 'task.transition'",
        [first],
      );
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    } finally {
      client.release();
    }
  });
});
