import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { decideApproval } from "../../hq/approval.ts";
import { callConnectorTool, type ConnectorDeps } from "../../hq/connector.ts";
import { UPGRADE_BOT_NAME, type ConnectorAgent, type ConnectorAuth, type ConnectorStore } from "../../hq/connector-store.ts";
import { resolveDailyPins } from "../../hq/pins.ts";
import { postTick } from "../../hq/server.ts";
import { reconcileConnector } from "../../hq/reconcile.ts";
import {
  COUNCIL_UPGRADE_ACTION,
  SANDBOX_ENV,
  UPGRADE_CHECK_DONE,
  UPGRADE_CHECK_STARTED,
  UPGRADE_ROLLBACK_ACTION,
  advanceUpgradeChecks,
  defaultUpgradeGrader,
  loadUpgradeTasks,
  upgradeRunKey,
  upgradeTickStep,
  type UpgradeTickResult,
} from "../../hq/upgrade-check.ts";
import { readCatalogMatch } from "../../gateway/catalog.ts";
import { OWNER, capsAuth, capsDeps, fakeCursor } from "./caps-fixtures.ts";
import { CATALOG_IDS } from "./pin-fixtures.ts";

// The production bundle inlines config/upgrade-tasks (scripts/bundle-hq.mjs); disk reads still win when the folder exists.
vi.mock("../../hq/bundled-assets.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hq/bundled-assets.ts")>()),
  bundledUpgradeTasks: () => ({ "grok/02-b.md": "# B\nsecond {{branch}}", "grok/01-a.md": "# A\nfirst {{branch}}", "composer/01-c.md": "# C\nc" }),
}));

const sheetText = readFileSync("gateway/role-sheet.yaml", "utf8");
const SANDBOX = "owner/sandbox";
const ENV = { [SANDBOX_ENV]: SANDBOX };
const DAY1 = "2026-10-08T09:00:00.000Z";
const TAP = "2026-10-08T09:30:00.000Z";
const TICK = "2026-10-08T09:31:00.000Z";
const DAY2 = "2026-10-09T09:00:00.000Z";

type Setup = Awaited<ReturnType<typeof setup>>;

/** Baseline pins, then a daily check that sees new grok and gpt-sol versions: two held rows and two model_upgrade cards. */
async function setup(models: string[] = [...CATALOG_IDS, "grok-4.8", "gpt-5.7-sol"]) {
  const cursor = fakeCursor({ models });
  const clock = { at: TICK };
  const ctx = await capsDeps({ cursor, now: () => clock.at });
  await resolveDailyPins({ store: ctx.store, cursor, sheetText, now: () => DAY1, ownerIds: [OWNER] });
  return { ...ctx, clock };
}

async function card(store: ConnectorStore, action: string, target: string) {
  const row = (await store.listApprovals()).find((item) => item.action === action && item.target === target);
  if (!row) throw new Error(`no ${action} card for ${target}`);
  return row;
}

async function tap(store: ConnectorStore, action: string, target: string, at = TAP) {
  const row = await card(store, action, target);
  return decideApproval(store, { approvalId: row.id, decision: "approved", now: () => at });
}

function tick(deps: ConnectorDeps, env: Record<string, string | undefined> = ENV, extra: Partial<Parameters<typeof advanceUpgradeChecks>[0]> = {}) {
  return advanceUpgradeChecks({ deps, env, ownerIds: [OWNER], ...extra });
}

/** Marks every running fake Cursor run with `state(spec)` and lets reconcile close them. */
async function finishRunning(ctx: Setup, state: (modelId: string | null | undefined) => string = () => "FINISHED") {
  ctx.cursor.starts.forEach((spec, index) => {
    const id = `bc-${index + 1}:run-${index + 1}`;
    if (ctx.cursor.states.get(id) === "RUNNING") ctx.cursor.states.set(id, state(spec.modelId));
  });
  await reconcileConnector(ctx.deps);
}

