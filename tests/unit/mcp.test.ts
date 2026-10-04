import { describe, expect, it } from "vitest";
import { CONNECTOR_IDENTITY, handleMcpHttp } from "../../hq/mcp.ts";

const endpoint = "http://127.0.0.1/api/mcp";

async function mcpPost(body: unknown, extra?: Record<string, string>): Promise<Response> {
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
  );
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
    const callBody = (await whoami.json()) as {
      jsonrpc: string;
      id: number;
      result: {
        isError: boolean;
        structuredContent: typeof CONNECTOR_IDENTITY;
        content: { type: string; text: string }[];
      };
    };
    expect(callBody.jsonrpc).toBe("2.0");
    expect(callBody.id).toBe(3);
    expect(callBody.result.isError).toBe(false);
    expect(callBody.result.structuredContent).toEqual(CONNECTOR_IDENTITY);
    expect(callBody.result.content[0]?.type).toBe("text");
    expect(JSON.parse(callBody.result.content[0].text)).toEqual(CONNECTOR_IDENTITY);
  });
});
