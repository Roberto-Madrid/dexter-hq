import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { decideApproval } from "../../hq/approval.ts";
import { createDefaultConnectorDeps } from "../../hq/connector.ts";
import { createPgConnectorStore } from "../../hq/connector-pg.ts";
import { UPGRADE_BOT_NAME, type ConnectorApproval, type ConnectorStore, type PinResolution } from "../../hq/connector-store.ts";
import { reconcileConnector } from "../../hq/reconcile.ts";
import { SANDBOX_ENV, UPGRADE_CHECK_DONE, UPGRADE_ROLLBACK_ACTION, advanceUpgradeChecks } from "../../hq/upgrade-check.ts";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import { fakeCursor } from "../unit/caps-fixtures.ts";
import { databaseUrl, newPool } from "./db.ts";

let pool: pg.Pool;
let store: ConnectorStore;
const owners: string[] = [];
const sheet = parseRoleSheet(readFileSync("gateway/role-sheet.yaml", "utf8"));

function newOwner(): string {
  const owner = randomUUID();
  owners.push(owner);
  return owner;
}

async function seedPins(owner: string, at = "2026-10-08T09:00:00.000Z") {
  const rows: PinResolution[] = [
    { family: "grok", version: "grok-4.7", held: false, reason: "baseline" },
    { family: "composer", version: "composer-2.5", held: false, reason: "baseline" },
  ];
  await store.recordPinResolutions({ ownerId: owner, since: "2026-10-08T00:00:00.000Z", at, rows });
  const held = await store.recordPinResolutions({
    ownerId: owner,
    since: "2026-10-09T00:00:00.000Z",
    at: "2026-10-09T09:00:00.000Z",
    rows: [{ family: "grok", version: "grok-4.8", held: true, reason: "held: pinned grok-4.7" }],
  });
  return held.approvals[0] as ConnectorApproval;
}

async function pinOf(owner: string, family: string) {
  return (await store.currentPins(owner)).find((pin) => pin.family === family)?.version;
}

beforeAll(() => {
  pool = newPool();
  store = createPgConnectorStore(databaseUrl());
});

afterAll(async () => {
  for (const owner of owners) await pool.query("delete from public.bots where owner_id = $1", [owner]);
  await pool.end();
});

describe("upgrade check storage (Postgres)", () => {
  it("creates one internal bot with no token, even under concurrent calls, and follows the sandbox repo", async () => {
    const owner = newOwner();
    const at = "2026-10-09T10:00:00.000Z";
    const made = await Promise.all(
      [1, 2, 3].map(() => store.ensureInternalBot({ ownerId: owner, name: UPGRADE_BOT_NAME, kind: "other", repos: ["it/sandbox"], at })),
    );
    expect(new Set(made.map((bot) => bot.id)).size).toBe(1);
    const moved = await store.ensureInternalBot({ ownerId: owner, name: UPGRADE_BOT_NAME, kind: "other", repos: ["it/sandbox-2"], at });
    expect(moved.id).toBe(made[0]?.id);
    const rows = await pool.query("select kind, repos from public.bots where owner_id = $1", [owner]);
    expect(rows.rows).toEqual([{ kind: "other", repos: ["it/sandbox-2"] }]);
    const tokens = await pool.query("select count(*)::int as n from public.bot_tokens where bot_id = $1", [moved.id]);
    expect(tokens.rows[0]?.n).toBe(0);
  });

  it("writes one model_outcomes row per run, even under concurrent calls, linked to the version's resolution row", async () => {
    const owner = newOwner();
    await seedPins(owner);
    const heldRow = (await store.listModelResolutions(owner)).find((row) => row.version === "grok-4.8");
    expect(heldRow?.id).toMatch(/^[0-9a-f-]{36}$/);
    const runId = randomUUID();
    const writes = await Promise.all(
      [1, 2, 3].map(() => store.recordModelOutcome({ ownerId: owner, runId, modelRowId: heldRow?.id ?? null, passed: true, checksFailed: 0, at: "2026-10-09T10:00:00.000Z" })),
    );
    expect(writes.filter(Boolean)).toHaveLength(1);
    const outcomes = await store.listModelOutcomes(owner);
    expect(outcomes).toEqual([expect.objectContaining({ runId, modelRowId: heldRow?.id, passed: true, checksFailed: 0 })]);
  });

  it("applies a check decision once: switch row, rollback card and done event together; a moved pin refuses", async () => {
    const owner = newOwner();
    await seedPins(owner);
    const checkId = randomUUID();
    const approval: ConnectorApproval = { id: randomUUID(), ownerId: owner, action: UPGRADE_ROLLBACK_ACTION, target: "grok:grok-4.8->grok-4.7", status: "pending", requestId: null };
    const input = {
      ownerId: owner,
      checkId,
      at: "2026-10-09T10:00:00.000Z",
      event: { actor: "hq", result: { outcome: "adopted" } },
      pin: { family: "grok", from: "grok-4.7", to: "grok-4.8", reason: `upgrade: check ${checkId} passed` },
      approval,
    };
    const results = await Promise.all([store.applyUpgradeDecision(input), store.applyUpgradeDecision({ ...input, approval: { ...approval, id: randomUUID() } })]);
    expect(results.filter((row) => row.applied)).toHaveLength(1);
    expect(results.find((row) => !row.applied)).toMatchObject({ reason: "already_done" });
    expect(await pinOf(owner, "grok")).toBe("grok-4.8");
    const cards = (await store.listApprovals()).filter((row) => row.ownerId === owner && row.action === UPGRADE_ROLLBACK_ACTION);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: "pending", target: "grok:grok-4.8->grok-4.7" });
    const done = await store.listEventsByAction([UPGRADE_CHECK_DONE]);
    expect(done.filter((event) => event.target === checkId)).toHaveLength(1);

    const other = randomUUID();
    const moved = await store.applyUpgradeDecision({ ...input, checkId: other, approval: undefined, pin: { ...input.pin, from: "grok-4.6" } });
    expect(moved).toEqual({ applied: false, reason: "pin_moved" });
    expect((await store.listEventsByAction([UPGRADE_CHECK_DONE])).some((event) => event.target === other)).toBe(false);
  });

  it("switches a pin only while it is still the expected version, and switch rows never count as the daily check", async () => {
    const owner = newOwner();
    await seedPins(owner);
    const first = await store.switchPin({ ownerId: owner, family: "grok", from: "grok-4.7", to: "grok-4.8", reason: "upgrade: it", at: "2026-10-10T00:01:00.000Z" });
    expect(first).toEqual({ switched: true, current: "grok-4.8" });
    const stale = await store.switchPin({ ownerId: owner, family: "grok", from: "grok-4.7", to: "grok-4.6", reason: "rollback: it", at: "2026-10-10T00:02:00.000Z" });
    expect(stale).toEqual({ switched: false, current: "grok-4.8" });
    expect(await store.pinsResolvedSince(owner, "2026-10-10T00:00:00.000Z")).toBe(false);
    const daily = await store.recordPinResolutions({
      ownerId: owner,
      since: "2026-10-10T00:00:00.000Z",
      at: "2026-10-10T00:05:00.000Z",
      rows: [{ family: "grok", version: "grok-4.8", held: false, reason: "confirmed" }],
    });
    expect(daily.recorded).toBe(true);
  });
});

