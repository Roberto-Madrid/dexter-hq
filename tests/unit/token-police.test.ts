import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import {
  CONNECTOR_TOOLS,
  callConnectorTool,
  createDefaultConnectorDeps,
  createMemoryConnectorStore,
  loadConnectorSheetText,
} from "../../hq/connector.ts";
import type { ConnectorAuth } from "../../hq/connector-store.ts";
import {
  COMPARE_TIMEOUT_MS,
  PINNED_CHECKER_WORKFLOW,
  createGhChecker,
  type CheckerGateway,
  type CompareResult,
} from "../../hq/checker.ts";
import {
  BLOCKED_LOG_LINES,
  DIFF_PATH_CAP,
  GATE_FAIL_LIMIT,
  SKILL_MAX_WORDS,
  diffstat,
  isSecretFilename,
  secretFilenames,
  skillBudget,
} from "../../hq/token-police.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-10-08T18:00:00.000Z";
const REPO = "owner/a";
const sha = (n: number) => `${"a".repeat(38)}${n.toString(16).padStart(2, "0")}`;

const auth: ConnectorAuth = {
  id: BOT,
  ownerId: OWNER,
  name: "unit-lead",
  kind: "lead",
  repos: [REPO],
  tools: [...CONNECTOR_TOOLS],
  currentTask: null,
  heartbeatAt: null,
  scopes: [...CONNECTOR_TOOLS],
  suspended: false,
};

type Gate = CheckerGateway & { dispatches: string[]; compares: Record<string, unknown>[]; heads: number };

/** Each dispatched sha gets the next conclusion; a failing run carries more log lines than BLOCKED keeps. */
function gateChecker(options: {
  conclusions?: ("success" | "failure")[];
  head?: string | Error | null;
  compare?: CompareResult | Error | "none";
}): Gate {
  const conclusions = [...(options.conclusions ?? [])];
  const bySha = new Map<string, "success" | "failure">();
  const dispatches: string[] = [];
  const compares: Record<string, unknown>[] = [];
  const gate: Gate = {
    dispatches,
    compares,
    heads: 0,
    async dispatch(input) {
      dispatches.push(input.sha);
      bySha.set(input.sha, conclusions.shift() ?? "success");
      return {
        dispatched: true,
        githubRunId: `run-${dispatches.length}`,
        sha: input.sha,
        nonce: input.nonce,
        url: null,
        workflow: PINNED_CHECKER_WORKFLOW,
        hostRepo: "owner/workers",
        trustedRef: "main",
      };
    },
    async find() {
      return null;
    },
    async outcome(input) {
      const conclusion = bySha.get(input.sha) ?? "success";
      return {
        state: "completed",
        conclusion,
        githubRunId: input.githubRunId,
        evidence:
          conclusion === "success"
            ? ["checker:build:pass", "checker:lint:pass", "checker:playwright:pass"]
            : ["checker:build:pass", "checker:lint:fail", "checker:playwright:fail", `checker:url:https://example.test/${input.githubRunId}`],
      };
    },
    async head() {
      gate.heads += 1;
      const head = options.head === undefined ? null : options.head;
      if (head instanceof Error) throw head;
      return head;
    },
  };
  if (options.compare !== "none") {
    gate.compare = async (input) => {
      compares.push({ ...input });
      if (options.compare instanceof Error) throw options.compare;
      return options.compare ?? { files: [], aheadBy: 1, truncated: false };
    };
  }
  return gate;
}

async function setup(checker: Gate | null) {
  const store = createMemoryConnectorStore({ bots: [auth] });
  await store.saveRequest({
    id: "req-1",
    ownerId: OWNER,
    goal: "Change one label.",
    status: "running",
    card: { crew: "change", newScreen: false, requiresDesignApproval: false },
    evidence: [],
    assignedBotId: BOT,
    repo: REPO,
    notices: [],
    pullRequest: "7",
    branch: null,
  });
  const deps = createDefaultConnectorDeps({
    store,
    sheet: parseRoleSheet(loadConnectorSheetText()),
    cursor: null,
    cursorConfigured: false,
    checker,
    checkerConfigured: Boolean(checker),
    ownerId: OWNER,
    now: () => NOW,
  });
  return { store, deps };
}

