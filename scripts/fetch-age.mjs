// Places the pinned age binary at vendor/age/age for next.config.mjs to trace into /api/chat and /api/mcp.
// The Codex binary is intentionally NOT fetched here: it is never bundled into a function (function storage is
// capped); hq/codex-bin.ts downloads and hash-verifies it at runtime instead.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ageDest = "vendor/age/age";
const AGE_URL = "https://github.com/FiloSottile/age/releases/download/v1.1.1/age-v1.1.1-linux-amd64.tar.gz";
const AGE_ARCHIVE_SHA256 = "cf16cbb108fc56e2064b00ba2b65d9fb1b8d7002ca5e38260ee1cc34f6aaa8f9";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (!existsSync(ageDest) || statSync(ageDest).size < 1000) {
  const dir = join(tmpdir(), `age-pkg-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, "age.tar.gz");
  execFileSync("curl", ["-fsSL", "-o", archive, AGE_URL]);
  const got = sha256(archive);
  if (got !== AGE_ARCHIVE_SHA256) {
    rmSync(dir, { recursive: true, force: true });
    console.error(`age archive sha256 mismatch: got ${got}`);
    process.exit(1);
  }
  execFileSync("tar", ["-xzf", archive, "-C", dir]);
  mkdirSync(join(ageDest, ".."), { recursive: true });
  execFileSync("cp", [join(dir, "age/age"), ageDest]);
  chmodSync(ageDest, 0o755);
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ ageBytes: statSync(ageDest).size, codex: "fetched at runtime (hq/codex-bin.ts)" }));
