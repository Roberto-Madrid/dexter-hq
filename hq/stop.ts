import type { StopReport } from "../kernel/contracts.ts";
import type { CancelState } from "../kernel/types.ts";
import type { HqDeps } from "./deps.ts";
import type { HqStore } from "./model.ts";

function mapState(state: CancelState): StopReport["state"] {
  if (state === "confirmed") return "stopped";
  if (state === "requested") return "stopping";
  return "unconfirmed";
}

export async function stopAll(store: HqStore, deps: HqDeps): Promise<{ reports: StopReport[]; asOf: string }> {
  if (deps.controlReachable) {
    await store.setStopped(true);
    for (const request of await store.listRequests()) {
      if (request.status === "queued" || request.status === "running" || request.status === "needs_you" || request.status === "paused") {
        await store.patchRequest(request.id, { status: "cancelled" });
      }
    }
  }
  const reports: StopReport[] = [];
  for (const [name, runtime] of Object.entries(deps.runtimes)) {
    let runs: { id: string; runtime: string }[] = [];
    try {
      runs = await runtime.listInProgress();
    } catch {
      reports.push({ id: "list-failed", runtime: name, state: "unconfirmed" });
      continue;
    }
    for (const run of runs) {
      try {
        const result = await runtime.cancel({ id: run.id, runtime: run.runtime });
        reports.push({ id: run.id, runtime: run.runtime, state: mapState(result.state) });
      } catch {
        reports.push({ id: run.id, runtime: run.runtime, state: "unconfirmed" });
      }
    }
  }
  return { reports, asOf: store.now() };
}
