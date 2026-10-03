import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakeRuntime } from "../../adapters/fake.ts";
import { signAuthor, deadEndActive, verifyFinding } from "../../kernel/board.ts";
import { idempotencyKey, remember } from "../../kernel/idempotency.ts";
import { StaleGeneration, assertFresh, leaseExpired, nextGeneration } from "../../kernel/lease.ts";
import { validatePlanCard } from "../../kernel/plan-card.ts";
import { charge, nextPool, reservePoolRun, reserveSlot, shouldPause, substantiveRetryAllowed } from "../../kernel/police.ts";
import { preflight } from "../../kernel/preflight.ts";
import { redact } from "../../kernel/redact.ts";
import { capForPool, parseRoleSheet, resolveRouting, sheetFamilies } from "../../kernel/role-sheet.ts";
import { DossierSchema, RequestSchema } from "../../kernel/schemas.ts";
import { requestTransitionAllowed, taskTransitionAllowed } from "../../kernel/state.ts";
import type { ModelRow, PlanCard, RoleSheet } from "../../kernel/types.ts";
import { mergeVerdicts } from "../../kernel/verdict.ts";

const secret = ["sk", "testFAKEvalue1234567890"].join("-");

function row(partial: Partial<ModelRow> & Pick<ModelRow, "id" | "family" | "pool">): ModelRow {
  return {
    version: "1",
    variant: "standard",
    pricePerToken: 1,
    trainsOnPrompts: false,
    available: true,
    releasedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function sheet(): RoleSheet {
  return {
    version: 2,
    ceo: { family: "lead", reasoningEffort: "medium", pool: "decisions", onUnavailable: "hold_and_notify" },
    roles: {
      builder: { family: "alpha", pool: "p1" },
      quick_edit: { family: "beta", pool: "p1" },
      reserve: { family: "gamma", pool: "p3", weeklyRunCap: 10 },
    },
    councilFamilies: ["alpha", "lead", "beta"],
    poolOrder: ["p1", "p2", "p3"],
    quickEditRule: { maxChangedLines: 50, excludedPaths: ["auth", "payments", "migrations", "secrets"] },
    escalation: {
      afterFailedChecks: 2,
      ladders: { quick_edit: ["beta", "alpha"], builder: ["alpha", "beta"] },
    },
    versionPolicy: { variant: "standard", priceGuard: "no_increase" },
  };
}

describe("state and lease", () => {
  it("allows a legal task edge and rejects a skip to done", () => {
    expect(taskTransitionAllowed("leased", "working")).toBe(true);
    expect(taskTransitionAllowed("leased", "done")).toBe(false);
    expect(requestTransitionAllowed("verifying", "ready_for_review")).toBe(true);
    expect(requestTransitionAllowed("done", "running")).toBe(false);
  });

  it("rejects a stale generation and advances the counter", () => {
    expect(() => assertFresh(2, 1)).toThrow(StaleGeneration);
    expect(nextGeneration(2)).toBe(3);
    expect(leaseExpired("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z")).toBe(true);
  });
});

describe("idempotency and police", () => {
  it("repeats a key and a stored value", async () => {
    const key = await idempotencyKey(["task", "run"]);
    expect(key).toBe(await idempotencyKey(["task", "run"]));
    expect(key).not.toBe(await idempotencyKey(["task", "other"]));
    const store = new Map<string, number>();
    expect(remember(store, key, () => 1)).toEqual({ value: 1, duplicate: false });
    expect(remember(store, key, () => 2)).toEqual({ value: 1, duplicate: true });
  });

  it("stops at three slots, the weekly cap, 80 percent, and one retry", () => {
    let active = 0;
    for (let i = 0; i < 5; i += 1) active = reserveSlot(active).active;
    expect(active).toBe(3);
    expect(reserveSlot(3).ok).toBe(false);
    let reserved = 0;
    let wins = 0;
    for (let i = 0; i < 25; i += 1) {
      const next = reservePoolRun(reserved, 10);
      reserved = next.reserved;
      if (next.ok) wins += 1;
    }
    expect(wins).toBe(10);
    expect(reserved).toBe(10);
    expect(shouldPause(8, 10, false)).toBe(true);
    expect(shouldPause(8, 10, true)).toBe(false);
    expect(shouldPause(7, 10, false)).toBe(false);
    expect(substantiveRetryAllowed(0)).toBe(true);
    expect(substantiveRetryAllowed(1)).toBe(false);
    const first = charge(0, 3, 5);
    const second = charge(first.used, 3, 5);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.used).toBe(3);
    expect(nextPool(["p1", "p2", "p3"], new Set(["p1"]))).toBe("p2");
    expect(nextPool(["p1"], new Set(["p1"]))).toBeNull();
  });
});

describe("role sheet", () => {
  const live = parseRoleSheet(readFileSync("gateway/role-sheet.yaml", "utf8"));

  it("parses the checked-in sheet and keeps families inside it", () => {
    expect(live.poolOrder[0]).toBe(live.roles.builder?.pool);
    expect(live.escalation.afterFailedChecks).toBe(2);
    expect(capForPool(live, live.roles.reserve?.pool ?? "")).toBe(live.roles.reserve?.weeklyRunCap);
    const decision = resolveRouting({
      sheet: live,
      role: "builder",
      catalog: [row({ id: "b", family: live.roles.builder?.family ?? "", pool: live.roles.builder?.pool ?? "" })],
    });
    expect(decision.status).toBe("resolved");
    expect(sheetFamilies(live).has(decision.family ?? "")).toBe(true);
  });

  it("never selects a family that is not on the sheet", () => {
    const decision = resolveRouting({
      sheet: live,
      role: "builder",
      catalog: [row({ id: "outsider", family: "not-on-the-sheet", pool: live.roles.builder?.pool ?? "", pricePerToken: 0 })],
    });
    expect(decision.status).toBe("hold");
    expect(decision.modelRowId).toBeNull();
    expect(decision.family).not.toBe("not-on-the-sheet");
  });

  it("holds when the lead family is missing instead of swapping", () => {
    const other = live.roles.builder?.family ?? "alpha";
    const missing = resolveRouting({
      sheet: live,
      role: "ceo",
      catalog: [row({ id: "other", family: other, pool: live.ceo.pool })],
    });
    expect(missing.status).toBe("hold");
    expect(missing.modelRowId).toBeNull();
    expect(missing.alert).toBe("hold_and_notify");
    const present = resolveRouting({
      sheet: live,
      role: "ceo",
      catalog: [
        row({ id: "other", family: other, pool: live.ceo.pool }),
        row({ id: "lead", family: live.ceo.family, pool: live.ceo.pool }),
      ],
    });
    expect(present.family).toBe(live.ceo.family);
    expect(present.modelRowId).toBe("lead");
    expect(present.routingReason).toBe("ceo");
  });

  it("uses the quick-edit family, then the next ladder rung, and logs the move", () => {
    const quick = live.roles.quick_edit?.family ?? "";
    const ladder = live.escalation.ladders.quick_edit ?? [];
    const catalog = ladder.map((family, index) =>
      row({ id: `q${index}`, family, pool: live.roles.quick_edit?.pool ?? "" }),
    );
    const first = resolveRouting({ sheet: live, role: "builder", quickEdit: true, catalog });
    expect(first.family).toBe(quick);
    expect(first.escalation).toBeNull();
    const escalated = resolveRouting({
      sheet: live,
      role: "builder",
      quickEdit: true,
      failedChecks: live.escalation.afterFailedChecks,
      catalog,
    });
    expect(escalated.family).toBe(ladder[1]);
    expect(escalated.escalation).toEqual({
      from: ladder[0],
      to: ladder[1],
      failedChecks: live.escalation.afterFailedChecks,
    });
  });

  it("refuses a quick edit on an excluded path", () => {
    const decision = resolveRouting({
      sheet: live,
      role: "builder",
      quickEdit: true,
      change: { lines: 3, paths: ["src/auth/session.ts"] },
      catalog: [
        row({ id: "b", family: live.roles.builder?.family ?? "", pool: live.roles.builder?.pool ?? "" }),
        row({ id: "q", family: live.roles.quick_edit?.family ?? "", pool: live.roles.quick_edit?.pool ?? "" }),
      ],
    });
    expect(decision.family).toBe(live.roles.builder?.family);
  });

  it("keeps pool order and falls forward only after the preferred pool is exhausted", () => {
    const decision = resolveRouting({
      sheet: sheet(),
      role: "builder",
      exhaustedPools: ["p1"],
      catalog: [
        row({ id: "a", family: "alpha", pool: "p1" }),
        row({ id: "g", family: "gamma", pool: "p3" }),
      ],
    });
    expect(decision.pool).toBe("p3");
    expect(decision.family).toBe("gamma");
    expect(decision.routingReason).toContain("pool_fallback");
    const open = resolveRouting({
      sheet: sheet(),
      role: "builder",
      catalog: [
        row({ id: "a", family: "alpha", pool: "p1" }),
        row({ id: "g", family: "gamma", pool: "p3", pricePerToken: 0 }),
      ],
    });
    expect(open.pool).toBe("p1");
    expect(open.family).toBe("alpha");
  });

  it("rejects fast, max, preview, and a higher price, and refuses prompt-training rows", () => {
    const base = sheet();
    const held = resolveRouting({
      sheet: base,
      role: "builder",
      catalog: [row({ id: "fast", family: "alpha", pool: "p1", variant: "fast" })],
    });
    expect(held.status).toBe("hold");
    expect(held.alert).toBe("price_or_variant");
    const priced = resolveRouting({
      sheet: base,
      role: "builder",
      current: [{ family: "alpha", version: "1", pricePerToken: 1 }],
      catalog: [
        row({ id: "old", family: "alpha", pool: "p1", version: "1", pricePerToken: 1, releasedAt: "2026-01-01T00:00:00.000Z" }),
        row({ id: "new", family: "alpha", pool: "p1", version: "2", pricePerToken: 5, releasedAt: "2026-06-01T00:00:00.000Z" }),
        row({ id: "preview", family: "alpha", pool: "p1", variant: "preview", pricePerToken: 1, releasedAt: "2026-07-01T00:00:00.000Z" }),
      ],
    });
    expect(priced.modelRowId).toBe("old");
    const samePrice = resolveRouting({
      sheet: base,
      role: "builder",
      current: [{ family: "alpha", version: "1", pricePerToken: 2 }],
      catalog: [
        row({ id: "old", family: "alpha", pool: "p1", version: "1", pricePerToken: 2, releasedAt: "2026-01-01T00:00:00.000Z" }),
        row({ id: "new", family: "alpha", pool: "p1", version: "2", pricePerToken: 2, releasedAt: "2026-06-01T00:00:00.000Z" }),
      ],
    });
    expect(samePrice.modelRowId).toBe("new");
    const privateRow = resolveRouting({
      sheet: base,
      role: "builder",
      sensitivity: "client",
      catalog: [row({ id: "train", family: "alpha", pool: "p1", trainsOnPrompts: true })],
    });
    expect(privateRow.status).toBe("hold");
    expect(privateRow.alert).toBe("privacy");
    const safe = resolveRouting({
      sheet: base,
      role: "builder",
      sensitivity: "personal",
      catalog: [
        row({ id: "train", family: "alpha", pool: "p1", trainsOnPrompts: true, releasedAt: "2026-08-01T00:00:00.000Z" }),
        row({ id: "safe", family: "alpha", pool: "p1", trainsOnPrompts: false, releasedAt: "2026-01-01T00:00:00.000Z" }),
      ],
    });
    expect(safe.modelRowId).toBe("safe");
  });

  it("holds council routing when every pool is exhausted", () => {
    const decision = resolveRouting({
      sheet: sheet(),
      role: "security",
      council: true,
      makerFamily: "alpha",
      exhaustedPools: ["p1", "p2", "p3"],
      catalog: [row({ id: "b", family: "beta", pool: "p1" })],
    });
    expect(decision.status).toBe("hold");
    expect(decision.alert).toBe("pools_exhausted");
    expect(decision.modelRowId).toBeNull();
  });

  it("holds a max variant even when it is newer", () => {
    const decision = resolveRouting({
      sheet: sheet(),
      role: "builder",
      catalog: [
        row({ id: "max", family: "alpha", pool: "p1", variant: "max", releasedAt: "2026-08-01T00:00:00.000Z" }),
        row({ id: "std", family: "alpha", pool: "p1", variant: "standard", releasedAt: "2026-01-01T00:00:00.000Z" }),
      ],
    });
    expect(decision.modelRowId).toBe("std");
  });
});

describe("plan, board, preflight, redact", () => {
  const card = (partial: Partial<PlanCard>): PlanCard => ({
    crew: "answer",
    personas: ["builder"],
    councilMode: "off",
    tier: "T1",
    definitionOfDone: "done",
    outOfScope: "",
    needsOwner: [],
    newScreen: false,
    outwardAction: false,
    requiresDesignApproval: false,
    requiresApproval: false,
    ...partial,
  });

  it("forces the design gate, approval, adversarial review, and the nearest shipped crew", () => {
    const validated = validatePlanCard(
      card({ crew: "web3", newScreen: true, outwardAction: true, tier: "T3", councilMode: "off" }),
      ["answer", "custom"],
    );
    expect(validated.card.requiresDesignApproval).toBe(true);
    expect(validated.card.needsOwner).toContain("design");
    expect(validated.card.requiresApproval).toBe(true);
    expect(validated.card.councilMode).toBe("adversarial");
    expect(validated.card.crew).toBe("custom");
    expect(validated.notices.join(" ")).toContain("unshipped_crew");
  });

  it("verifies a finding only from another author or a deterministic check", () => {
    const post = { type: "finding" as const, status: "claimed" as const, author: "a" };
    expect(verifyFinding(post, { author: "a", deterministic: false }).ok).toBe(false);
    expect(verifyFinding(post, { author: "b", deterministic: false }).ok).toBe(true);
    expect(verifyFinding(post, { author: "a", deterministic: true }).ok).toBe(true);
    expect(deadEndActive(null, "2026-01-01T00:00:00.000Z")).toBe(false);
    expect(deadEndActive("2026-02-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(true);
    expect(deadEndActive("2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z")).toBe(false);
  });

  it("flags a seeded secret without echoing it, and redacts it", () => {
    const text = `token ${secret} and drop table users; see https://example.test/a`;
    const findings = preflight(text, ["known.test"]);
    expect(findings.some((finding) => finding.kind === "secret")).toBe(true);
    expect(findings.some((finding) => finding.kind === "destructive")).toBe(true);
    expect(findings.some((finding) => finding.kind === "unknown_url")).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(secret);
    expect(redact(text)).not.toContain(secret);
    expect(redact(text)).toContain("[redacted]");
    expect(preflight("https://known.test/ok", ["known.test"])).toEqual([]);
  });

  it("merges verdicts to the strongest result", () => {
    expect(mergeVerdicts([
      { result: "pass", actions: ["keep"] },
      { result: "changes", actions: ["keep", "fix"] },
    ])).toEqual({ result: "changes", actions: ["keep", "fix"] });
    expect(mergeVerdicts([{ result: "pass", actions: [] }, { result: "discuss", actions: ["ask"] }]).result).toBe("discuss");
  });

  it("accepts a dossier and a request", () => {
    expect(DossierSchema.parse({
      status: "done",
      done: ["a"],
      verified: [],
      unverified: [],
      findings: [{ claim: "c", evidence: "e", confidence: 0.5 }],
      deadEnds: [{ approach: "a", why: "w", conditions: "c" }],
      nextAction: "stop",
    }).status).toBe("done");
    expect(RequestSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      ownerId: "22222222-2222-4222-8222-222222222222",
      goal: "ship",
      crew: "answer",
      tier: "T1",
      planVersion: 1,
      definitionOfDone: "shown",
      status: "queued",
      priority: 0,
      permissionsProfile: "green",
      caps: {},
      projectId: null,
      sketchHash: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    }).status).toBe("queued");
  });
});

describe("fake runtime", () => {
  it("is deterministic and does not touch the network", async () => {
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      called = true;
      throw new Error("network");
    }) as typeof fetch;
    try {
      const runtime = createFakeRuntime({
        artifacts: [{
          id: "33333333-3333-4333-8333-333333333333",
          ownerId: "22222222-2222-4222-8222-222222222222",
          type: "file",
          contentHash: "abc",
          location: "memory",
          producer: "fake",
          versionOrCommit: null,
        }],
      });
      const spec = { idempotencyKey: "same", taskId: "task" };
      const first = await runtime.start(spec);
      const second = await runtime.start(spec);
      expect(second).toEqual(first);
      expect((await runtime.status(first)).state).toBe("running");
      expect((await runtime.cancel(first)).state).toBe("confirmed");
      expect((await runtime.status(first)).state).toBe("cancelled");
      expect(await runtime.collect(first)).toHaveLength(1);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("signs an author with web crypto", async () => {
    const sig = await signAuthor("kernel", "not-a-secret");
    expect(sig).toBe(await signAuthor("kernel", "not-a-secret"));
    expect(sig).not.toBe(await signAuthor("other", "not-a-secret"));
  });
});
