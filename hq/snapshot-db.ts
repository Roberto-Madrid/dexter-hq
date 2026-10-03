import pg from "pg";

export async function readSnapshot(url: string): Promise<string | null> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const found = await client.query<{ body: unknown }>("select body from dexter_hq.snapshot where id = 1");
    const body = found.rows[0]?.body;
    if (!body) return null;
    return JSON.stringify(body);
  } finally {
    await client.end();
  }
}

export async function writeSnapshot(url: string, raw: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `insert into dexter_hq.snapshot (id, body) values (1, $1::jsonb)
       on conflict (id) do update set body = excluded.body, updated_at = now()`,
      [raw],
    );
  } finally {
    await client.end();
  }
}
