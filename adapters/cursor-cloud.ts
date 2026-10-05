import { randomUUID } from "node:crypto";
import type { Artifact, CancelResult, RunHandle, RunSpec, RunStatus, Runtime } from "../kernel/types.ts";

type FetchLike = typeof fetch;

const IN_PROGRESS = new Set(["running", "creating", "queued", "starting"]);

function isInProgressStatus(status: unknown): boolean {
  return IN_PROGRESS.has(String(status ?? "RUNNING").trim().toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
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
      const runId = String(asRecord(body.run).id ?? spec.idempotencyKey);
      const remoteAgent = String(asRecord(body.agent).id ?? agentId);
      return { id: `${remoteAgent}:${runId}`, runtime: "cursor-cloud" };
    },
    async status(handle: RunHandle): Promise<RunStatus> {
      const [agentId, runId] = handle.id.split(":");
      const response = await fetchImpl(`${base}/v1/agents/${agentId}/runs/${runId}`, { headers });
      const body = asRecord(await readJson(response));
      const run = asRecord(body.run ?? body);
      return { state: String(run.status ?? "unknown"), usage: {} };
    },
    async cancel(handle: RunHandle): Promise<CancelResult> {
      const [agentId, runId] = handle.id.split(":");
      const response = await fetchImpl(`${base}/v1/agents/${agentId}/runs/${runId}/cancel`, { method: "POST", headers });
      if (response.status === 404) return { state: "unsupported" };
      if (response.status >= 500) return { state: "requested" };
      return { state: "confirmed" };
    },
    async followup(handle: RunHandle, text: string): Promise<RunHandle> {
      const [agentId] = handle.id.split(":");
      const response = await fetchImpl(`${base}/v1/agents/${agentId}/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: { text } }),
      });
      const body = asRecord(await readJson(response));
      const runId = String(asRecord(body.run).id ?? asRecord(body).id ?? "followup");
      return { id: `${agentId}:${runId}`, runtime: "cursor-cloud" };
    },
    async collect(handle: RunHandle): Promise<Artifact[]> {
      const [agentId] = handle.id.split(":");
      const response = await fetchImpl(`${base}/v1/agents/${agentId}/artifacts`, { headers });
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
        .filter((item) => isInProgressStatus(item.status))
        .map((item) => ({ id: `${String(item.id)}:${String(item.runId ?? item.id)}`, runtime: "cursor-cloud" }));
    },
  };
}
