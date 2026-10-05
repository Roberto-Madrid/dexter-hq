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
  return (
    status === "queued" ||
    status === "running" ||
    status === "needs_you" ||
    status === "paused" ||
    status === "blocked"
  );
}

async function cancelHqRequests(store: HqStore): Promise<void> {
  try {
    for (const request of await store.listRequests()) {
      if (!isOpenRequest(request.status)) continue;
      try {
        await store.patchRequest(request.id, { status: "cancelled" });
      } catch {
        // Keep the kill switch moving if one HQ row cannot transition.
      }
    }
  } catch {
    // Listing HQ requests is not required to set the stop flags.
  }
}

async function cancelConnectorRequests(connector: ConnectorStore): Promise<void> {
  try {
    for (const request of await connector.listRequests()) {
      if (!isOpenRequest(request.status)) continue;
      try {
        await connector.saveRequest({ ...request, status: "cancelled" });
      } catch {
        // Connector rows can disagree with HQ snapshot rows; flags still go on.
      }
    }
  } catch {
    // The tower reads connector requests; missing that table must not block STOP ALL.
  }
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

async function haltControl(store: HqStore, connector: ConnectorStore | undefined): Promise<void> {
  await store.setStopped(true);
  await cancelHqRequests(store);
  if (!connector) return;
  await cancelConnectorRequests(connector);
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

function cancelKeys(id: string): string[] {
  const idx = id.indexOf(":");
  if (idx <= 0) return [id];
  return [id, id.slice(0, idx)];
}

function alreadyTracked(set: Set<string>, id: string): boolean {
  return cancelKeys(id).some((key) => set.has(key));
}

function remember(set: Set<string>, id: string): void {
  for (const key of cancelKeys(id)) set.add(key);
}

async function cancelRuntime(
  name: string,
  runtime: HqDeps["runtimes"][string],
  reports: StopReport[],
  seen: Set<string>,
  confirmed: Set<string>,
): Promise<void> {
  let runs: { id: string; runtime: string }[] = [];
  try {
    runs = await runtime.listInProgress();
  } catch {
    reports.push({ id: "list-failed", runtime: name, state: "unconfirmed" });
    return;
  }
  for (const run of runs) {
    if (alreadyTracked(seen, run.id)) continue;
    try {
      const result = await runtime.cancel({ id: run.id, runtime: run.runtime });
      remember(seen, run.id);
      if (result.state === "confirmed") remember(confirmed, run.id);
      reports.push({ id: run.id, runtime: run.runtime, state: mapState(result.state) });
    } catch {
      reports.push({ id: run.id, runtime: run.runtime, state: "unconfirmed" });
    }
  }
}

async function cancelConnectorAgents(
  deps: HqDeps,
  reports: StopReport[],
  seen: Set<string>,
  confirmed: Set<string>,
): Promise<void> {
  const connector = deps.connector;
  const runtime = deps.runtimes[CURSOR_RUNTIME];
  if (!connector || !runtime) return;
  let agents: ConnectorAgent[] = [];
  try {
    agents = await connector.listAgents();
  } catch {
    return;
  }
  for (const agent of agents) {
    if (!connectorCursorLive(agent) || !agent.cursorHandle) continue;
    const id = agent.cursorHandle;
    if (!alreadyTracked(seen, id)) {
      try {
        const result = await runtime.cancel({ id, runtime: CURSOR_RUNTIME });
        remember(seen, id);
        if (result.state === "confirmed") remember(confirmed, id);
        reports.push({ id, runtime: CURSOR_RUNTIME, state: mapState(result.state) });
      } catch {
        reports.push({ id, runtime: CURSOR_RUNTIME, state: "unconfirmed" });
        continue;
      }
    }
    if (!alreadyTracked(confirmed, id)) continue;
    try {
      await connector.saveAgent({ ...agent, status: "cancelled" });
    } catch {
      // Caps stay occupied if this write fails; the next STOP ALL can retry.
    }
  }
}

export async function stopAll(store: HqStore, deps: HqDeps): Promise<{ reports: StopReport[]; asOf: string }> {
  const asOf = store.now();
  if (deps.controlReachable) {
    await haltControl(store, deps.connector);
  }
  const reports: StopReport[] = [];
  if (!deps.runtimes[CURSOR_RUNTIME]) {
    await reportCursorWithoutKey(store, deps.connector, reports);
  }
  const seen = new Set<string>();
  const confirmed = new Set<string>();
  for (const [name, runtime] of Object.entries(deps.runtimes)) {
    await cancelRuntime(name, runtime, reports, seen, confirmed);
  }
  await cancelConnectorAgents(deps, reports, seen, confirmed);
  if (deps.controlReachable && deps.connector) {
    await recordStopEvent(deps.connector, asOf, "stop_all", {
      status: "stopped",
      tokens: "suspended",
      reports,
      asOf,
    });
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