/** Tick, finish, reconcile, until the check reports a final status (or rounds run out). */
async function drive(ctx: Setup, state?: (modelId: string | null | undefined) => string, rounds = 12): Promise<UpgradeTickResult> {
  let last: UpgradeTickResult = { checks: [] };
  for (let n = 0; n < rounds; n += 1) {
    last = await tick(ctx.deps);
    if (last.checks.length > 0 && last.checks.every((check) => check.status !== "running")) return last;
    await finishRunning(ctx, state);
  }
  return last;
}

async function pinOf(store: ConnectorStore, family: string) {
  return (await store.currentPins(OWNER)).find((pin) => pin.family === family)?.version;
}

async function upgradeBot(store: ConnectorStore) {
  return (await store.listBots()).find((bot) => bot.name === UPGRADE_BOT_NAME);
}

describe("U7 saved upgrade tasks", () => {
  it("has exactly 5 saved tasks for every catalog family, none naming a model, each with a branch slot and a done-command", () => {
    const families = readCatalogMatch(sheetText).map((row) => row.family);
    expect(families).toEqual(["grok", "composer", "claude-opus", "gpt-sol"]);
    const named = /openai|anthropic|claude|opus|grok|xai|cursor|codex|chatgpt|composer|github|vercel|gemini|opencode|gpt/i;
    for (const family of families) {
      const tasks = loadUpgradeTasks(family);
      expect(tasks).toHaveLength(5);
      for (const task of tasks) {
        expect(task.id).toMatch(/^[a-z0-9-]+$/);
        expect(task.brief).toContain("{{branch}}");
        expect(task.brief).toMatch(/Done-command:/);
        expect(named.test(task.brief)).toBe(false);
      }
    }
    expect(loadUpgradeTasks("no-such-family")).toEqual([]);
    expect(loadUpgradeTasks("../grok")).toEqual([]);
  });

  it("falls back to the bundled tasks when the folder is not on disk (the deployed function)", () => {
    expect(loadUpgradeTasks("grok", "/nonexistent-upgrade-tasks")).toEqual([
      { id: "01-a", title: "A", brief: "# A\nfirst {{branch}}" },
      { id: "02-b", title: "B", brief: "# B\nsecond {{branch}}" },
    ]);
  });

  it("keys a run by family, version and task", () => {
    expect(upgradeRunKey("grok", "grok-4.8", "01-meta-charset")).toBe("upgrade:grok:grok-4.8:01-meta-charset");
  });
});

describe("U7 default grader (weaker grading: Cursor FINISHED = pass)", () => {
  const agent = (status: string): ConnectorAgent => ({
    id: "a",
    ownerId: OWNER,
    botId: "b",
    cursorHandle: "bc-1:run-1",
    repo: SANDBOX,
    role: "builder",
    family: "grok",
    status,
    idempotencyKey: "k",
    result: null,
  });
  it("passes a finished run, fails error/expired/cancelled, and waits on live runs", async () => {
    expect(await defaultUpgradeGrader(agent("finished"))).toEqual({ passed: true, checksFailed: 0 });
    for (const status of ["error", "expired", "cancelled"]) {
      expect(await defaultUpgradeGrader(agent(status))).toEqual({ passed: false, checksFailed: 1 });
    }
    for (const status of ["launched", "running", "reserving", "launch_failed"]) {
      expect(await defaultUpgradeGrader(agent(status))).toBeNull();
    }
  });
});

describe("U7 nothing runs without the owner's tap", () => {
  it("a held version with no tap launches nothing, and a dry run on unchanged pins launches nothing", async () => {
    const held = await setup();
    expect(await tick(held.deps)).toEqual({ checks: [] });
    expect(held.cursor.starts).toHaveLength(0);
    const same = await setup([...CATALOG_IDS]);
    expect(await same.store.listApprovals()).toEqual([]);
    expect(await tick(same.deps)).toEqual({ checks: [] });
    expect(same.cursor.starts).toHaveLength(0);
    expect(await upgradeBot(same.store)).toBeUndefined();
  });
});

