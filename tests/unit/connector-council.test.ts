import { describe, expect, it } from "vitest";
import {
  callConnectorTool,
  createDefaultConnectorDeps,
  createMemoryConnectorStore,
  hashBotToken,
  loadConnectorSheetText,
  type CouncilSeatFn,
} from "../../hq/connector.ts";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import { VerdictSchema } from "../../kernel/schemas.ts";
import type { ConnectorAuth } from "../../hq/connector-store.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const TOKEN = "unit-council-token";

const auth: ConnectorAuth = {
  id: BOT,
  ownerId: OWNER,
  name: "unit-lead",
  kind: "lead",
  repos: ["owner/demo"],
  tools: ["whoami", "request_council"],
  currentTask: null,
  heartbeatAt: null,
  scopes: ["whoami", "request_council"],
  suspended: false,
};

function councilDeps(options?: { councilConfigured?: boolean; runCouncilSeat?: CouncilSeatFn }) {
  const store = createMemoryConnectorStore({
    bots: [auth],
    tokens: [{ tokenHash: hashBotToken(TOKEN), botId: BOT, scopes: auth.scopes }],
  });
  return createDefaultConnectorDeps({
    store,
    sheet: parseRoleSheet(loadConnectorSheetText()),
    cursor: null,
    cursorConfigured: false,
    ownerId: OWNER,
    councilConfigured: options?.councilConfigured ?? false,
    runCouncilSeat: options?.runCouncilSeat,
  });
}

describe("connector request_council", () => {
  it("does not invent a verdict when the path B login is absent", async () => {
    const deps = councilDeps({ councilConfigured: false });
    const result = await callConnectorTool(deps, auth, "request_council", {
      requestId: "req-1",
      packet: "Diff: function greet(name) { return name.toUpperCase(); }",
    });
    const body = result.structuredContent;
    expect(result.isError).toBe(true);
    expect(body.status).toBe("not-configured");
    expect(body.reason).toBe("path_b_login_unavailable");
    expect(body.result).toBeUndefined();
    expect(body.actions).toBeUndefined();
    expect(() => VerdictSchema.parse(body)).toThrow();
    const events = await deps.store.listEvents();
    expect(events.some((event) => event.action === "request_council" && event.result?.status === "not-configured")).toBe(
      true,
    );
    expect(events.some((event) => event.result?.result === "pass" || event.result?.status === "verdict")).toBe(false);
  });

  it("returns a schema-valid verdict from a stubbed seat path and records the event", async () => {
    const deps = councilDeps({
      councilConfigured: true,
      runCouncilSeat: async ({ packet }) => {
        expect(packet).toContain("Diff:");
        return { result: "changes", actions: ["guard null name"] };
      },
    });
    const result = await callConnectorTool(deps, auth, "request_council", {
      requestId: "req-2",
      diff: "function greet(name) { return name.toUpperCase(); }",
      checker: "no tests. name may be null.",
    });
    const body = result.structuredContent;
    expect(result.isError).toBe(false);
    expect(body.status).toBe("verdict");
    expect(body.seat).toBe("critic");
    expect(body.path).toBe("B");
    const verdict = VerdictSchema.parse({ result: body.result, actions: body.actions });
    expect(verdict).toEqual({ result: "changes", actions: ["guard null name"] });
    const events = await deps.store.listEvents();
    expect(
      events.some(
        (event) =>
          event.action === "request_council" &&
          event.target === "req-2" &&
          event.result?.status === "verdict" &&
          event.result.result === "changes",
      ),
    ).toBe(true);
  });

  it("records the call when a stubbed seat refuses to mint a verdict", async () => {
    const deps = councilDeps({
      councilConfigured: true,
      runCouncilSeat: async () => {
        throw new Error("codex_login_missing");
      },
    });
    const result = await callConnectorTool(deps, auth, "request_council", {
      packet: "Diff: x",
    });
    expect(result.structuredContent.status).toBe("not-configured");
    expect(result.structuredContent.result).toBeUndefined();
    const events = await deps.store.listEvents();
    expect(events.some((event) => event.action === "request_council")).toBe(true);
  });
});
