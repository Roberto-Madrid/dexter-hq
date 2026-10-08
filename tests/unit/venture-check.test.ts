import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { callConnectorTool, createDefaultConnectorDeps, hashBotToken, loadConnectorSheetText } from "../../hq/connector.ts";
import { createMemoryConnectorStore } from "../../hq/connector-store.ts";
import { SHIPPED_CREWS, loadCrews } from "../../hq/crews.ts";
import { composeLaunchBrief, loadPersonas, personaIdForRole } from "../../hq/personas.ts";
import { validatePlanCard } from "../../kernel/plan-card.ts";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import type { PlanCard } from "../../kernel/types.ts";
import { pinRows } from "./pin-fixtures.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const SCOUT = "55555555-5555-4555-8555-555555555555";
const TOKEN = "unit-venture-scout";
const SCOPES = ["whoami", "open_request", "launch_agent", "post", "request_approval", "heartbeat"];

function card(partial: Partial<PlanCard> = {}): PlanCard {
  return {
    crew: "venture-check",
    personas: ["researcher", "venture"],
    councilMode: "standard",
    tier: "T2",
    definitionOfDone: "a sourced recommendation on the board",
    outOfScope: "building it",
    needsOwner: [],
    newScreen: false,
    outwardAction: false,
    requiresDesignApproval: false,
    requiresApproval: false,
    ...partial,
  };
}

function harness(briefs: string[] = []) {
  const store = createMemoryConnectorStore({
    modelResolutions: pinRows(OWNER),
    bots: [{ id: SCOUT, ownerId: OWNER, name: "scout", kind: "ceo", repos: ["owner/demo"], tools: SCOPES, currentTask: null, heartbeatAt: null }],
    tokens: [{ tokenHash: hashBotToken(TOKEN), botId: SCOUT, scopes: SCOPES }],
  });
  const deps = createDefaultConnectorDeps({
    store,
    sheet: parseRoleSheet(loadConnectorSheetText()),
    cursor: {
      async start(spec: { brief?: string }) {
        briefs.push(spec.brief ?? "");
        return { id: `agent-${briefs.length}`, runtime: "cursor-cloud" as const };
      },
      async status() {
        return { state: "running", usage: {} };
      },
      async cancel() {
        return { state: "confirmed" as const };
      },
      async collect() {
        return [];
      },
    },
    cursorConfigured: true,
    checker: null,
    ownerId: OWNER,
    now: () => "2026-10-08T17:00:00.000Z",
  });
  return { store, deps };
}

describe("venture-check crew", () => {
  it("ships Researcher then Venture at standard Council, tier T2, as the plan's catalog says", () => {
    const raw = parse(readFileSync("crews/venture-check.yaml", "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({ name: "venture-check", tier: "T2", council: "standard", personas: ["researcher", "venture"] });
    const crew = loadCrews().get("venture-check");
    expect(crew?.tasks).toEqual([
      { persona: "researcher", role: "researcher", artifact: "note", dependsOn: [] },
      { persona: "venture", role: "venture", artifact: "note", dependsOn: ["researcher"] },
    ]);
    const sheet = parseRoleSheet(readFileSync("gateway/role-sheet.yaml", "utf8"));
    const personas = loadPersonas();
    for (const task of crew?.tasks ?? []) {
      expect(sheet.roles[task.role]).toBeDefined();
      expect(personas.has(task.persona)).toBe(true);
    }
  });

  it("is a shipped crew: a plan card keeps it with no fallback notice", () => {
    expect(SHIPPED_CREWS as readonly string[]).toContain("venture-check");
    const validated = validatePlanCard(card(), SHIPPED_CREWS);
    expect(validated.card.crew).toBe("venture-check");
    expect(validated.notices).toEqual([]);
  });

  it("the venture persona posts a brief to the board and acts outward only through an approval card", () => {
    expect(personaIdForRole("venture")).toBe("venture");
    const text = loadPersonas().get("venture") ?? "";
    expect(text.split("\n").length).toBeLessThan(60);
    expect(text).toMatch(/recommendation/i);
    expect(text).toMatch(/post/i);
    expect(text).toMatch(/approval card/i);
    for (const outward of ["email", "spend", "sign up"]) expect(text.toLowerCase()).toContain(outward);
  });
});

describe("venture-check through the connector", () => {
  it("opens a queued request on the shipped crew", async () => {
    const { store, deps } = harness();
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", { goal: "Is a barber booking app worth building?", repo: "owner/demo", card: card() });
    expect(opened.isError).toBe(false);
    const request = await store.getRequest(String(opened.structuredContent.requestId));
    expect(request?.status).toBe("queued");
    expect(request?.card).toMatchObject({ crew: "venture-check", notices: [] });
  });

  it("an outward step waits for the owner's approval card", async () => {
    const { store, deps } = harness();
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Check the idea and email three barbers",
      repo: "owner/demo",
      card: card({ outwardAction: true }),
    });
    const request = await store.getRequest(String(opened.structuredContent.requestId));
    expect(request?.status).toBe("needs_you");
    expect(request?.card).toMatchObject({ crew: "venture-check", requiresApproval: true });
    expect(request?.card?.needsOwner).toContain("approval");
  });

  it("launches the venture role with the venture persona contract", async () => {
    const briefs: string[] = [];
    const { store, deps } = harness(briefs);
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", { goal: "Worth it?", repo: "owner/demo", card: card() });
    const launched = await callConnectorTool(deps, auth, "launch_agent", {
      repo: "owner/demo",
      role: "venture",
      brief: "Give a go / no-go on the barber idea.",
      idempotencyKey: "venture-1",
      requestId: opened.structuredContent.requestId,
    });
    expect(launched.structuredContent).toMatchObject({ persona: "venture" });
    expect(briefs[0]?.startsWith("Persona contract (venture):")).toBe(true);
    expect(composeLaunchBrief("venture", "x").persona).toBe("venture");
  });
});
