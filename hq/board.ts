import type { UiCard } from "../kernel/contracts.ts";
import type { HqStore, RequestRow, RunRow, TaskRow } from "./model.ts";

const BADGES = new Set(["blocked", "failed", "cancelled", "paused", "verifying", "ready_for_review"]);

function column(status: string): "needsYou" | "active" | "queued" | "done" {
  if (status === "needs_you") return "needsYou";
  if (status === "running" || status === "verifying") return "active";
  if (status === "done" || status === "ready_for_review" || status === "failed" || status === "cancelled") return "done";
  return "queued";
}

function latestRun(runs: RunRow[], taskIds: Set<string>): RunRow | null {
  const matches = runs.filter((run) => taskIds.has(run.taskId));
  return matches.at(-1) ?? null;
}

export function toCard(request: RequestRow, tasks: TaskRow[], runs: RunRow[]): UiCard {
  const mine = tasks.filter((task) => task.requestId === request.id);
  const done = mine.filter((task) => task.state === "done").length;
  const run = latestRun(runs, new Set(mine.map((task) => task.id)));
  const usage: Record<string, number> = {};
  for (const item of runs.filter((row) => mine.some((task) => task.id === row.taskId))) {
    if (!item.pool) continue;
    const native = item.usage.native ?? 0;
    usage[item.pool] = (usage[item.pool] ?? 0) + native;
  }
  const badges = BADGES.has(request.status) ? [request.status] : [];
  return {
    id: request.id,
    title: request.goal.slice(0, 80),
    crew: request.crew,
    tier: request.tier,
    stage: request.status,
    personas: request.card?.personas ?? [],
    updatedAt: request.updatedAt,
    evidenceAt: run?.checkpoint ? request.updatedAt : null,
    tasksDone: done,
    tasksTotal: mine.length,
    usageByPool: usage,
    blocker: request.notices[0] ?? null,
    badges,
    model: run?.model ?? null,
    pool: run?.pool ?? null,
    routingReason: run?.routingReason ?? null,
  };
}

export type BoardSnapshot = {
  asOf: string;
  slotsUsed: number;
  slotCap: number;
  spend: "unknown";
  quotas: "unknown";
  columns: { needsYou: UiCard[]; active: UiCard[]; queued: UiCard[]; done: UiCard[] };
  swarm: { id: string; persona: string; state: string; model: string | null; pool: string | null; routingReason: string | null }[];
  messages: { role: string; body: string; at: string }[];
};

export async function snapshot(store: HqStore, slotCap: number): Promise<BoardSnapshot> {
  const requests = await store.listRequests();
  const tasks = await store.listTasks();
  const runs = await store.listRuns();
  const messages = await store.listMessages();
  const cards = requests.map((request) => toCard(request, tasks, runs));
  const columns = { needsYou: [] as UiCard[], active: [] as UiCard[], queued: [] as UiCard[], done: [] as UiCard[] };
  for (const card of cards) columns[column(card.stage)].push(card);
  const swarm = tasks.map((task) => {
    const run = latestRun(runs, new Set([task.id]));
    return {
      id: task.id,
      persona: task.persona,
      state: task.state,
      model: run?.model ?? null,
      pool: run?.pool ?? null,
      routingReason: run?.routingReason ?? null,
    };
  });
  return {
    asOf: store.now(),
    slotsUsed: await store.activeSlots(),
    slotCap,
    spend: "unknown",
    quotas: "unknown",
    columns,
    swarm,
    messages: messages.map(({ role, body, at }) => ({ role, body, at })),
  };
}

export function answerStatus(board: BoardSnapshot): string {
  return `Active ${board.columns.active.length}. Queued ${board.columns.queued.length}. Needs you ${board.columns.needsYou.length}. Slots ${board.slotsUsed} of ${board.slotCap}. As of ${board.asOf}.`;
}

export function answerCost(board: BoardSnapshot): string {
  const pools = new Map<string, number>();
  for (const card of [...board.columns.active, ...board.columns.queued, ...board.columns.done, ...board.columns.needsYou]) {
    for (const [pool, value] of Object.entries(card.usageByPool)) pools.set(pool, (pools.get(pool) ?? 0) + value);
  }
  const usage = pools.size === 0 ? "unknown" : [...pools.entries()].map(([pool, value]) => `${pool} ${value}`).join(", ");
  return `Usage ${usage}. Spent this month unknown. As of ${board.asOf}.`;
}

export function answerList(board: BoardSnapshot): string {
  const cards = [...board.columns.needsYou, ...board.columns.active, ...board.columns.queued, ...board.columns.done];
  if (cards.length === 0) return `No requests. As of ${board.asOf}.`;
  return cards.map((card) => `${card.stage}: ${card.title}`).join("\n");
}
