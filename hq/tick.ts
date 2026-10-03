import type { TickResult } from "../kernel/contracts.ts";
import { idempotencyKey } from "../kernel/idempotency.ts";
import { preflight } from "../kernel/preflight.ts";
import { capForPool, resolveRouting } from "../kernel/role-sheet.ts";
import { reservePoolRun, reserveSlot } from "../kernel/police.ts";
import { runtimeNameForPool, type HqDeps } from "./deps.ts";
import type { HqStore, RunRow, TaskRow } from "./model.ts";

export async function tick(store: HqStore, deps: HqDeps): Promise<TickResult> {
  const asOf = store.now();
  if (!deps.controlReachable || (await store.stopped())) {
    return { dispatched: 0, queued: 0, held: 0, bought: false, asOf };
  }
  let dispatched = 0;
  let queued = 0;
  let held = 0;
  const tasks = await store.listTasks();
  const requests = await store.listRequests();
  const ready: TaskRow[] = [];
  for (const task of tasks) {
    if (task.state !== "queued") continue;
    const request = requests.find((item) => item.id === task.requestId);
    if (!request || request.status === "cancelled" || request.status === "needs_you") continue;
    const depsDone = task.dependencies.every((id) => tasks.find((item) => item.id === id)?.state === "done");
    if (!depsDone) continue;
    if (task.requiresDesignApproval && !(await store.approved(task.requestId))) continue;
    const findings = preflight(task.brief, deps.knownHosts);
    if (findings.length > 0) {
      await store.patchTask(task.id, { state: "blocked" });
      await store.patchRequest(request.id, {
        status: "needs_you",
        notices: [...request.notices, ...findings.map((finding) => `${finding.kind}:${finding.rule}`)],
      });
      held += 1;
      continue;
    }
    ready.push(task);
  }
  for (const task of ready) {
    const request = requests.find((item) => item.id === task.requestId);
    if (!request) continue;
    const decision = resolveRouting({
      sheet: deps.sheet,
      catalog: deps.catalog,
      role: task.role,
      quickEdit: task.quickEdit,
      failedChecks: task.failedChecks,
      exhaustedPools: deps.exhaustedPools,
    });
    if (decision.held || !decision.pool || !decision.family || !decision.version) {
      await store.patchTask(task.id, { state: "blocked" });
      await store.patchRequest(request.id, {
        status: "needs_you",
        notices: [...request.notices, decision.alert ?? "held"],
      });
      held += 1;
      continue;
    }
    const cap = capForPool(deps.sheet, decision.pool);
    let reservedNext: number | null = null;
    if (cap !== null) {
      const reserved = await store.poolReserved(decision.pool);
      const next = reservePoolRun(reserved, cap);
      if (!next.ok) {
        queued += 1;
        continue;
      }
      reservedNext = next.reserved;
    }
    const runtimeName = runtimeNameForPool(decision.pool);
    const runtime = runtimeName ? deps.runtimes[runtimeName] : undefined;
    if (!runtimeName || !runtime) {
      queued += 1;
      continue;
    }
    const slot = reserveSlot(await store.activeSlots(), deps.slotCap);
    if (!slot.ok) {
      queued += 1;
      continue;
    }
    if (reservedNext !== null) await store.setPoolReserved(decision.pool, reservedNext);
    await store.setActiveSlots(slot.active);
    const generation = task.leaseGeneration + 1;
    await store.patchTask(task.id, { state: "leased", leaseGeneration: generation, leasedUntil: store.now() });
    const key = await idempotencyKey([task.id, String(generation)]);
    try {
      const handle = await runtime.start({
        idempotencyKey: key,
        taskId: task.id,
        checkpoint: task.lastCheckpoint,
        brief: task.brief,
      });
      await store.patchTask(task.id, { state: "working" });
      const run: RunRow = {
        id: handle.id,
        taskId: task.id,
        runtime: runtimeName,
        model: decision.family,
        version: decision.version,
        pool: decision.pool,
        routingReason: decision.routingReason,
        leaseGeneration: generation,
        status: "running",
        usage: {},
        checkpoint: task.lastCheckpoint,
        idempotencyKey: key,
        escalation: decision.escalation,
      };
      await store.saveRun(run);
      if (request.status === "queued" || request.status === "blocked" || request.status === "paused") {
        await store.patchRequest(request.id, { status: "running" });
      }
      dispatched += 1;
    } catch {
      await store.setActiveSlots(Math.max(0, (await store.activeSlots()) - 1));
      if (reservedNext !== null) await store.setPoolReserved(decision.pool, Math.max(0, reservedNext - 1));
      await store.patchTask(task.id, { state: "queued", leasedUntil: null });
      queued += 1;
    }
  }
  return { dispatched, queued, held, bought: false, asOf: store.now() };
}

export async function expireLease(store: HqStore, taskId: string): Promise<void> {
  const task = (await store.listTasks()).find((item) => item.id === taskId);
  if (!task) return;
  if (task.state === "working") await store.patchTask(taskId, { state: "blocked" });
  const current = (await store.listTasks()).find((item) => item.id === taskId);
  if (current && (current.state === "blocked" || current.state === "leased")) {
    await store.patchTask(taskId, { state: "queued", leasedUntil: null });
  }
  const runs = (await store.listRuns()).filter((run) => run.taskId === taskId);
  const run = runs.at(-1);
  if (run) await store.patchRun(run.id, { status: "cancelled" });
  await store.setActiveSlots(Math.max(0, (await store.activeSlots()) - 1));
}
