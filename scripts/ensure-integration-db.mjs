import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const urlFile = ".agent-work/tmp/integration-db-url";
if (process.env.SUPABASE_DB_URL) {
  console.log("using SUPABASE_DB_URL");
  process.exit(0);
}

const port = "54329";
const data = "/tmp/dexter-g2-pg";
const bin = "/usr/lib/postgresql/16/bin";
const url = `postgresql://ubuntu@127.0.0.1:${port}/dexter_g2`;

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(`${data}/PG_VERSION`)) {
  mkdirSync("/tmp", { recursive: true });
  run(`${bin}/initdb`, ["-D", data, "--username=ubuntu", "--auth=trust", "--no-instructions"]);
}

const ready = spawnSync(`${bin}/pg_isready`, ["-h", "127.0.0.1", "-p", port], { encoding: "utf8" });
if (ready.status !== 0) {
  run(`${bin}/pg_ctl`, ["-D", data, "-l", "/tmp/dexter-g2-pg.log", "-o", `-p ${port} -k /tmp`, "start"]);
}

const exists = spawnSync(`${bin}/psql`, ["-h", "127.0.0.1", "-p", port, "-d", "postgres", "-tAc", "select 1 from pg_database where datname = 'dexter_g2'"], { encoding: "utf8" });
if (exists.stdout.trim() !== "1") {
  run(`${bin}/createdb`, ["-h", "127.0.0.1", "-p", port, "dexter_g2"]);
  const files = [
    "scripts/integration-prelude.sql",
    "supabase/migrations/0001_core.sql",
    "supabase/migrations/0002_events.sql",
    "supabase/migrations/0003_claim.sql",
    "supabase/migrations/0004_slots.sql",
    "supabase/migrations/0005_role_sheet.sql",
  ];
  for (const file of files) {
    run(`${bin}/psql`, ["-h", "127.0.0.1", "-p", port, "-d", "dexter_g2", "-v", "ON_ERROR_STOP=1", "-f", file]);
  }
}

mkdirSync(".agent-work/tmp", { recursive: true });
writeFileSync(urlFile, `${url}\n`);
console.log("local integration database ready");
