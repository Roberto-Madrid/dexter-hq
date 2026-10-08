/**
 * Stage 0: one Critic seat through existing path B.
 * Run: node --experimental-strip-types scripts/prove-council-seat.ts
 * Never prints login files, private keys, or secret values.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EVIDENCE = ".agent-work/evidence/V6";
const REQUIRED = ["SUPABASE_DB_URL", "DEXTER_AGE_PRIVATE_KEY"] as const;

function fillEnv(): void {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const index = line.indexOf("=");
      const key = line.slice(0, index).trim();
      if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      let value = line.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) process.env[key] = value;
    }
  } catch {
    // Host env is enough when the file is absent.
  }
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, name), `${JSON.stringify(value, null, 2)}\n`);
}

function missingOwnerStep(missing: string[]): string {
  return [
    "Owner step missing: give this worker the existing path B ChatGPT login, or run this script where path B already works.",
    "",
    "Path B loads the Codex ChatGPT login from Supabase Vault (name `codex_chatgpt_auth`) and decrypts it with `DEXTER_AGE_PRIVATE_KEY`.",
    "Those names already exist on the Vercel preview and in `.env.example`. Do not create a new secret.",
    "",
    `This environment is missing: ${missing.join(", ")}.`,
    "",
    "Re-run `node --experimental-strip-types scripts/prove-council-seat.ts` on the Vercel preview host or a local checkout that already has `.env.local` for path B.",
  ].join("\n");
}

async function main(): Promise<void> {
  fillEnv();
  if (process.env.OPENAI_API_KEY) {
    const stop = {
      outcome: "stop",
      reason: "openai_api_key_set",
      openai_api_key_set: true,
      owner_step: "Unset OPENAI_API_KEY so this cannot become an API bill. Path B uses the ChatGPT login only.",
    };
    writeJson("council-seat.json", stop);
    console.log(JSON.stringify(stop));
    process.exit(2);
  }

  const missingLogin: string[] = [];
  if (!existsSync(".env.local") && !process.env.SUPABASE_DB_URL) missingLogin.push(".env.local");
  for (const name of REQUIRED) {
    if (!process.env[name]) missingLogin.push(name);
  }
  const missingRuntime: string[] = [];
  // The codex binary is fetched and hash-verified at runtime by hq/codex-bin.ts, so it is not a precondition here.
  if (!existsSync("gateway/role-sheet.yaml")) missingRuntime.push("gateway/role-sheet.yaml");

  if (missingLogin.length > 0) {
    const stop = {
      outcome: "stop",
      reason: "path_b_login_unavailable",
      openai_api_key_set: false,
      missing: missingLogin,
      missing_runtime: missingRuntime,
      owner_step: missingOwnerStep(missingLogin),
    };
    writeJson("council-seat.json", stop);
    writeFileSync(join(EVIDENCE, "council-seat-stop.md"), `${stop.owner_step}\n`);
    console.log(
      JSON.stringify({
        outcome: "stop",
        reason: stop.reason,
        missing: missingLogin,
        missing_runtime: missingRuntime,
        openai_api_key_set: false,
      }),
    );
    process.exit(2);
  }

  const { CRITIC_PACKET, parseCouncilVerdict, runCriticSeat } = await import("../hq/council-seat.ts");
  const verdict = await runCriticSeat({
    sheetText: readFileSync("gateway/role-sheet.yaml", "utf8"),
    packet: CRITIC_PACKET,
    dbUrl: process.env.SUPABASE_DB_URL ?? "",
  });
  const parsed = parseCouncilVerdict(verdict);
  const evidence = {
    outcome: "verdict",
    seat: "critic",
    path: "B",
    effort: "medium",
    openai_api_key_set: false,
    result: parsed.result,
    actions: parsed.actions,
  };
  writeJson("council-seat.json", evidence);
  console.log(JSON.stringify({ outcome: "verdict", seat: "critic", result: parsed.result, actions: parsed.actions.length }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "failed";
  const safe = message.replace(/eyJ[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/postgres(?:ql)?:\/\/\S+/gi, "[db]").slice(0, 300);
  const fail = { outcome: "error", error: safe, openai_api_key_set: false };
  writeJson("council-seat.json", fail);
  console.log(JSON.stringify(fail));
  process.exit(1);
});
