import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import pg from "pg";
import { pgConfig } from "./snapshot-db.ts";

const AUTH_PATH = "/tmp/.codex/auth.json";
const KEY_PATH = "/tmp/dexter-age.key";
const CIPHER_PATH = "/tmp/dexter-auth.age";
const PUBLIC_KEY_PATH = "workers/age.pub";
const SECRET_NAME = "codex_chatgpt_auth";

let vaultId = "";

export function loginKindFromText(text: string): "chatgpt" | "api_key" | "unknown" {
  if (text.includes("ChatGPT")) return "chatgpt";
  if (text.toLowerCase().includes("api key")) return "api_key";
  return "unknown";
}

function ageBin(): string {
  return "vendor/age/age";
}

function codexBin(): string {
  return "vendor/codex/codex";
}

function privateKey(): string {
  const raw = process.env.DEXTER_AGE_PRIVATE_KEY ?? "";
  if (!raw) throw new Error("age_key_missing");
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

async function withDb<T>(dbUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(pgConfig(dbUrl));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function loadCodexLogin(dbUrl: string): Promise<"chatgpt" | "api_key" | "unknown"> {
  const id = process.env.CEO_CHATGPT_AUTH_VAULT_ID || null;
  const row = await withDb(dbUrl, async (client) => {
    const found = id
      ? await client.query<{ id: string; decrypted_secret: string }>(
          "select id, decrypted_secret from vault.decrypted_secrets where id = $1",
          [id],
        )
      : await client.query<{ id: string; decrypted_secret: string }>(
          "select id, decrypted_secret from vault.decrypted_secrets where name = $1",
          [SECRET_NAME],
        );
    return found.rows[0];
  });
  if (!row?.decrypted_secret) throw new Error("codex_login_missing");
  vaultId = row.id;
  mkdirSync("/tmp/.codex", { recursive: true, mode: 0o700 });
  writeFileSync(KEY_PATH, privateKey(), { mode: 0o600 });
  writeFileSync(CIPHER_PATH, row.decrypted_secret, { mode: 0o600 });
  const decrypted = spawnSync(ageBin(), ["-d", "-i", KEY_PATH, "-o", AUTH_PATH, CIPHER_PATH], { encoding: "utf8" });
  rmSync(KEY_PATH, { force: true });
  rmSync(CIPHER_PATH, { force: true });
  if (decrypted.status !== 0) throw new Error("codex_login_decrypt_failed");
  chmodSync(AUTH_PATH, 0o600);
  const status = spawnSync(codexBin(), ["login", "status"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: "/tmp", CODEX_HOME: "/tmp/.codex", LANG: "C.UTF-8" },
  });
  return loginKindFromText(`${status.stdout ?? ""}\n${status.stderr ?? ""}`);
}

export async function storeCodexLogin(dbUrl: string): Promise<void> {
  if (!vaultId) throw new Error("codex_login_missing");
  const pub = readFileSync(PUBLIC_KEY_PATH, "utf8").trim();
  const encrypted = spawnSync(ageBin(), ["-a", "-r", pub, "-o", CIPHER_PATH, AUTH_PATH], { encoding: "utf8" });
  if (encrypted.status !== 0) throw new Error("codex_login_encrypt_failed");
  const ciphertext = readFileSync(CIPHER_PATH, "utf8");
  rmSync(CIPHER_PATH, { force: true });
  await withDb(dbUrl, (client) =>
    client.query("select vault.update_secret($1::uuid, $2, $3, $4)", [vaultId, ciphertext, SECRET_NAME, "age ciphertext"]),
  );
}
