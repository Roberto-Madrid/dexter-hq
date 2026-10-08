// Token police, part A: one usage receipt per finished Cursor run, read with HQ's own Cursor key
// (CURSOR_API_KEY, the same one the cursor-cloud adapter uses). Never blocks the close that triggers it.
import type { ConnectorAgent, ConnectorStore } from "./connector-store.ts";

export const USAGE_TIMEOUT_MS = 10_000;

/** Raw JSON from `GET /v1/agents/{id}/usage`. Throws on a non-2xx answer or a timeout. */
export type CursorUsageFn = (input: { agentId: string; runId: string | null }) => Promise<unknown>;

export type ParsedUsage = {
  scope: "run" | "agent";
  /** Cursor's inputTokens plus cache reads and cache writes: everything billed as input. */
  input_tokens: number;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  total_tokens: number | null;
  cost_cents: number | null;
  charged_cents: number | null;
};

export function createCursorUsage(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  base?: string;
  timeoutMs?: number;
}): CursorUsageFn {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.base ?? "https://api.cursor.com";
  return async ({ agentId, runId }) => {
    const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
    const response = await fetchImpl(`${base}/v1/agents/${encodeURIComponent(agentId)}/usage${query}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? USAGE_TIMEOUT_MS),
    });
    if (response.status >= 300) throw new Error(`usage_http_${response.status}`);
    return response.json();
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function field(source: Record<string, unknown> | null, camel: string, snake: string): number | null {
  if (!source) return null;
  return num(source[camel]) ?? num(source[snake]);
}

/**
 * Reads Cursor's documented usage shape ({totalUsage, runs[{id, usage}]}) and tolerates snake_case.
 * dexter-shortcut: cost fields (cost.rawCostCents / chargedCents) are not in Cursor's public docs and are read only if present; upgrade path: pin the shape once Cursor documents billing on this endpoint.
 */
export function parseCursorUsage(body: unknown, runId: string | null): ParsedUsage | null {
  const root = record(body);
  if (!root) return null;
  const runs = Array.isArray(root.runs) ? root.runs.map(record) : [];
  const run = runId ? runs.find((item) => item && item.id === runId) : undefined;
  const usage = record(run?.usage) ?? record(root.totalUsage) ?? record(root.total_usage);
  const input = field(usage, "inputTokens", "input_tokens");
  const output = field(usage, "outputTokens", "output_tokens");
  if (input === null || output === null) return null;
  const cacheRead = field(usage, "cacheReadTokens", "cache_read_tokens") ?? 0;
  const cacheWrite = field(usage, "cacheWriteTokens", "cache_write_tokens") ?? 0;
  const cost = record(run?.cost) ?? record(usage?.cost) ?? record(root.cost);
  return {
    scope: runId ? "run" : "agent",
    input_tokens: input + cacheRead + cacheWrite,
    uncached_input_tokens: input,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    output_tokens: output,
    total_tokens: field(usage, "totalTokens", "total_tokens"),
    cost_cents: field(cost, "rawCostCents", "raw_cost_cents"),
    charged_cents: field(cost, "chargedCents", "charged_cents"),
  };
}

function splitHandle(handle: string): { agentId: string; runId: string | null } {
  const idx = handle.indexOf(":");
  if (idx <= 0) return { agentId: handle, runId: null };
  return { agentId: handle.slice(0, idx), runId: handle.slice(idx + 1) || null };
}

function safeReason(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "usage_timeout";
  const message = error instanceof Error ? error.message : "usage_failed";
  return /^usage_[a-z_0-9]+$/.test(message) ? message : "usage_failed";
}

/**
 * Called once, right after `closeIfTerminal` moved the run to a terminal status. That move is conditional
 * (`setAgentStatus` from an active status, on this run), so a run gets one receipt however many ticks or
 * agent_status calls see it. Fail soft: any error becomes an `unavailable` receipt, and nothing throws.
 */
export async function recordUsageReceipt(
  deps: { store: ConnectorStore; usage?: CursorUsageFn | null; now?: () => string },
  agent: ConnectorAgent,
  handle: string,
  runStatus: string | null,
): Promise<"recorded" | "unavailable" | "skipped"> {
  if (!deps.usage) return "skipped";
  const { agentId, runId } = splitHandle(handle);
  const requestId = typeof agent.result?.requestId === "string" ? agent.result.requestId : null;
  const tags = { agentId, runId, botId: agent.botId, requestId, repo: agent.repo, role: agent.role, runStatus };
  let result: Record<string, unknown>;
  try {
    const parsed = parseCursorUsage(await deps.usage({ agentId, runId }), runId);
    result = parsed ? { status: "recorded", ...tags, ...parsed } : { status: "unavailable", reason: "usage_unparsed", ...tags };
  } catch (error) {
    result = { status: "unavailable", reason: safeReason(error), ...tags };
  }
  try {
    await deps.store.appendEvent({
      ownerId: agent.ownerId,
      actor: "hq",
      action: "usage_receipt",
      target: handle,
      result,
      at: (deps.now ?? (() => new Date().toISOString()))(),
    });
  } catch {
    return "unavailable";
  }
  return result.status === "recorded" ? "recorded" : "unavailable";
}
