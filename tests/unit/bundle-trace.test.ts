import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve("scripts/check-traces.mjs");
const AGE = ["../../../../../vendor/age/age", "../../../../../workers/age.pub"];
const dirs: string[] = [];

function nextDir(traces: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), "trace-check-"));
  dirs.push(root);
  for (const [route, files] of Object.entries(traces)) {
    const file = join(root, "server/app", route, "route.js.nft.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, files }));
  }
  return root;
}

function check(dir: string) {
  const run = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("function trace check", () => {
  it("passes when age is traced into chat and mcp and codex is in no function", () => {
    const dir = nextDir({ "api/chat": [...AGE], "api/mcp": [...AGE], "api/board": ["../../../../chunks/1.js"] });
    const result = check(dir);
    expect(result.out).toContain("traces ok");
    expect(result.status).toBe(0);
  });

  it("fails when /api/mcp does not trace age or its public key", () => {
    expect(check(nextDir({ "api/chat": [...AGE], "api/mcp": [] })).out).toMatch(/api\/mcp.*vendor\/age\/age/);
    expect(check(nextDir({ "api/chat": [...AGE], "api/mcp": [AGE[0]] })).status).not.toBe(0);
  });

  it("fails when /api/chat stops tracing age", () => {
    expect(check(nextDir({ "api/chat": [], "api/mcp": [...AGE] })).status).not.toBe(0);
  });

  it("fails when any function traces the codex binary", () => {
    const withCodex = nextDir({
      "api/chat": [...AGE],
      "api/mcp": [...AGE],
      "api/board": ["../../../../../vendor/codex/codex"],
    });
    const result = check(withCodex);
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/codex.*api\/board/);
  });

  it("fails when a route trace is missing entirely", () => {
    expect(check(nextDir({ "api/chat": [...AGE] })).status).not.toBe(0);
  });
});

describe("build config", () => {
  it("traces age into chat and mcp and never traces codex", async () => {
    const mod = (await import(pathToFileURL(resolve("next.config.mjs")).href)) as {
      default: { outputFileTracingIncludes: Record<string, string[]> };
    };
    const includes = mod.default.outputFileTracingIncludes;
    for (const route of ["/api/chat", "/api/mcp"]) {
      expect(includes[route]).toContain("./vendor/age/age");
      expect(includes[route]).toContain("./workers/age.pub");
    }
    expect(JSON.stringify(includes)).not.toMatch(/codex/);
  });

  it("does not download codex at build time", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).not.toMatch(/codex/);
  });
});