type Deps = Awaited<ReturnType<typeof setup>>["deps"];

const check = (deps: Deps, n: number) =>
  callConnectorTool(deps, auth, "request_checks", { requestId: "req-1", repo: REPO, sha: sha(n), pullRequest: "7" });

const approve = (deps: Deps, action: string, extra: Record<string, unknown> = {}) =>
  callConnectorTool(deps, auth, "request_approval", { action, target: "PR #7", requestId: "req-1", ...extra });

function files(names: string[], status = "modified"): CompareResult {
  return { files: names.map((filename) => ({ filename, status, additions: 2, deletions: 1 })), aheadBy: 1, truncated: false };
}

describe("token police thresholds (agent-brake defaults)", () => {
  it("uses agent-brake's numbers", () => {
    expect(GATE_FAIL_LIMIT).toBe(3);
    expect(BLOCKED_LOG_LINES).toBe(5);
    expect(DIFF_PATH_CAP).toBe(20);
    expect(SKILL_MAX_WORDS).toBe(349);
  });

  it("flags secret-shaped file names like agent-brake's secret_filename", () => {
    for (const name of [".env", "app/.env.local", ".env.production", "id_rsa", "deploy/id_ed25519", "x/credentials.json", "secrets.json", "cert.PEM", "a.p12", "b.pfx", "server.key"]) {
      expect(isSecretFilename(name), name).toBe(true);
    }
    for (const name of [".env.example", "README.md", "keys.ts", "hq/token-police.ts", "envelope.txt", "id_rsa.pub", "monkey.json"]) {
      expect(isSecretFilename(name), name).toBe(false);
    }
    expect(
      secretFilenames([
        { filename: "certs/server.pem", status: "added", additions: 1, deletions: 0 },
        { filename: "old/id_rsa", status: "removed", additions: 0, deletions: 10 },
        { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1 },
      ]),
    ).toEqual(["certs/server.pem"]);
  });

  it("caps changed paths at 20 and reports a shortstat, never a patch", () => {
    const ok = diffstat(files(Array.from({ length: 20 }, (_, i) => `f${i}.ts`)).files);
    expect(ok).toMatchObject({ verdict: "ok", filesChanged: 20, insertions: 40, deletions: 20, pathCap: 20 });
    expect(ok.shortstat).toBe("20 files changed, 40 insertions(+), 20 deletions(-)");
    const over = diffstat(files(Array.from({ length: 21 }, (_, i) => `f${i}.ts`)).files);
    expect(over).toMatchObject({ verdict: "over_cap", filesChanged: 21 });
  });

  it("counts skill words by whitespace and refuses above 349", () => {
    expect(skillBudget(Array(349).fill("w").join(" "))).toEqual({ words: 349, maxWords: 349, over: false });
    expect(skillBudget(Array(350).fill("w").join("\n  "))).toEqual({ words: 350, maxWords: 349, over: true });
    expect(skillBudget("   ").words).toBe(0);
  });

  it("keeps every shipped persona profile within the word cap", () => {
    for (const name of readdirSync("personas").filter((file) => file.endsWith(".md"))) {
      expect(skillBudget(readFileSync(`personas/${name}`, "utf8")).over, name).toBe(false);
    }
  });
});

