import { parseRoleSheet } from "../kernel/role-sheet.ts";
import { createPgConnectorStore } from "./connector-pg.ts";
import {
  CONNECTOR_TOOLS,
  callConnectorTool,
  connectorToolDescriptors,
  createDefaultConnectorDeps,
  createMemoryConnectorStore,
  hashBotToken,
  loadConnectorSheetText,
  type ConnectorDeps,
} from "./connector.ts";

const JSONRPC = "2.0";
const PROTOCOL_2025_03_26 = "2025-03-26";
const PROTOCOL_2025_06_18 = "2025-06-18";
const SUPPORTED = new Set([PROTOCOL_2025_03_26, PROTOCOL_2025_06_18]);

export const CONNECTOR_IDENTITY = {
  id: "dexter-connector-stub",
  name: "Dexter connector",
  kind: "stub",
  scopes: [] as string[],
  stopped: false,
} as const;

const WHOAMI_TOOL = {
  name: "whoami",
  description: "Return this connector's identity. It does not perform an action.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
} as const;

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

function jsonHeaders(extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return headers;
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: JSONRPC, id, result }), {
    status: 200,
    headers: jsonHeaders(),
  });
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: JSONRPC, id, error: { code, message } }), {
    status,
    headers: jsonHeaders(),
  });
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isRequest(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && message.id !== undefined;
}

function isNotification(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && message.id === undefined && message.result === undefined && message.error === undefined;
}

function negotiateVersion(requested: unknown): string {
  if (typeof requested === "string" && SUPPORTED.has(requested)) return requested;
  return PROTOCOL_2025_03_26;
}

function headerVersion(request: Request, method: unknown): string | Response | null {
  const header = request.headers.get("mcp-protocol-version");
  if (!header) return null;
  if (!SUPPORTED.has(header)) {
    return new Response("unsupported protocol version", { status: 400 });
  }
  if (method === "initialize") return null;
  return header;
}

function initializeResult(params: unknown) {
  const requested =
    params && typeof params === "object" && "protocolVersion" in params
      ? (params as { protocolVersion?: unknown }).protocolVersion
      : undefined;
  return {
    protocolVersion: negotiateVersion(requested),
    capabilities: { tools: {} },
    serverInfo: { name: CONNECTOR_IDENTITY.id, version: "0.0.0" },
    instructions: "Stage 0 stub. Call whoami for the fixed identity.",
  };
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function createLiveConnectorDeps(): ConnectorDeps {
  const url = process.env.SUPABASE_DB_URL;
  return createDefaultConnectorDeps({
    store: url ? createPgConnectorStore(url) : createMemoryConnectorStore(),
    sheet: parseRoleSheet(loadConnectorSheetText()),
  });
}

function defaultTestSafeDeps(): ConnectorDeps {
  return createDefaultConnectorDeps({
    store: createMemoryConnectorStore(),
    cursorConfigured: false,
    cursor: null,
    councilConfigured: false,
  });
}

async function handleMethod(
  method: string,
  params: unknown,
  id: JsonRpcId,
  request: Request,
  deps: ConnectorDeps,
): Promise<Response> {
  const token = bearerToken(request);
  const auth = token ? await deps.store.authenticate(hashBotToken(token)) : null;
  if (method === "initialize") return rpcResult(id, initializeResult(params));
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    if (!auth) return rpcResult(id, { tools: [WHOAMI_TOOL] });
    const names = CONNECTOR_TOOLS.filter((name) => {
      const allowed = auth.scopes.length > 0 ? auth.scopes : auth.tools;
      if (name === "whoami") return true;
      if (allowed.length === 0) return true;
      return allowed.includes(name);
    });
    return rpcResult(id, { tools: connectorToolDescriptors(names) });
  }
  if (method === "tools/call") {
    const name =
      params && typeof params === "object" && "name" in params ? (params as { name?: unknown }).name : undefined;
    const args =
      params && typeof params === "object" && "arguments" in params
        ? (params as { arguments?: unknown }).arguments
        : {};
    if (typeof name !== "string") return rpcError(id, -32602, "unknown tool");
    if (!auth && name !== "whoami") return rpcError(id, -32602, "unknown tool");
    if (name === "whoami" && !auth) {
      const text = JSON.stringify(CONNECTOR_IDENTITY);
      await deps.store.appendEvent({
        ownerId: deps.ownerId ?? "00000000-0000-4000-8000-000000000000",
        actor: "anonymous",
        action: "whoami",
        target: "stub",
        result: { id: CONNECTOR_IDENTITY.id },
        at: new Date().toISOString(),
      });
      return rpcResult(id, {
        content: [{ type: "text", text }],
        structuredContent: CONNECTOR_IDENTITY,
        isError: false,
      });
    }
    const result = await callConnectorTool(deps, auth, name, args);
    if (result.structuredContent.reason === "unknown_tool") return rpcError(id, -32602, "unknown tool");
    return rpcResult(id, result);
  }
  return rpcError(id, -32601, "method not found");
}

export async function handleMcpHttp(request: Request, deps?: ConnectorDeps): Promise<Response> {
  if (!originAllowed(request)) return new Response("invalid origin", { status: 403 });

  if (request.method === "GET" || request.method === "DELETE") {
    return new Response(null, { status: 405 });
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });

  const accept = request.headers.get("accept") ?? "";
  if (!accept.includes("application/json") && !accept.includes("text/event-stream") && !accept.includes("*/*")) {
    return new Response("not acceptable", { status: 406 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return new Response("single json-rpc message required", { status: 400 });
  }

  const message = body as JsonRpcMessage;
  if (message.jsonrpc !== JSONRPC) return new Response("jsonrpc 2.0 required", { status: 400 });

  const versionGate = headerVersion(request, message.method);
  if (versionGate instanceof Response) return versionGate;

  if (isNotification(message)) {
    const method = message.method as string;
    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return new Response(null, { status: 202 });
    }
    return new Response("unknown notification", { status: 400 });
  }

  if (message.result !== undefined || message.error !== undefined) {
    return new Response(null, { status: 202 });
  }

  if (!isRequest(message)) return new Response("invalid json-rpc", { status: 400 });
  const resolved = deps ?? defaultTestSafeDeps();
  return handleMethod(message.method as string, message.params, message.id ?? null, request, resolved);
}