describe("U7 tap starts the check; ticks advance it", () => {
  it("the tap records the check and launches nothing; the next tick launches as hq-upgrade within the caps", async () => {
    const ctx = await setup();
    const decided = await tap(ctx.store, "model_upgrade", "grok:grok-4.8");
    expect(decided).toMatchObject({ status: "approved", action: "model_upgrade", execution: { status: "ok", reason: "upgrade_check_started" } });
    const started = (await ctx.store.listEvents()).filter((event) => event.action === UPGRADE_CHECK_STARTED);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ target: decided.approvalId, result: { family: "grok", incoming: "grok-4.8", current: "grok-4.7" } });
    expect(ctx.cursor.starts).toHaveLength(0);

    const first = await tick(ctx.deps);
    expect(first.checks).toEqual([expect.objectContaining({ family: "grok", incoming: "grok-4.8", current: "grok-4.7", status: "running", launched: 2 })]);
    // Per-repo cap 2 on the sandbox: only two runs at once.
    expect(ctx.cursor.starts).toHaveLength(2);
    expect(ctx.cursor.starts.map((spec) => spec.modelId)).toEqual(["grok-4.8", "grok-4.8"]);
    expect(ctx.cursor.starts.every((spec) => spec.repo === SANDBOX)).toBe(true);
    expect(ctx.cursor.starts[0]?.idempotencyKey).toBe("upgrade:grok:grok-4.8:01-meta-charset");
    expect(ctx.cursor.starts[0]?.brief).toMatch(/upgrade-check\/01-meta-charset-[0-9a-f]{8}/);
    expect(ctx.cursor.starts[0]?.brief).not.toContain("{{branch}}");

    const bot = await upgradeBot(ctx.store);
    expect(bot).toMatchObject({ kind: "other", repos: [SANDBOX] });
    const launches = (await ctx.store.listEvents()).filter((event) => event.action === "launch_agent" && event.result?.status === "launched");
    expect(launches.map((event) => event.actor)).toEqual([UPGRADE_BOT_NAME, UPGRADE_BOT_NAME]);
    const agents = await ctx.store.listAgents();
    expect(agents.every((agent) => agent.botId === bot?.id && agent.family === "grok")).toBe(true);
    // The runs belong to a request per side, so the per-request cap (5) applies too.
    const requestIds = new Set(agents.map((agent) => agent.result?.requestId));
    expect(requestIds.size).toBe(1);
    const request = await ctx.store.getRequest(String([...requestIds][0]));
    expect(request).toMatchObject({ status: "running", repo: SANDBOX, assignedBotId: bot?.id });

    // Nothing finished yet: a second tick launches nothing new.
    await tick(ctx.deps);
    expect(ctx.cursor.starts).toHaveLength(2);
  });
});

