import { describe, expect, it } from "vitest";
import { pgConfig } from "../../hq/snapshot-db.ts";

describe("pgConfig", () => {
  it("sends a direct Supabase host through the IPv4 pooler", () => {
    const config = pgConfig("postgresql://postgres:p%40ss@db.exampleproject.supabase.co:5432/postgres");
    expect(config).toMatchObject({
      host: "aws-0-us-west-1.pooler.supabase.com",
      port: 5432,
      user: "postgres.exampleproject",
      password: "p@ss",
      database: "postgres",
      ssl: { rejectUnauthorized: false },
    });
    expect(config).not.toHaveProperty("connectionString");
  });

  it("leaves other databases on their connection string", () => {
    const url = "postgresql://postgres:secret@127.0.0.1:54329/dexter_g2";
    expect(pgConfig(url)).toEqual({ connectionString: url });
  });
});
