import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function run(script: string, arg?: string): number {
  try {
    execFileSync("bash", arg ? [script, arg] : [script], { stdio: "pipe" });
    return 0;
  } catch (error) {
    const err = error as { status?: number };
    return err.status ?? 1;
  }
}

describe("repo checks", () => {
  it("accepts the kernel and rejects a vendor name", () => {
    expect(run("scripts/check-vendor-neutral.sh")).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "vendor-"));
    writeFileSync(join(dir, "bad.ts"), `export const name = ${JSON.stringify("grok")};\n`);
    expect(run("scripts/check-vendor-neutral.sh", dir)).toBe(1);
  });

  it("rejects a model name in a persona file", () => {
    const dir = mkdtempSync(join(tmpdir(), "briefs-"));
    const persona = join(dir, "personas");
    execFileSync("mkdir", ["-p", persona]);
    writeFileSync(join(persona, "builder.md"), "Use the grok family.\n");
    expect(run("scripts/check-briefs.sh", dir)).toBe(1);
    expect(run("scripts/check-briefs.sh")).toBe(0);
  });
});