describe("U7 worker family passes: switch, notice, one-tap rollback", () => {
  it("runs 5 tasks on the new version and 5 baseline runs, switches the pin, posts a notice, and rollback restores it", async () => {
    const ctx = await setup();
    await tap(ctx.store, "model_upgrade", "grok:grok-4.8");
    const done = await drive(ctx);
    expect(done.checks).toEqual([expect.objectContaining({ family: "grok", status: "adopted" })]);
    expect(ctx.cursor.starts.filter((spec) => spec.modelId === "grok-4.8")).toHaveLength(5);
    expect(ctx.cursor.starts.filter((spec) => spec.modelId === "grok-4.7")).toHaveLength(5);
    expect(ctx.cursor.starts).toHaveLength(10);

    const outcomes = await ctx.store.listModelOutcomes(OWNER);
    expect(outcomes).toHaveLength(10);
    expect(outcomes.every((row) => row.passed)).toBe(true);
    const rows = await ctx.store.listModelResolutions(OWNER);
    const heldRow = rows.find((row) => row.family === "grok" && row.version === "grok-4.8" && row.held);
    expect(outcomes.filter((row) => row.modelRowId === heldRow?.id)).toHaveLength(5);

    expect(await pinOf(ctx.store, "grok")).toBe("grok-4.8");
    expect(await pinOf(ctx.store, "composer")).toBe("composer-2.5");
    const notice = (await ctx.store.listPosts()).find((post) => post.body.includes("grok-4.8") && post.body.includes("Roll back"));
    expect(notice).toMatchObject({ type: "alert", author: "hq" });
    const rollback = await card(ctx.store, UPGRADE_ROLLBACK_ACTION, "grok:grok-4.8->grok-4.7");
    expect(rollback.status).toBe("pending");
    const doneEvents = (await ctx.store.listEvents()).filter((event) => event.action === UPGRADE_CHECK_DONE);
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]?.result).toMatchObject({ outcome: "adopted", incoming: { passed: 5, total: 5 }, current: { passed: 5, total: 5 } });
    for (const id of new Set((await ctx.store.listAgents()).map((agent) => String(agent.result?.requestId)))) {
      expect((await ctx.store.getRequest(id))?.status).toBe("done");
    }

    // A later tick does nothing more.
    const after = await tick(ctx.deps);
    expect(after.checks).toEqual([]);
    expect(ctx.cursor.starts).toHaveLength(10);

    // Launches now use the new pin.
    const launched = await callConnectorTool(ctx.deps, capsAuth, "launch_agent", { role: "builder", brief: "Change one label.", idempotencyKey: "after-upgrade", repo: "owner/a", requestId: "req-0-1" });
    expect(launched.structuredContent).toMatchObject({ status: "launched", model: "grok-4.8" });

    const rolled = await tap(ctx.store, UPGRADE_ROLLBACK_ACTION, "grok:grok-4.8->grok-4.7", "2026-10-08T12:00:00.000Z");
    expect(rolled).toMatchObject({ status: "approved", execution: { status: "ok", reason: "rolled_back" } });
    expect(await pinOf(ctx.store, "grok")).toBe("grok-4.7");
    expect((await ctx.store.listPosts()).some((post) => post.body.includes("Rolled back") && post.body.includes("grok-4.7"))).toBe(true);
    // A second tap on the same card does nothing.
    const again = await tap(ctx.store, UPGRADE_ROLLBACK_ACTION, "grok:grok-4.8->grok-4.7", "2026-10-08T12:01:00.000Z");
    expect(again).toMatchObject({ reason: "already_decided", ran: false });
    expect(await pinOf(ctx.store, "grok")).toBe("grok-4.7");
  });

  it("with baseline results for the current pin, the next check runs only the 5 new-version tasks", async () => {
    const ctx = await setup();
    await tap(ctx.store, "model_upgrade", "grok:grok-4.8");
    await drive(ctx);
    expect(await pinOf(ctx.store, "grok")).toBe("grok-4.8");
    ctx.cursor.models = [...CATALOG_IDS, "grok-4.8", "grok-4.9", "gpt-5.7-sol"];
    await resolveDailyPins({ store: ctx.store, cursor: ctx.cursor, sheetText, now: () => DAY2, ownerIds: [OWNER] });
    await tap(ctx.store, "model_upgrade", "grok:grok-4.9", DAY2);
    ctx.clock.at = "2026-10-09T09:31:00.000Z";
    const before = ctx.cursor.starts.length;
    const done = await drive(ctx);
    expect(done.checks).toEqual([expect.objectContaining({ incoming: "grok-4.9", current: "grok-4.8", status: "adopted" })]);
    const fresh = ctx.cursor.starts.slice(before);
    expect(fresh).toHaveLength(5);
    expect(fresh.every((spec) => spec.modelId === "grok-4.9")).toBe(true);
    expect(await pinOf(ctx.store, "grok")).toBe("grok-4.9");
  });

  it("a rollback after the pin moved on does nothing", async () => {
    const ctx = await setup();
    await tap(ctx.store, "model_upgrade", "grok:grok-4.8");
    await drive(ctx);
    expect((await ctx.store.switchPin({ ownerId: OWNER, family: "grok", from: "grok-4.8", to: "grok-4.9", reason: "upgrade: test", at: "2026-10-08T11:00:00.000Z" })).switched).toBe(true);
    const rolled = await tap(ctx.store, UPGRADE_ROLLBACK_ACTION, "grok:grok-4.8->grok-4.7", "2026-10-08T12:00:00.000Z");
    expect(rolled).toMatchObject({ status: "approved", ran: false, execution: { status: "error", reason: "pin_moved" } });
    expect(await pinOf(ctx.store, "grok")).toBe("grok-4.9");
  });
});

