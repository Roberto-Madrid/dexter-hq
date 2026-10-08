import { describe, expect, it } from "vitest";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import {
  createDefaultConnectorDeps,
  createMemoryConnectorStore,
  hashBotToken,
  loadConnectorSheetText,
} from "../../hq/connector.ts";
import { CONNECTOR_IDENTITY, handleMcpHttp } from "../../hq/mcp.ts";
import { pinRows } from "./pin-fixtures.ts";

const endpoint = "http://127.0.0.1/api/mcp";
const OWNER = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const TOKEN = "unit-connector-token";

async function mcpPost(
  body: unknown,
  extra?: Record<string, string>,
  deps?: Parameters<typeof handleMcpHttp>[1],
): Promise<Response> {
  return handleMcpHttp(
    new Request(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        origin: "http://127.0.0.1",
        ...extra,
      },
      body: JSON.stringify(body),
    }),
    deps,
  );
}

function callBody(name: string, args: Record<string, unknown>, id = 3) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function leadDeps(options?: { stopped?: boolean; scopes?: string[]; cursorConfigured?: boolean }) {
  const store = createMemoryConnectorStore({
    stopped: options?.stopped ?? false,
    modelResolutions: pinRows(OWNER),
    bots: [
      {
        id: BOT,
        ownerId: OWNER,
        name: "unit-lead",
        kind: "lead",
        repos: ["owner/demo"],
        tools: ["whoami", "launch_agent", "heartbeat"],
        currentTask: null,
        heartbeatAt: null,
      },
    ],
    tokens: [
      {
        tokenHash: hashBotToken(TOKEN),
        botId: BOT,
        scopes: options?.scopes ?? ["whoami", "launch_agent", "heartbeat"],
      },
    ],
  });
  return createDefaultConnectorDeps({
    store,
    sheet: parseRoleSheet(loadConnectorSheetText()),
    cursor: null,
    cursorConfigured: options?.cursorConfigured ?? false,
    ownerId: OWNER,
  });
}

async function queuedRequest(store: ReturnType<typeof createMemoryConnectorStore>, id = "req-launch") {
  await store.saveRequest({
    id,
    ownerId: OWNER,
    goal: "Change one label.",
    status: "queued",
    card: {
      crew: "change",
      newScreen: false,
      requiresDesignApproval: false,
    },
    evidence: [],
    assignedBotId: BOT,
    repo: "owner/demo",
    notices: [],
  });
  return id;
}

