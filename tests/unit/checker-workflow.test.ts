import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkerRunName } from "../../hq/checker.ts";

// The mirror of dexter-workers' Checker. HQ dispatches it and reads a successful run as "build, lint, playwright passed".
const WORKFLOW_PATH = "workers/.github/workflows/checker.yml";
type Step = { name?: string; id?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Workflow = {
  name: string;
  "run-name": string;
  on: { workflow_dispatch: { inputs: Record<string, { required: boolean; type: string }> } };
  permissions: Record<string, string>;
  jobs: { check: { steps: Step[] } };
};

const text = readFileSync(WORKFLOW_PATH, "utf8");
const workflow = parse(text) as Workflow;
const steps = workflow.jobs.check.steps;

function step(name: string): Step {
  const found = steps.find((item) => item.name === name);
  if (!found?.run) throw new Error(`missing run step ${name}`);
  return found;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "checker-wf-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/** Runs one step's script the way Actions does (bash -e -o pipefail) and returns its outputs and summary. */
function runStep(name: string, cwd: string, env: Record<string, string> = {}) {
  const scratch = tempDir();
  const output = join(scratch, "output");
  const summary = join(scratch, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step(name).run!], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env },
  });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { status: result.status, stdout: result.stdout, outputs, summary: readFileSync(summary, "utf8") };
}

describe("Checker workflow mirror: shape HQ depends on", () => {
  it("takes exactly target_repo, target_sha, nonce and names the run the way HQ matches it", () => {
    expect(workflow.name).toBe("checker");
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual(["nonce", "target_repo", "target_sha"]);
    for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) expect(input).toEqual({ required: true, type: "string" });
    expect(workflow["run-name"]).toBe(
      checkerRunName({ repo: "${{ inputs.target_repo }}", sha: "${{ inputs.target_sha }}", nonce: "${{ inputs.nonce }}" }),
    );
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("checks out the target at the sha with the read token, without persisting it", () => {
    const checkout = steps.find((item) => item.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toEqual({
      repository: "${{ inputs.target_repo }}",
      ref: "${{ inputs.target_sha }}",
      token: "${{ secrets.CHECKER_READ_TOKEN || github.token }}",
      "persist-credentials": false,
      path: "subject",
    });
    // Only the checkout step may see a secret.
    const others = steps.filter((item) => item !== checkout);
    expect(JSON.stringify(others)).not.toContain("secrets.");
  });

  it("never expands workflow expressions inside a shell script", () => {
    for (const item of steps) if (item.run) expect(item.run).not.toContain("${{");
  });

  it("installs Playwright browsers before tests and uploads screenshots", () => {
    expect(step("Playwright").run).toContain("npx playwright install --with-deps chromium");
    expect(step("Playwright").run).toContain("npm install --silent @playwright/test@1.55.0");
    const upload = steps.find((item) => item.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.if).toBe("always()");
    expect(String(upload?.with?.path)).toContain("subject/shots/");
  });

  it("ends with an always-run Verdict over build, lint, playwright", () => {
    const verdict = steps.at(-1);
    expect(verdict?.name).toBe("Verdict");
    expect(verdict?.if).toBe("always()");
    for (const id of ["build", "lint", "playwright"]) expect(steps.some((item) => item.id === id)).toBe(true);
  });
});

describe("Checker workflow mirror: steps run honestly", () => {
  const SAMPLE = {
    "build.js": 'require("node:fs").writeFileSync("built.txt", "ok\\n");',
    "lint.js": 'process.exit(require("node:fs").existsSync("built.txt") ? 0 : 1);',
  };

  it("detects npm, plain, and none recipes", () => {
    const npm = runStep("Detect", tempDir({ "package.json": JSON.stringify({ scripts: { build: "x", test: "y", lint: " " } }) }));
    expect(npm.outputs).toEqual({ mode: "npm", has_build: "true", has_lint: "false", has_test: "true" });
    expect(runStep("Detect", tempDir(SAMPLE)).outputs).toEqual({ mode: "plain" });
    expect(runStep("Detect", tempDir({ "README.md": "# empty" })).outputs).toEqual({ mode: "none" });
  });

  it("runs build.js and lint.js for a plain target and reports pass", () => {
    const dir = tempDir(SAMPLE);
    const build = runStep("Build", dir, { MODE: "plain" });
    expect(build).toMatchObject({ status: 0, outputs: { result: "pass" } });
    expect(runStep("Lint", dir, { MODE: "plain" })).toMatchObject({ status: 0, outputs: { result: "pass" } });
  });

  it("fails the step when the target's own lint fails", () => {
    const lint = runStep("Lint", tempDir(SAMPLE), { MODE: "plain" });
    expect(lint.status).not.toBe(0);
    expect(lint.outputs.result).toBeUndefined();
  });

  it("reports n/a, not pass, when the target has nothing to run", () => {
    const dir = tempDir({ "README.md": "# empty" });
    for (const name of ["Build", "Lint", "Playwright"]) {
      expect(runStep(name, dir, { MODE: "none" })).toMatchObject({ status: 0, outputs: { result: "n/a" } });
    }
    // An npm target without a lint script is n/a too: `--if-present` style silent passes are gone.
    expect(runStep("Lint", tempDir({ "package.json": "{}" }), { MODE: "npm", HAS_SCRIPT: "false" }).outputs).toEqual({ result: "n/a" });
  });

  const verdictEnv = (build: [string, string], lint: [string, string], playwright: [string, string], mode = "plain") => ({
    TARGET_REPO: "owner/demo",
    TARGET_SHA: "a".repeat(40),
    MODE: mode,
    BUILD_OUTCOME: build[0],
    BUILD_RESULT: build[1],
    LINT_OUTCOME: lint[0],
    LINT_RESULT: lint[1],
    PLAYWRIGHT_OUTCOME: playwright[0],
    PLAYWRIGHT_RESULT: playwright[1],
  });

  it("passes only when build, lint, and playwright all ran and passed", () => {
    const ok = runStep("Verdict", tempDir(), verdictEnv(["success", "pass"], ["success", "pass"], ["success", "pass"]));
    expect(ok.status).toBe(0);
    expect(ok.summary).toContain("| build | pass |");
    expect(ok.summary).toContain("| playwright | pass |");
  });

  it("fails closed on n/a, failure, or a skipped step, and says which", () => {
    const na = runStep("Verdict", tempDir(), verdictEnv(["success", "n/a"], ["success", "n/a"], ["success", "n/a"], "none"));
    expect(na.status).not.toBe(0);
    expect(na.summary).toContain("| build | n/a |");
    expect(na.stdout).toContain("Checker not applicable");
    expect(na.stdout).toContain("build=n/a lint=n/a playwright=n/a");

    const failed = runStep("Verdict", tempDir(), verdictEnv(["success", "pass"], ["failure", ""], ["skipped", ""]));
    expect(failed.status).not.toBe(0);
    expect(failed.summary).toContain("| lint | fail |");
    expect(failed.summary).toContain("| playwright | not run |");

    const partial = runStep("Verdict", tempDir(), verdictEnv(["success", "pass"], ["success", "n/a"], ["success", "pass"]));
    expect(partial.status).not.toBe(0);
    expect(partial.stdout).toContain("lint=n/a");
  });
});