describe("U7 CEO family (gpt-sol) waits for the owner", () => {
  it("a passing check raises a council_upgrade card and keeps the pin until the tap", async () => {
    const ctx = await setup();
    await tap(ctx.store, "model_upgrade", "gpt-sol:gpt-5.7-sol");
    const done = await drive(ctx);
    expect(done.checks).toEqual([expect.objectContaining({ family: "gpt-sol", status: "awaiting_owner" })]);
    expect(await pinOf(ctx.store, "gpt-sol")).toBe("gpt-5.6-sol");
    expect(ctx.cursor.starts.every((spec) => spec.modelId === "gpt-5.7-sol" || spec.modelId === "gpt-5.6-sol")).toBe(true);
    const council = await card(ctx.store, COUNCIL_UPGRADE_ACTION, "gpt-sol:gpt-5.6-sol->gpt-5.7-sol");
    expect(council.status).toBe("pending");
    expect((await ctx.store.listApprovals()).some((row) => row.action === UPGRADE_ROLLBACK_ACTION)).toBe(false);
    expect(await tick(ctx.deps)).toEqual({ checks: [] });
    expect(await pinOf(ctx.store, "gpt-sol")).toBe("gpt-5.6-sol");

    const adopted = await tap(ctx.store, COUNCIL_UPGRADE_ACTION, "gpt-sol:gpt-5.6-sol->gpt-5.7-sol", "2026-10-08T12:00:00.000Z");
    expect(adopted).toMatchObject({ status: "approved", execution: { status: "ok", reason: "adopted" } });
    expect(await pinOf(ctx.store, "gpt-sol")).toBe("gpt-5.7-sol");
    expect((await card(ctx.store, UPGRADE_ROLLBACK_ACTION, "gpt-sol:gpt-5.7-sol->gpt-5.6-sol")).status).toBe("pending");
  });

  it("a denied council card never switches the pin", async () => {
    const ctx = await setup();
    await tap(ctx.store, "model_upgrade", "gpt-sol:gpt-5.7-sol");
    await drive(ctx);
    const council = await card(ctx.store, COUNCIL_UPGRADE_ACTION, "gpt-sol:gpt-5.6-sol->gpt-5.7-sol");
    await decideApproval(ctx.store, { approvalId: council.id, decision: "denied", now: () => TAP });
    expect(await pinOf(ctx.store, "gpt-sol")).toBe("gpt-5.6-sol");
  });
});

describe("U7 failed check keeps the old pin", () => {
  it("the new version passing less often than the current pin keeps the pin, posts the result, and raises no card", async () => {
    const ctx = await setup();
    await tap(ctx.store, "model_upgrade", "grok:grok-4.8");
    let incomingRuns = 0;
    const done = await drive(ctx, (model) => {
      if (model !== "grok-4.8") return "FINISHED";
      incomingRuns += 1;
      return incomingRuns <= 2 ? "ERROR" : "FINISHED";
    });
    expect(done.checks).toEqual([expect.objectContaining({ status: "kept" })]);
    expect(await pinOf(ctx.store, "grok")).toBe("grok-4.7");
    const doneEvent = (await ctx.store.listEvents()).find((event) => event.action === UPGRADE_CHECK_DONE);
    expect(doneEvent?.result).toMatchObject({ outcome: "kept", incoming: { passed: 3, total: 5 }, current: { passed: 5, total: 5 } });
    expect((await ctx.store.listPosts()).some((post) => post.body.includes("kept grok-4.7") && post.body.includes("3/5"))).toBe(true);
    expect((await ctx.store.listApprovals()).some((row) => row.action === UPGRADE_ROLLBACK_ACTION || row.action === COUNCIL_UPGRADE_ACTION)).toBe(false);
    for (const id of new Set((await ctx.store.listAgents()).map((agent) => String(agent.result?.requestId)))) {
      expect((await ctx.store.getRequest(id))?.status).toBe("failed");
    }
  });
});

