import pg from "pg";

// The direct db.<ref>.supabase.co host is IPv6-only. Vercel previews are IPv4.
const SUPABASE_POOLER_HOST = "aws-0-us-west-1.pooler.supabase.com";

export function pgConfig(url: string): pg.ClientConfig {
  const source = new URL(url);
  const match = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(source.hostname);
  if (!match) return { connectionString: url };
  return {
    host: SUPABASE_POOLER_HOST,
    port: 5432,
    user: `postgres.${match[1]}`,
    password: decodeURIComponent(source.password),
    database: source.pathname.replace(/^\//, "") || "postgres",
    ssl: { rejectUnauthorized: false },
  };
}

export async function readSnapshot(url: string): Promise<string | null> {
  const client = new pg.Client(pgConfig(url));
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
  const client = new pg.Client(pgConfig(url));
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
