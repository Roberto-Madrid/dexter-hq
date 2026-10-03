import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const codexDest = "vendor/codex/codex";
const ageDest = "vendor/age/age";

function place(dest) {
  mkdirSync(join(dest, ".."), { recursive: true });
}

if (!existsSync(codexDest) || statSync(codexDest).size < 50_000_000) {
  const dir = join(tmpdir(), `codex-pkg-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync("npm", ["pack", "@openai/codex-linux-x64@0.160.0", "--pack-destination", dir], { stdio: "inherit" });
  execFileSync("tar", ["-xzf", join(dir, "openai-codex-linux-x64-0.160.0.tgz"), "-C", dir]);
  place(codexDest);
  execFileSync("cp", [join(dir, "package/vendor/x86_64-unknown-linux-musl/bin/codex"), codexDest]);
  chmodSync(codexDest, 0o755);
  rmSync(dir, { recursive: true, force: true });
}

if (!existsSync(ageDest) || statSync(ageDest).size < 1000) {
  const dir = join(tmpdir(), `age-pkg-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, "age.tar.gz");
  execFileSync("curl", ["-fsSL", "-o", archive, "https://github.com/FiloSottile/age/releases/download/v1.1.1/age-v1.1.1-linux-amd64.tar.gz"]);
  execFileSync("tar", ["-xzf", archive, "-C", dir]);
  place(ageDest);
  execFileSync("cp", [join(dir, "age/age"), ageDest]);
  chmodSync(ageDest, 0o755);
  rmSync(dir, { recursive: true, force: true });
}

const codexBytes = statSync(codexDest).size;
console.log(JSON.stringify({ codexBytes, ageBytes: statSync(ageDest).size, functionLimitBytes: 250 * 1024 * 1024 }));
