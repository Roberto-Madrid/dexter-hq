import { readFileSync } from "node:fs";
import pg from "pg";

export function databaseUrl(): string {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  return readFileSync(".agent-work/tmp/integration-db-url", "utf8").trim();
}

export function newPool(): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl(), max: 12 });
}

export async function withUser<T>(
  client: pg.PoolClient,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
    const value = await fn();
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function insertRequest(client: pg.PoolClient, ownerId: string, sketch: string | null = null): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.requests (owner_id, goal, crew, tier, definition_of_done, sketch_hash)
     values ($1, 'goal', 'answer', 'T1', 'shown', $2) returning id`,
    [ownerId, sketch],
  );
  return rows[0]?.id ?? "";
}
