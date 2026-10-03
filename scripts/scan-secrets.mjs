import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const skipDir = new Set(["node_modules", ".git", ".omc", ".omx", ".temp", "tmp"]);
const skipFile = new Set([".env", ".env.local", ".env.development.local", ".env.test.local", ".env.production.local"]);
const rules = [
  { id: "private_key", source: "-----BEGIN [A-Z ]*PRIVATE KEY-----" },
  { id: "aws_access_key", source: "\\bAKIA[0-9A-Z]{16}\\b" },
  { id: "github_pat", source: "\\bghp_[A-Za-z0-9]{20,}\\b" },
  { id: "slack_token", source: "\\bxox[baprs]-[A-Za-z0-9-]{10,}" },
  { id: "age_secret", source: "\\bAGE-SECRET-KEY-1[A-Z2-7]{20,}\\b" },
  { id: "sk_token", source: "\\bsk-[A-Za-z0-9]{20,}\\b" },
];

const alphabet = "abcdefghijklmnopqrstuvwxyz";

function fixtureShape(match) {
  const body = match.replace(/^(sk-|ghp_|xox[baprs]-|AKIA|AGE-SECRET-KEY-1)/, "");
  return body.length >= 16 && alphabet.startsWith(body.toLowerCase());
}

const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skipDir.has(name) || skipFile.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (!stat.isFile() || stat.size > 1_000_000) continue;
    if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".woff")) continue;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const rule of rules) {
      const found = text.match(new RegExp(rule.source));
      if (found && !fixtureShape(found[0])) hits.push(`${rule.id} ${path}`);
    }
  }
}

walk(".");
if (hits.length > 0) {
  console.error(hits.join("\n"));
  process.exit(1);
}
console.log("secret scan clean");