describe("U7 double tap and concurrent ticks", () => {
  it("a second tap and overlapping ticks never launch a run twice", async () => {
    const ctx = await setup();
    await tap(ctx.store, "model_upgrade", "grok:grok-4.8");
    const second = await tap(ctx.store, "model_upgrade", "grok:grok-4.8");
    expect(second).toMatchObject({ reason: "already_decided", ran: false });
    expect((await ctx.store.listEvents()).filter((event) => event.action === UPGRADE_CHECK_STARTED)).toHaveLength(1);
    await Promise.all([tick(ctx.deps), tick(ctx.deps), tick(ctx.deps)]);
    expect(ctx.cursor.starts).toHaveLength(2);
    expect(new Set(ctx.cursor.starts.map((spec) => spec.idempotencyKey)).size).toBe(2);
    await drive(ctx);
    expect(ctx.cursor.starts).toHaveLength(10);
    expect(new Set(ctx.cursor.starts.map((spec) => spec.idempotencyKey)).size).toBe(10);
    expect((await ctx.store.listModelOutcomes(OWNER))).toHaveLength(10);
    expect((await ctx.store.listEvents()).filter((event) => event.action === UPGRADE_CHECK_DONE)).toHaveLength(1);
  });
});

describe("U7 STOP ALL", () => {
  it("while STOP is on the check launches nothing, and the runner itself is refused", async () => {
    const ctx = await setup();
    await tap(ctx.store, "model_upgrade", "grok:grok-4.8");
    await ctx.store.setStopped(true);
    const stopped = await tick(ctx.deps);
    expect(stopped.checks).toEqual([expect.objectContaining({ status: "stopped", launched: 0 })]);
    expect(ctx.cursor.starts).toHaveLength(0);
    // Even a direct internal launch is refused by the connector's STOP gate.
    const bot = await ctx.store.ensureInternalBot({ ownerId: OWNER, name: UPGRADE_BOT_NAME, kind: "other", repos: [SANDBOX], at: TICK });
    const auth: ConnectorAuth = { ...bot, scopes: ["launch_agent"], suspended: false };
    const direct = await callConnectorTool(ctx.deps, auth, "launch_agent", { role: "builder", brief: "x", idempotencyKey: "stop-k", repo: SANDBOX }, { modelOverride: "grok-4.8" });
    expect(direct.structuredContent).toMatchObject({ status: "stopped" });
    expect(ctx.cursor.starts).toHaveLength(0);
  });

  it("a check whose request STOP cancelled ends as cancelled and keeps the pin", async () => {
    const ctx = await setup();
    await tap(ctx.store, "model_upgrade", "grok:grok-4.8");
    await tick(ctx.deps);
    for (const request of await ctx.store.listRequests()) {
      if (request.status === "running") await ctx.store.saveRequest({ ...request, status: "cancelled" });
    }
    const after = await tick(ctx.deps);
    expect(after.checks).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(await pinOf(ctx.store, "grok")).toBe("grok-4.7");
    expect(await tick(ctx.deps)).toEqual({ checks: [] });
  });
});

describe("U7 sandbox repo and configuration", () => {
  it("refuses with sandbox_repo_missing once, keeps the tick alive, and resumes once the repo is set", async () => {
    const ctx = await setup();
    await tap(ctx.store, "model_upgrade", "grok:grok-4.8");
    const first = await tick(ctx.deps, {});
    const second = await tick(ctx.deps, { [SANDBOX_ENV]: "  " });
    expect(first.checks).toEqual([expect.objectContaining({ status: "sandbox_repo_missing", launched: 0 })]);
    expect(second.checks).toEqual([expect.objectContaining({ status: "sandbox_repo_missing" })]);
    expect(ctx.cursor.starts).toHaveLength(0);
    const posts = (await ctx.store.listPosts()).filter((post) => post.body.includes("sandbox_repo_missing"));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toContain(SANDBOX_ENV);
    const resumed = await tick(ctx.deps);
    expect(resumed.checks).toEqual([expect.objectContaining({ status: "running", launched: 2 })]);
  });

  it("does not launch when Cursor is not configured", async () => {
    const ctx = await setup();
    await tap(ctx.store, "model_upgrade", "grok:grok-4.8");
    const result = await tick({ ...ctx.deps, cursor: null, cursorConfigured: false });
    expect(result.checks).toEqual([expect.objectContaining({ status: "not_configured", launched: 0 })]);
    expect(await ctx.store.listAgents()).toEqual([]);
  });
});

