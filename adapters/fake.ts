import type { Artifact, CancelResult, RunHandle, RunSpec, RunStatus, Runtime } from "../kernel/types.ts";

type Stored = {
  handle: RunHandle;
  status: RunStatus;
  artifacts: Artifact[];
};

export function createFakeRuntime(seed?: {
  status?: string;
  artifacts?: Artifact[];
}): Runtime {
  const runs = new Map<string, Stored>();
  return {
    async start(spec: RunSpec): Promise<RunHandle> {
      const existing = runs.get(spec.idempotencyKey);
      if (existing) return existing.handle;
      const handle = { id: spec.idempotencyKey, runtime: "fake" };
      runs.set(spec.idempotencyKey, {
        handle,
        status: { state: seed?.status ?? "running", usage: { native: 1 } },
        artifacts: seed?.artifacts ?? [],
      });
      return handle;
    },
    async status(handle: RunHandle): Promise<RunStatus> {
      const row = runs.get(handle.id);
      if (!row) throw new Error("unknown_run");
      return row.status;
    },
    async cancel(handle: RunHandle): Promise<CancelResult> {
      const row = runs.get(handle.id);
      if (!row) throw new Error("unknown_run");
      row.status = { state: "cancelled", usage: row.status.usage };
      return { state: "confirmed" };
    },
    async collect(handle: RunHandle): Promise<Artifact[]> {
      const row = runs.get(handle.id);
      if (!row) throw new Error("unknown_run");
      return row.artifacts;
    },
  };
}