describe("gate verdicts: two retries, BLOCKED on the third fail", () => {
  it("blocks the request on the third failed Checker run, records one BLOCKED event, and refuses further gated actions", async () => {
    const checker = gateChecker({ conclusions: ["failure", "failure", "failure"], head: sha(3) });
    const { store, deps } = await setup(checker);

    const first = await check(deps, 1);
    expect(first.structuredContent).toMatchObject({ status: "failed", gate: { fails: 1, limit: 3, retriesLeft: 2 } });
    const second = await check(deps, 2);
    expect(second.structuredContent).toMatchObject({ status: "failed", gate: { fails: 2, limit: 3, retriesLeft: 1 } });
    const third = await check(deps, 3);
    expect(third.isError).toBe(true);
    expect(third.structuredContent).toMatchObject({ status: "refused", reason: "gate_blocked", requestId: "req-1", fails: 3, limit: 3 });

    const blocked = (await store.listEvents()).filter((event) => event.action === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ actor: "hq", target: "req-1", ownerId: OWNER });
    expect(String(blocked[0]?.result?.line)).toMatch(/^BLOCKED: /);
    const log = blocked[0]?.result?.log as string[];
    expect(log.length).toBeGreaterThan(0);
    expect(log.length).toBeLessThanOrEqual(5);
    expect(log.join("\n")).toContain("checker:lint:fail");
    expect(blocked[0]?.result).toMatchObject({ status: "blocked", reason: "gate_failed", requestId: "req-1", botId: BOT, fails: 3, sha: sha(3) });
    expect((await store.getRequest("req-1"))?.status).toBe("blocked");

    // No fourth Checker run, no done, no approval.
    expect((await check(deps, 4)).structuredContent).toMatchObject({ status: "refused", reason: "gate_blocked" });
    expect(checker.dispatches).toHaveLength(3);
    const done = await callConnectorTool(deps, auth, "update_request", { requestId: "req-1", status: "done", evidence: ["x"] });
    expect(done.structuredContent).toMatchObject({ status: "refused", reason: "gate_blocked" });
    const merge = await approve(deps, "merge");
    expect(merge.structuredContent).toMatchObject({ status: "refused", reason: "gate_blocked" });
    expect((await store.listEvents()).filter((event) => event.action === "blocked")).toHaveLength(1);
  });

  it("counts distinct failed runs only, and a pass resets the count", async () => {
    const checker = gateChecker({ conclusions: ["failure", "failure", "success", "failure", "failure", "failure"] });
    const { deps } = await setup(checker);
    await check(deps, 1);
    // Re-polling the same failed run is not a new fail.
    expect((await check(deps, 1)).structuredContent).toMatchObject({ status: "failed", gate: { fails: 1 } });
    expect((await check(deps, 1)).structuredContent).toMatchObject({ status: "failed", gate: { fails: 1 } });
    expect((await check(deps, 2)).structuredContent).toMatchObject({ status: "failed", gate: { fails: 2 } });
    expect((await check(deps, 3)).structuredContent).toMatchObject({ status: "ready" });
    expect((await check(deps, 4)).structuredContent).toMatchObject({ status: "failed", gate: { fails: 1 } });
    expect((await check(deps, 5)).structuredContent).toMatchObject({ status: "failed", gate: { fails: 2 } });
    expect((await check(deps, 6)).structuredContent).toMatchObject({ status: "refused", reason: "gate_blocked" });
  });
});