describe("U7 bots never name a model; the override is internal-only", () => {
  it("refuses a bot that names a model, a non-upgrade bot with the override, and an unknown version", async () => {
    const ctx = await setup();
    const named = await callConnectorTool(ctx.deps, capsAuth, "launch_agent", { role: "builder", brief: "x", idempotencyKey: "n1", repo: "owner/a", model: "grok-4.8" });
    expect(named.structuredContent).toMatchObject({ status: "refused", reason: "callers_never_name_a_model" });
    const lead = await callConnectorTool(ctx.deps, capsAuth, "launch_agent", { role: "builder", brief: "x", idempotencyKey: "n2", repo: "owner/a", requestId: "req-0-2" }, { modelOverride: "grok-4.8" });
    expect(lead.structuredContent).toMatchObject({ status: "refused", reason: "model_override_not_allowed" });
    const bot = await ctx.store.ensureInternalBot({ ownerId: OWNER, name: UPGRADE_BOT_NAME, kind: "other", repos: [SANDBOX], at: TICK });
    const auth: ConnectorAuth = { ...bot, scopes: ["launch_agent"], suspended: false };
    // Non-designer launches need a request (design gate), owned by the launching bot.
    const requestId = "req-upgrade-unit";
    await ctx.store.saveRequest({ id: requestId, ownerId: OWNER, goal: "Upgrade check", status: "running", card: { crew: "upgrade_check" }, evidence: [], assignedBotId: bot.id, repo: SANDBOX, notices: [] });
    const unknown = await callConnectorTool(ctx.deps, auth, "launch_agent", { role: "builder", brief: "x", idempotencyKey: "n3", repo: SANDBOX, requestId }, { modelOverride: "grok-9-unknown" });
    expect(unknown.structuredContent).toMatchObject({ status: "refused", reason: "model_override_unknown" });
    const wrongFamily = await callConnectorTool(ctx.deps, auth, "launch_agent", { role: "builder", brief: "x", idempotencyKey: "n4", repo: SANDBOX, requestId }, { modelOverride: "gpt-5.7-sol" });
    expect(wrongFamily.structuredContent).toMatchObject({ status: "refused", reason: "model_override_unknown" });
    const ok = await callConnectorTool(ctx.deps, auth, "launch_agent", { role: "builder", brief: "x", idempotencyKey: "n5", repo: SANDBOX, requestId }, { modelOverride: "grok-4.8" });
    expect(ok.structuredContent).toMatchObject({ status: "launched", model: "grok-4.8" });
    expect(ctx.cursor.starts.map((spec) => spec.modelId)).toEqual(["grok-4.8"]);
    // The internal bot has no token, so no MCP caller can act as it.
    expect(await ctx.store.authenticate("anything")).toBeNull();
  });

  it("ensureInternalBot is idempotent and follows the sandbox repo", async () => {
    const ctx = await setup();
    const one = await ctx.store.ensureInternalBot({ ownerId: OWNER, name: UPGRADE_BOT_NAME, kind: "other", repos: [SANDBOX], at: TICK });
    const two = await ctx.store.ensureInternalBot({ ownerId: OWNER, name: UPGRADE_BOT_NAME, kind: "other", repos: ["owner/sandbox-2"], at: TICK });
    expect(two.id).toBe(one.id);
    expect(two.repos).toEqual(["owner/sandbox-2"]);
    expect((await ctx.store.listBots()).filter((bot) => bot.name === UPGRADE_BOT_NAME)).toHaveLength(1);
  });
});

describe("U7 injected runner and grader", () => {
  it("a stub runner and grader decide the check without Cursor", async () => {
    const ctx = await setup();
    await tap(ctx.store, "model_upgrade", "grok:grok-4.8");
    const launched: string[] = [];
    const runner = async (run: { idempotencyKey: string; modelId: string }) => {
      launched.push(`${run.modelId}|${run.idempotencyKey}`);
      const bot = await upgradeBot(ctx.store);
      await ctx.store.saveAgent({
        id: `00000000-0000-4000-8000-${String(launched.length).padStart(12, "0")}`,
        ownerId: OWNER,
        botId: bot?.id ?? "",
        cursorHandle: `stub-${launched.length}`,
        repo: SANDBOX,
        role: "builder",
        family: "grok",
        status: "finished",
        idempotencyKey: run.idempotencyKey,
        result: null,
      });
      return { status: "launched" };
    };
    const grader = async (agent: ConnectorAgent) => ({ passed: !agent.idempotencyKey.includes("grok-4.8"), checksFailed: 0 });
    const first = await tick(ctx.deps, ENV, { runner, grader });
    expect(first.checks[0]?.launched).toBe(10);
    const second = await tick(ctx.deps, ENV, { runner, grader });
    expect(second.checks).toEqual([expect.objectContaining({ status: "kept" })]);
    expect(ctx.cursor.starts).toHaveLength(0);
    expect(launched).toHaveLength(10);
  });
});