describe("mcp connector stub", () => {
  it("completes initialize and whoami", async () => {
    const init = await mcpPost({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toMatch(/application\/json/);
    const initBody = (await init.json()) as {
      jsonrpc: string;
      id: number;
      result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } };
    };
    expect(initBody.jsonrpc).toBe("2.0");
    expect(initBody.id).toBe(1);
    expect(initBody.result.protocolVersion).toBe("2025-03-26");
    expect(initBody.result.serverInfo.name).toBe(CONNECTOR_IDENTITY.id);
    expect(initBody.result.capabilities.tools).toEqual({});

    const initialized = await mcpPost(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { "mcp-protocol-version": "2025-03-26" },
    );
    expect(initialized.status).toBe(202);

    const listed = await mcpPost(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { "mcp-protocol-version": "2025-03-26" },
    );
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { result: { tools: { name: string }[] } };
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual(["whoami"]);

    const whoami = await mcpPost(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } },
      { "mcp-protocol-version": "2025-03-26" },
    );
    expect(whoami.status).toBe(200);
    const whoamiBody = (await whoami.json()) as {
      jsonrpc: string;
      id: number;
      result: {
        isError: boolean;
        structuredContent: typeof CONNECTOR_IDENTITY;
        content: { type: string; text: string }[];
      };
    };
    expect(whoamiBody.jsonrpc).toBe("2.0");
    expect(whoamiBody.id).toBe(3);
    expect(whoamiBody.result.isError).toBe(false);
    expect(whoamiBody.result.structuredContent).toEqual(CONNECTOR_IDENTITY);
    expect(whoamiBody.result.content[0]?.type).toBe("text");
    expect(JSON.parse(whoamiBody.result.content[0].text)).toEqual(CONNECTOR_IDENTITY);
  });

  it("rejects an unknown tool", async () => {
    const response = await mcpPost(callBody("not_a_tool", {}));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toBe("unknown tool");
  });

  it("blocks a mutating tool when the stop flag is on", async () => {
    const deps = leadDeps({ stopped: true });
    const response = await mcpPost(
      callBody("launch_agent", {
        repo: "owner/demo",
        role: "builder",
        brief: "Change one label.",
        idempotencyKey: "stop-1",
      }),
      { authorization: `Bearer ${TOKEN}` },
      deps,
    );
    const body = (await response.json()) as { result: { isError: boolean; structuredContent: { status: string } } };
    expect(body.result.structuredContent.status).toBe("stopped");
    expect(body.result.isError).toBe(true);
    const events = await deps.store.listEvents();
    expect(events.some((event) => event.action === "launch_agent" && event.result?.status === "stopped")).toBe(true);
  });

  it("refuses a suspended token until resume", async () => {
    const deps = leadDeps();
    const auth = await deps.store.authenticate(hashBotToken(TOKEN));
    expect(auth).not.toBeNull();
    await deps.store.setTokensSuspended(true);
    const paused = await deps.store.authenticate(hashBotToken(TOKEN));
    expect(paused?.suspended).toBe(true);
    const blocked = await mcpPost(
      callBody("launch_agent", {
        repo: "owner/demo",
        role: "builder",
        brief: "Change one label.",
        idempotencyKey: "suspend-mcp-1",
      }),
      { authorization: `Bearer ${TOKEN}` },
      deps,
    );
    const blockedBody = (await blocked.json()) as {
      result: { structuredContent: { status: string; reason?: string } };
    };
    expect(blockedBody.result.structuredContent.status).toBe("stopped");
    expect(blockedBody.result.structuredContent.reason).toBe("suspended");

    await deps.store.setTokensSuspended(false);
    const requestId = await queuedRequest(deps.store);
    const after = await mcpPost(
      callBody("launch_agent", {
        repo: "owner/demo",
        role: "builder",
        brief: "Change one label.",
        idempotencyKey: "suspend-mcp-2",
        requestId,
      }),
      { authorization: `Bearer ${TOKEN}` },
      deps,
    );
    const afterBody = (await after.json()) as { result: { structuredContent: { status: string } } };
    expect(afterBody.result.structuredContent.status).toBe("not-configured");
  });

  it("does not claim success when launch has no key", async () => {
    const deps = leadDeps({ cursorConfigured: false });
    const requestId = await queuedRequest(deps.store);
    const response = await mcpPost(
      callBody("launch_agent", {
        repo: "owner/demo",
        role: "builder",
        brief: "Change one label.",
        idempotencyKey: "launch-1",
        requestId,
      }),
      { authorization: `Bearer ${TOKEN}` },
      deps,
    );
    const body = (await response.json()) as {
      result: { isError: boolean; structuredContent: { status: string; launched?: boolean; agentId?: string } };
    };
    expect(body.result.structuredContent.status).toBe("not-configured");
    expect(body.result.structuredContent.launched).toBe(false);
    expect(body.result.structuredContent.agentId).toBeUndefined();
    expect(body.result.isError).toBe(true);
    const events = await deps.store.listEvents();
    expect(events.some((event) => event.action === "launch_agent" && event.result?.status === "not-configured")).toBe(
      true,
    );
    expect(events.some((event) => event.result?.launched === true)).toBe(false);
  });

  it("exposes request_council and records a not-configured council call", async () => {
    const store = createMemoryConnectorStore({
      bots: [
        {
          id: BOT,
          ownerId: OWNER,
          name: "unit-lead",
          kind: "lead",
          repos: ["owner/demo"],
          tools: ["whoami", "request_council"],
          currentTask: null,
          heartbeatAt: null,
        },
      ],
      tokens: [{ tokenHash: hashBotToken(TOKEN), botId: BOT, scopes: ["whoami", "request_council"] }],
    });
    const deps = createDefaultConnectorDeps({
      store,
      sheet: parseRoleSheet(loadConnectorSheetText()),
      cursor: null,
      cursorConfigured: false,
      councilConfigured: false,
      ownerId: OWNER,
    });
    const listed = await mcpPost(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { authorization: `Bearer ${TOKEN}`, "mcp-protocol-version": "2025-03-26" },
      deps,
    );
    const listBody = (await listed.json()) as { result: { tools: { name: string }[] } };
    expect(listBody.result.tools.map((tool) => tool.name)).toContain("request_council");

    const response = await mcpPost(
      callBody("request_council", { packet: "Diff: x" }),
      { authorization: `Bearer ${TOKEN}` },
      deps,
    );
    const body = (await response.json()) as {
      result: { isError: boolean; structuredContent: { status: string; result?: unknown; actions?: unknown } };
    };
    expect(body.result.structuredContent.status).toBe("not-configured");
    expect(body.result.structuredContent.result).toBeUndefined();
    expect(body.result.structuredContent.actions).toBeUndefined();
    expect(body.result.isError).toBe(true);
    const events = await deps.store.listEvents();
    expect(events.some((event) => event.action === "request_council")).toBe(true);
  });

  it("refuses a token outside its scope", async () => {
    const deps = leadDeps({ scopes: ["whoami"] });
    const response = await mcpPost(
      callBody("launch_agent", {
        repo: "owner/demo",
        role: "builder",
        brief: "Change one label.",
        idempotencyKey: "scope-1",
      }),
      { authorization: `Bearer ${TOKEN}` },
      deps,
    );
    const body = (await response.json()) as { result: { structuredContent: { status: string; reason?: string } } };
    expect(body.result.structuredContent.status).toBe("refused");
    expect(body.result.structuredContent.reason).toBe("out_of_scope");
  });
});
