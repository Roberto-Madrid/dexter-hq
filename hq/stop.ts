import type { StopReport } from "../kernel/contracts.ts";
import type { CancelState } from "../kernel/types.ts";
import type { ConnectorAgent, ConnectorStore } from "./connector-store.ts";
import type { HqDeps } from "./deps.ts";
import type { HqStore, RunRow } from "./model.ts";

const EVENT_OWNER_ID = "00000000-0000-4000-8000-000000000000";

const CURSOR_RUNTIME = "cursor-cloud";
const ACTIVE_HQ_RUN = new Set(["running", "queued", "starting", "leased"]);
const ACTIVE_AGENT = new Set(["launched", "running", "starting", "CREATING", "RUNNING", "queued"]);

function mapState(state: CancelState): StopReport["state"] {
  if (state === "confirmed") return "stopped";
  if (state === "requested") return "stopping";
  return "unconfirmed";
}

function isOpenRequest(status: string): boolean {
  return status === "queued" || status === "running" || status === "needs_you" || status === "paused";
}

async function recordStopEvent(connector: ConnectorStore, at: string, action: "stop_all" | "resume", result: Record<string, unknown>): Promise<void> {
  try {
    await connector.appendEvent({
      ownerId: EVENT_OWNER_ID,
      actor: "owner",
      action,
      target: "connector",
      result,
      at,
    });
  } catch {
    // The kill switch still proceeds if the event log is unavailable.
  }
}

async function haltControl(store: HqStore, connector: ConnectorStore | undefined, at: string): Promise<void> {
  await store.setStopped(true);
  for (const request of await store.listRequests()) {
    if (isOpenRequest(request.status)) {
      await store.patchRequest(request.id, { status: "cancelled" });
    }
  }
  if (!connector) return;
  try {
    await connector.setStopped(true);
  } catch {
    // Caps still apply from the HQ snapshot when the connector table is unreachable.
  }
  try {
    await connector.setTokensSuspended(true);
  } catch {
    // bot_tokens may be absent until migration 0008 is applied by the owner.
  }
  await recordStopEvent(connector, at, "stop_all", { status: "stopped", tokens: "suspended" });
}

function unconfirmed(id: string): StopReport {
  return { id, runtime: CURSOR_RUNTIME, state: "unconfirmed" };
}

function hqCursorLive(run: RunRow): boolean {
  return run.runtime === CURSOR_RUNTIME && ACTIVE_HQ_RUN.has(run.status);
}

function connectorCursorLive(agent: ConnectorAgent): boolean {
  return ACTIVE_AGENT.has(agent.status);
}

async function reportCursorWithoutKey(store: HqStore, connector: ConnectorStore | undefined, reports: StopReport[]): Promise<void> {
  const seen = new Set<string>();
  try {
    for (const run of await store.listRuns()) {
      if (!hqCursorLive(run) || seen.has(run.id)) continue;
      seen.add(run.id);
      reports.push(unconfirmed(run.id));
    }
  } catch {
    reports.push(unconfirmed("list-failed"));
  }
  if (!connector) return;
  try {
    for (const agent of await connector.listAgents()) {
      if (!connectorCursorLive(agent)) continue;
      const id = agent.cursorHandle ?? agent.id;
      if (seen.has(id)) continue;
      seen.add(id);
      reports.push(unconfirmed(id));
    }
  } catch {
    if (seen.size === 0) reports.push(unconfirmed("list-failed"));
  }
}

async function cancelRuntime(
  name: string,
  runtime: HqDeps["runtimes"][string],
  reports: StopReport[],
): Promise<void> {
  let runs: { id: string; runtime: string }[] = [];
  try {
    runs = await runtime.listInProgress();
  } catch {
    reports.push({ id: "list-failed", runtime: name, state: "unconfirmed" });
    return;
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

export async function stopAll(store: HqStore, deps: HqDeps): Promise<{ reports: StopReport[]; asOf: string }> {
  const asOf = store.now();
  if (deps.controlReachable) {
    await haltControl(store, deps.connector, asOf);
  }
  const reports: StopReport[] = [];
  if (!deps.runtimes[CURSOR_RUNTIME]) {
    await reportCursorWithoutKey(store, deps.connector, reports);
  }
  for (const [name, runtime] of Object.entries(deps.runtimes)) {
    await cancelRuntime(name, runtime, reports);
  }
  return { reports, asOf };
}

export async function resumeAll(store: HqStore, deps: HqDeps): Promise<{ resumed: boolean; asOf: string }> {
  const asOf = store.now();
  if (!deps.controlReachable) return { resumed: false, asOf };
  await store.setStopped(false);
  if (deps.connector) {
    try {
      await deps.connector.setStopped(false);
    } catch {
      return { resumed: false, asOf };
    }
    try {
      await deps.connector.setTokensSuspended(false);
    } catch {
      // Tokens stay as they were if the table is absent.
    }
    await recordStopEvent(deps.connector, asOf, "resume", { status: "resumed", tokens: "active" });
  }
  return { resumed: true, asOf };
}