describe("upgrade check end to end on Postgres (fake Cursor)", () => {
  it("tap → ticks launch through the capped path → pin switches → rollback tap restores it", async () => {
    const owner = newOwner();
    const card = await seedPins(owner);
    const cursor = fakeCursor({ models: [] });
    let clock = "2026-10-09T09:31:00.000Z";
    const deps = createDefaultConnectorDeps({ store, sheet, cursor, cursorConfigured: true, checker: null, ownerId: owner, now: () => clock });
    const tap = await decideApproval(store, { approvalId: card.id, decision: "approved", now: () => "2026-10-09T09:30:00.000Z" });
    expect(tap).toMatchObject({ status: "approved", execution: { reason: "upgrade_check_started" } });
    const env = { [SANDBOX_ENV]: `it/sandbox-${owner.slice(0, 8)}` };
    let status = "running";
    // Other integration files share this database, so a global-cap refusal only delays a round.
    for (let round = 0; round < 40 && status === "running"; round += 1) {
      const result = await advanceUpgradeChecks({ deps, env, ownerIds: [owner] });
      status = result.checks[0]?.status ?? "none";
      cursor.starts.forEach((_spec, index) => {
        const id = `bc-${index + 1}:run-${index + 1}`;
        if (cursor.states.get(id) === "RUNNING") cursor.states.set(id, "FINISHED");
      });
      await reconcileConnector(deps);
    }
    expect(status).toBe("adopted");
    expect(cursor.starts).toHaveLength(10);
    expect(new Set(cursor.starts.map((spec) => spec.idempotencyKey)).size).toBe(10);
    expect(await pinOf(owner, "grok")).toBe("grok-4.8");
    expect((await store.listModelOutcomes(owner)).filter((row) => row.passed)).toHaveLength(10);
    const agents = await pool.query("select b.name, a.repo from public.connector_agents a join public.bots b on b.id = a.bot_id where a.owner_id = $1", [owner]);
    expect(agents.rows.every((row) => row.name === UPGRADE_BOT_NAME && row.repo === env[SANDBOX_ENV])).toBe(true);

    clock = "2026-10-09T12:00:00.000Z";
    const rollback = (await store.listApprovals()).find((row) => row.ownerId === owner && row.action === UPGRADE_ROLLBACK_ACTION);
    expect(rollback?.target).toBe("grok:grok-4.8->grok-4.7");
    const rolled = await decideApproval(store, { approvalId: rollback?.id ?? "", decision: "approved", now: () => clock });
    expect(rolled).toMatchObject({ status: "approved", execution: { status: "ok", reason: "rolled_back" } });
    expect(await pinOf(owner, "grok")).toBe("grok-4.7");
  }, 60_000);
});
