// Proves the function bundle rules after `next build`:
//   1. no function trace includes the Codex binary (it is fetched at runtime; function storage is capped);
//   2. /api/chat and /api/mcp both trace the age binary and the age public key used by path B login;
//   3. /api/mcp traces every Council seat persona.
// Usage: node scripts/check-traces.mjs [nextDir=.next]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

const nextDir = resolve(process.argv[2] ?? ".next");
const serverDir = join(nextDir, "server");
const REQUIRED = {
  "app/api/chat/route.js.nft.json": ["vendor/age/age", "workers/age.pub"],
  "app/api/mcp/route.js.nft.json": [
    "vendor/age/age",
    "workers/age.pub",
    // Council seat prompts (hq/council-seat.ts) read these at runtime.
    ...["architect", "strategist", "critic", "security", "devil"].map((seat) => `personas/${seat}.md`),
  ],
};
const FORBIDDEN = [/(^|\/)vendor\/codex(\/|$)/, /(^|\/)codex-x86_64-unknown-linux-musl$/];
const MAX_TRACED_FILE_BYTES = 50 * 1024 * 1024;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".nft.json")) out.push(full);
  }
  return out;
}

const failures = [];
const traces = walk(serverDir);
if (traces.length === 0) failures.push(`no .nft.json traces under ${serverDir}; run next build first`);

for (const file of traces) {
  const name = relative(serverDir, file);
  const { files = [] } = JSON.parse(readFileSync(file, "utf8"));
  for (const entry of files) {
    const absolute = resolve(dirname(file), entry);
    const normalized = absolute.split("\\").join("/");
    if (FORBIDDEN.some((pattern) => pattern.test(normalized))) {
      failures.push(`codex binary traced into ${name}: ${entry}`);
      continue;
    }
    if (existsSync(absolute) && statSync(absolute).isFile() && statSync(absolute).size > MAX_TRACED_FILE_BYTES) {
      failures.push(`oversized file traced into ${name}: ${entry} (${statSync(absolute).size} bytes)`);
    }
  }
}

for (const [name, needs] of Object.entries(REQUIRED)) {
  const file = join(serverDir, name);
  if (!existsSync(file)) {
    failures.push(`missing trace ${name}`);
    continue;
  }
  const { files = [] } = JSON.parse(readFileSync(file, "utf8"));
  const normalized = files.map((entry) => resolve(dirname(file), entry).split("\\").join("/"));
  for (const need of needs) {
    if (!normalized.some((entry) => entry.endsWith(`/${need}`))) failures.push(`${name} does not trace ${need}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`check:traces: ${failure}`);
  process.exit(1);
}
console.log(`check:traces: traces ok (${traces.length} traces; age in /api/chat and /api/mcp; codex in none)`);
