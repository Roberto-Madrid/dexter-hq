import type { Artifact, CancelResult, RunHandle, RunSpec, RunStatus, Runtime } from "../kernel/types.ts";

type FetchLike = typeof fetch;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function createGhRunner(options: {
  token: string;
  repo: string;
  fetchImpl?: FetchLike;
  apiBase?: string;
  ownerId?: string;
}): Runtime & { listInProgress(): Promise<{ id: string; runtime: string }[]> } {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? "https://api.github.com";
  const ownerId = options.ownerId ?? "owner";
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  return {
    async start(spec: RunSpec): Promise<RunHandle> {
      const response = await fetchImpl(`${apiBase}/repos/${options.repo}/actions/workflows/agent-run.yml/dispatches`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ref: "main",
          inputs: {
            run_id: spec.idempotencyKey,
            spec_url: spec.brief ?? "repo:workers/specs/codex.json",
            runtime: "codex",
            provider: "codex",
            model: "",
          },
        }),
      });
      if (response.status >= 300) throw new Error(`dispatch_${response.status}`);
      return { id: spec.idempotencyKey, runtime: "gh-runner" };
    },
    async status(handle: RunHandle): Promise<RunStatus> {
      const response = await fetchImpl(
        `${apiBase}/repos/${options.repo}/actions/runs?per_page=20`,
        { headers },
      );
      const body = asRecord(await response.json());
      const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
      const match = runs.map((item) => asRecord(item)).find((item) => String(item.name ?? "").includes(handle.id));
      return { state: String(match?.status ?? "queued"), usage: {} };
    },
    async cancel(handle: RunHandle): Promise<CancelResult> {
      const response = await fetchImpl(`${apiBase}/repos/${options.repo}/actions/runs/${handle.id}/cancel`, {
        method: "POST",
        headers,
      });
      if (response.status === 404) return { state: "unsupported" };
      if (response.status >= 500) return { state: "requested" };
      return { state: "confirmed" };
    },
    async collect(handle: RunHandle): Promise<Artifact[]> {
      return [
        {
          id: handle.id,
          ownerId,
          type: "dossier",
          contentHash: handle.id,
          location: `actions:${handle.id}`,
          producer: "gh-runner",
          versionOrCommit: null,
        },
      ];
    },
    async listInProgress(): Promise<{ id: string; runtime: string }[]> {
      const response = await fetchImpl(`${apiBase}/repos/${options.repo}/actions/runs?status=in_progress&per_page=20`, { headers });
      const body = asRecord(await response.json());
      const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
      return runs.map((item) => {
        const row = asRecord(item);
        return { id: String(row.id ?? ""), runtime: "gh-runner" };
      });
    },
  };
}