describe("U7 the tick", () => {
  it("the tick runs the upgrade step last (reconcile -> fleet -> pins -> selftest -> jobScan -> upgrade) and answers 200", async () => {
    const previous = process.env.DEXTER_TICK_SECRET;
    process.env.DEXTER_TICK_SECRET = "unit-upgrade-tick-secret";
    try {
      const result = await postTick("unit-upgrade-tick-secret");
      expect(result.status).toBe(200);
      expect(Object.keys(result.body as Record<string, unknown>)).toEqual(["ok", "reconcile", "fleet", "pins", "selftest", "jobScan", "upgrade"]);
      expect((result.body as Record<string, unknown>).upgrade).toEqual({ checks: [] });
    } finally {
      if (previous === undefined) delete process.env.DEXTER_TICK_SECRET;
      else process.env.DEXTER_TICK_SECRET = previous;
    }
  });

  it("a throw in the upgrade step fails soft and never leaks a database URL", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      const result = await upgradeTickStep(async () => {
        throw new Error("boom postgres://user:secret@host/db");
      });
      expect(result).toEqual({ status: "error" });
      expect(logged.join(" ")).not.toContain("secret");
      expect(logged.join(" ")).toContain("[db]");
    } finally {
      spy.mockRestore();
    }
  });

  it("an upgrade switch row before the daily check does not count as today's check", async () => {
    const ctx = await setup();
    // DAY1's check already ran in setup. On DAY2 a switch happens before the daily check.
    await ctx.store.switchPin({ ownerId: OWNER, family: "grok", from: "grok-4.7", to: "grok-4.8", reason: "upgrade: test", at: "2026-10-09T00:01:00.000Z" });
    expect(await ctx.store.pinsResolvedSince(OWNER, "2026-10-09T00:00:00.000Z")).toBe(false);
    const day2 = await resolveDailyPins({ store: ctx.store, cursor: ctx.cursor, sheetText, now: () => "2026-10-09T00:05:00.000Z", ownerIds: [OWNER] });
    expect(day2.owners[0]?.status).toBe("recorded");
    expect(await pinOf(ctx.store, "grok")).toBe("grok-4.8");
  });
});


describe("U7 upgrade cards come only from HQ", () => {
  it("a bot cannot raise a model_upgrade, upgrade_rollback or council_upgrade card", async () => {
    const ctx = await setup();
    for (const action of ["model_upgrade", "upgrade_rollback", "council_upgrade", "Model-Upgrade", " upgrade rollback "]) {
      const result = await callConnectorTool(ctx.deps, capsAuth, "request_approval", { action, target: "grok:grok-4.8->grok-4.6" });
      expect(result.structuredContent).toMatchObject({ status: "refused", reason: "hq_only_action" });
    }
    expect((await ctx.store.listApprovals()).filter((row) => row.action !== "model_upgrade")).toEqual([]);
  });

  it("an approved switch card never pins a version the family has not seen", async () => {
    const ctx = await setup();
    await ctx.store.saveApproval({ id: "forged", ownerId: OWNER, action: "upgrade_rollback", target: "grok:grok-4.7->grok-evil", status: "pending", requestId: null });
    const result = await decideApproval(ctx.store, { approvalId: "forged", decision: "approved", now: () => TAP });
    expect(result).toMatchObject({ status: "approved", ran: false, execution: { status: "error", reason: "unknown_version" } });
    expect(await pinOf(ctx.store, "grok")).toBe("grok-4.7");
  });
});
