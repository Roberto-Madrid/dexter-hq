import type { Artifact, CancelResult, RunHandle, RunSpec, RunStatus, Runtime } from "../kernel/types.ts";

export function createInline(call: (spec: RunSpec) => Promise<Record<string, number>>): Runtime & {
  listInProgress(): Promise<{ id: string; runtime: string }[]>;
} {
  const runs = new Map<string, RunStatus>();
  return {
    async start(spec: RunSpec): Promise<RunHandle> {
      const usage = await call(spec);
      runs.set(spec.idempotencyKey, { state: "done", usage });
      return { id: spec.idempotencyKey, runtime: "inline" };
    },
    async status(handle: RunHandle): Promise<RunStatus> {
      return runs.get(handle.id) ?? { state: "missing", usage: {} };
    },
    async cancel(): Promise<CancelResult> {
      return { state: "confirmed" };
    },
    async collect(): Promise<Artifact[]> {
      return [];
    },
    async listInProgress(): Promise<{ id: string; runtime: string }[]> {
      return [];
    },
  };
}
