import { randomUUID } from "node:crypto";
import type { Artifact, CancelResult, RunHandle, RunSpec, RunStatus, Runtime } from "../kernel/types.ts";

type FetchLike = typeof fetch;

const RUN_IN_PROGRESS = new Set(["running", "creating", "queued", "starting"]);
const AGENT_IN_PROGRESS = new Set(["active"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function textId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "followup") return null;
  return trimmed;
}

function parseHandle(id: string): { agentId: string; runId: string | null } {
  const trimmed = id.trim();
  const idx = trimmed.indexOf(":");
  if (idx <= 0) return { agentId: trimmed, runId: null };
  return { agentId: trimmed.slice(0, idx), runId: textId(trimmed.slice(idx + 1)) };
}

function listedRunId(item: Record<string, unknown>): string | null {
  return textId(item.latestRunId) ?? textId(item.runId) ?? textId(asRecord(item.run).id);
}

function isLiveListed(item: Record<string, unknown>): boolean {
  const status = String(item.status ?? "").trim().toLowerCase();
  if (AGENT_IN_PROGRESS.has(status)) return true;
  if (status === "idle" || status === "archived") return false;
  return RUN_IN_PROGRESS.has(status);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runIdFromBody(body: Record<string, unknown>): string | null {
  return textId(asRecord(body.run).id) ?? textId(body.id) ?? textId(asRecord(body.agent).latestRunId);
}

export function createCursorCloud(options: {
  apiKey: string;
  fetchImpl?: FetchLike;
  base?: string;
  ownerId?: string;
}): Runtime & {
  listInProgress(): Promise<{ id: string; runtime: string }[]>;
  followup(handle: RunHandle, text: string): Promise<RunHandle>;
} {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.base ?? "https://api.cursor.com";
  const ownerId = options.ownerId ?? "owner";
  const headers = { Accept: "application/json", Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" };

  function cancelUrl(agentId: string, runId: string): string {
    return `${base}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`;
  }

  async function postCancel(agentId: string, runId: string): Promise<Response> {
    return fetchImpl(cancelUrl(agentId, runId), { method: "POST", headers });
  }

  async function latestRunId(agentId: string): Promise<string | null> {
    const response = await fetchImpl(`${base}/v1/agents/${encodeURIComponent(agentId)}`, { headers });
    if (!response.ok) return null;
    const body = asRecord(await readJson(response));
    const agent = asRecord(body.agent ?? body);
    return textId(agent.latestRunId) ?? runIdFromBody(body);
  }

  async function classifyCancel(response: Response): Promise<CancelResult> {
    if (response.ok) return { state: "confirmed" };
    if (response.status === 404) return { state: "unsupported" };
    if (response.status >= 500) return { state: "requested" };
    return { state: "unconfirmed" };
  }

  return {
    async start(spec: RunSpec): Promise<RunHandle> {
      const agentId = `bc-${randomUUID()}`;
      const response = await fetchImpl(`${base}/v1/agents`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agentId,
          name: spec.idempotencyKey,
          prompt: { text: spec.brief ?? spec.taskId },
        }),
      });
      const body = asRecord(await readJson(response));
      const agent = asRecord(body.agent);
      const runId = runIdFromBody(body) ?? textId(agent.latestRunId) ?? spec.idempotencyKey;
      const remoteAgent = textId(agent.id) ?? agentId;
      return { id: `${remoteAgent}:${runId}`, runtime: "cursor-cloud" };
    },
    async status(handle: RunHandle): Promise<RunStatus> {
      const { agentId, runId } = parseHandle(handle.id);
      if (!runId) return { state: "unknown", usage: {} };
      const response = await fetchImpl(`${base}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, { headers });
      const body = asRecord(await readJson(response));
      const run = asRecord(body.run ?? body);
      return { state: String(run.status ?? "unknown"), usage: {} };
    },
    async cancel(handle: RunHandle): Promise<CancelResult> {
      const { agentId, runId } = parseHandle(handle.id);
      const firstRun = runId ?? (await latestRunId(agentId));
      if (!agentId || !firstRun) return { state: "unconfirmed" };
      const first = await postCancel(agentId, firstRun);
      if (first.ok) return { state: "confirmed" };
      if (first.status === 409 || first.status === 404) {
        const refreshed = await latestRunId(agentId);
        if (refreshed && refreshed !== firstRun) {
          return classifyCancel(await postCancel(agentId, refreshed));
        }
      }
      return classifyCancel(first);
    },
    async followup(handle: RunHandle, text: string): Promise<RunHandle> {
      const { agentId } = parseHandle(handle.id);
      const response = await fetchImpl(`${base}/v1/agents/${encodeURIComponent(agentId)}/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: { text } }),
      });
      const body = asRecord(await readJson(response));
      const runId = runIdFromBody(body);
      if (!response.ok || !runId) throw new Error("followup_parse_failed");
      return { id: `${agentId}:${runId}`, runtime: "cursor-cloud" };
    },
    async collect(handle: RunHandle): Promise<Artifact[]> {
      const { agentId } = parseHandle(handle.id);
      const response = await fetchImpl(`${base}/v1/agents/${encodeURIComponent(agentId)}/artifacts`, { headers });
      const body = asRecord(await readJson(response));
      const list = body.artifacts ?? body.items ?? [];
      if (!Array.isArray(list)) return [];
      return list.map((item) => {
        const row = asRecord(item);
        const path = String(row.path ?? "artifact");
        return {
          id: path,
          ownerId,
          type: "file",
          contentHash: path,
          location: path,
          producer: handle.id,
          versionOrCommit: null,
        };
      });
    },
    async listInProgress(): Promise<{ id: string; runtime: string }[]> {
      const response = await fetchImpl(`${base}/v1/agents`, { headers });
      const body = asRecord(await readJson(response));
      const list = body.agents ?? body.items ?? [];
      if (!Array.isArray(list)) return [];
      return list
        .map((item) => asRecord(item))
        .filter((item) => isLiveListed(item))
        .flatMap((item) => {
          const agentId = textId(item.id);
          const runId = listedRunId(item);
          if (!agentId || !runId) return [];
          return [{ id: `${agentId}:${runId}`, runtime: "cursor-cloud" as const }];
        });
    },
  };
}