describe("approval gates", () => {
  it("leaves non-gated approvals alone", async () => {
    const { deps } = await setup(null);
    const surge = await callConnectorTool(deps, auth, "request_approval", { action: "surge", target: "agents" });
    expect(surge.structuredContent.status).toBe("pending");
  });

  it("refuses deploy, merge and stage-exit approvals without a request or a passing gate", async () => {
    const { store, deps } = await setup(gateChecker({ head: sha(1) }));
    const none = await callConnectorTool(deps, auth, "request_approval", { action: "deploy", target: "preview" });
    expect(none.structuredContent).toMatchObject({ status: "refused", reason: "gate_request_required" });
    for (const action of ["merge", "stage-exit", "stage_exit", "deploy", "pr"]) {
      const refused = await approve(deps, action);
      expect(refused.isError, action).toBe(true);
      expect(refused.structuredContent, action).toMatchObject({
        status: "refused",
        reason: "gate_not_passed",
        gate: { verdict: "fail", commands: [{ name: "build" }, { name: "lint" }, { name: "playwright" }] },
      });
    }
    expect(await store.listApprovals()).toHaveLength(0);
  });

  it("lets a deploy through on a passing gate without a diff lookup", async () => {
    const checker = gateChecker({ head: sha(1) });
    const { deps } = await setup(checker);
    await check(deps, 1);
    const deploy = await approve(deps, "deploy");
    expect(deploy.structuredContent).toMatchObject({
      status: "pending",
      police: { gate: { verdict: "pass", sha: sha(1), commands: [{ name: "build", verdict: "pass" }, { name: "lint", verdict: "pass" }, { name: "playwright", verdict: "pass" }] } },
    });
    expect(checker.compares).toHaveLength(0);
  });

  it("lets a small clean merge through and reports its shortstat", async () => {
    const checker = gateChecker({ head: sha(1), compare: files(["src/a.ts", "src/b.ts", ".env.example"]) });
    const { store, deps } = await setup(checker);
    await check(deps, 1);
    const merge = await approve(deps, "merge");
    expect(merge.structuredContent).toMatchObject({
      status: "pending",
      police: { gate: { verdict: "pass" }, diffstat: { filesChanged: 3, verdict: "ok", shortstat: "3 files changed, 6 insertions(+), 3 deletions(-)" } },
    });
    expect(checker.compares).toEqual([{ repo: REPO, base: "main", head: sha(1) }]);
    expect(await store.listApprovals()).toHaveLength(1);
  });

  it("refuses a merge whose head moved past the passing sha, or whose head is unknown", async () => {
    const moved = await setup(gateChecker({ head: sha(9) }));
    await check(moved.deps, 1);
    expect((await approve(moved.deps, "merge")).structuredContent).toMatchObject({ reason: "gate_stale_head", head: sha(9), checkedSha: sha(1) });
    const unknown = await setup(gateChecker({ head: new Error("timeout") }));
    await check(unknown.deps, 1);
    expect((await approve(unknown.deps, "merge")).structuredContent).toMatchObject({ reason: "head_lookup_failed" });
  });

  it("refuses a diff over 20 changed paths", async () => {
    const { store, deps } = await setup(gateChecker({ head: sha(1), compare: files(Array.from({ length: 21 }, (_, i) => `f${i}.ts`)) }));
    await check(deps, 1);
    const merge = await approve(deps, "merge");
    expect(merge.structuredContent).toMatchObject({ status: "refused", reason: "diff_too_large", filesChanged: 21, pathCap: 20 });
    expect(await store.listApprovals()).toHaveLength(0);
  });

  it("refuses a diff that adds secret-shaped files, but not one that deletes them", async () => {
    const adds = await setup(gateChecker({ head: sha(1), compare: files(["config/.env.production", "certs/server.pem", "src/a.ts"]) }));
    await check(adds.deps, 1);
    expect((await approve(adds.deps, "pr_ready")).structuredContent).toMatchObject({
      status: "refused",
      reason: "secret_filename",
      files: ["config/.env.production", "certs/server.pem"],
    });
    const removes = await setup(gateChecker({ head: sha(1), compare: files(["certs/server.pem"], "removed") }));
    await check(removes.deps, 1);
    expect((await approve(removes.deps, "merge")).structuredContent.status).toBe("pending");
  });

  it("fails closed when the diff cannot be read", async () => {
    for (const compare of [new Error("compare_502"), "none" as const]) {
      const { store, deps } = await setup(gateChecker({ head: sha(1), compare }));
      await check(deps, 1);
      expect((await approve(deps, "merge")).structuredContent).toMatchObject({ status: "refused", reason: "diffstat_unavailable" });
      expect(await store.listApprovals()).toHaveLength(0);
    }
  });
});

describe("GitHub compare via the GH_HQ_TOKEN gateway", () => {
  it("reads changed files with a timeout and never asks for a patch", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const checker = createGhChecker({
      token: "unit-token",
      hostRepo: "owner/workers",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            ahead_by: 2,
            files: [
              { filename: "a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ secret @@" },
              { filename: "b.pem", status: "added", additions: 1, deletions: 0 },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    const result = await checker.compare?.({ repo: REPO, base: "main", head: sha(1) });
    expect(result).toEqual({
      files: [
        { filename: "a.ts", status: "modified", additions: 3, deletions: 1 },
        { filename: "b.pem", status: "added", additions: 1, deletions: 0 },
      ],
      aheadBy: 2,
      truncated: false,
    });
    expect(calls[0]?.url).toBe(`https://api.github.com/repos/${REPO}/compare/main...${sha(1)}?per_page=1`);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(COMPARE_TIMEOUT_MS).toBe(10_000);
  });

  it("throws on a non-2xx answer so the gate fails closed", async () => {
    const checker = createGhChecker({
      token: "unit-token",
      hostRepo: "owner/workers",
      fetchImpl: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch,
    });
    await expect(checker.compare?.({ repo: REPO, base: "main", head: sha(1) })).rejects.toThrow("compare_404");
  });
});
