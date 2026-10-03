/**
 * Encrypts ~/.codex/auth.json with the HQ age public key and stores only the
 * ciphertext in Supabase Vault. Never prints the login or the private key.
 * Run: node --experimental-strip-types scripts/ceo-auth-store.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const AUTH = join(process.env.HOME ?? "", ".codex/auth.json");
const PUBLIC_KEY = join(process.env.HOME ?? "", ".dexter/hq-age.pub");
const POOLER_HOST = "aws-0-us-west-1.pooler.supabase.com";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of readFileSync(".env.local", "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return env;
}

async function main() {
  const env = loadEnv();
  if (!env.SUPABASE_DB_URL || !env.NEXT_PUBLIC_SUPABASE_URL) {
    console.log("missing_db_or_url_name");
    process.exit(2);
  }
  const mode = statSync(AUTH).mode & 0o777;
  if (mode !== 0o600) {
    console.log("auth_mode", mode.toString(8));
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "dexter-age-"));
  const cipherPath = join(dir, "auth.json.age");
  const encrypted = spawnSync("age", ["-a", "-r", readFileSync(PUBLIC_KEY, "utf8").trim(), "-o", cipherPath, AUTH], { encoding: "utf8" });
  if (encrypted.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    console.log("age_exit", encrypted.status ?? 1);
    process.exit(1);
  }
  const ciphertext = readFileSync(cipherPath);
  rmSync(dir, { recursive: true, force: true });
  const header = ciphertext.subarray(0, 32).toString("utf8");
  if (!header.includes("age-encryption") && !header.includes("BEGIN AGE")) {
    console.log("ciphertext_header_mismatch");
    process.exit(1);
  }

  const source = new URL(env.SUPABASE_DB_URL);
  const projectRef = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  const client = new pg.Client({
    host: POOLER_HOST,
    port: 5432,
    user: `postgres.${projectRef}`,
    password: decodeURIComponent(source.password),
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const name = "codex_chatgpt_auth";
  const existing = await client.query("select id from vault.secrets where name = $1", [name]);
  let vaultId: string;
  if (existing.rows.length) {
    vaultId = existing.rows[0].id;
    await client.query("select vault.update_secret($1, $2, $3, $4)", [vaultId, ciphertext.toString("utf8"), name, "age ciphertext"]);
  } else {
    const created = await client.query("select vault.create_secret($1, $2, $3) as id", [ciphertext.toString("utf8"), name, "age ciphertext"]);
    vaultId = created.rows[0].id;
  }
  await client.end();
  console.log(JSON.stringify({ vault_id: vaultId, ciphertext_bytes: ciphertext.length, secret_name: name }));
}

main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "error";
  console.log("fatal", code);
  process.exit(1);
});
