import type { RequestState, TaskState } from "./types.ts";

const TASK_EDGES: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ["leased", "blocked", "failed", "gave_up"],
  leased: ["working", "queued", "blocked", "failed", "gave_up"],
  working: ["in_review", "blocked", "failed", "gave_up"],
  in_review: ["done", "working", "failed", "gave_up"],
  blocked: ["queued", "failed", "gave_up"],
  done: [],
  failed: [],
  gave_up: [],
};

const REQUEST_EDGES: Readonly<Record<RequestState, readonly RequestState[]>> = {
  queued: ["running", "needs_you", "blocked", "paused", "cancelled"],
  running: ["needs_you", "blocked", "paused", "verifying", "failed", "cancelled"],
  needs_you: ["running", "queued", "blocked", "cancelled"],
  blocked: ["queued", "running", "failed", "cancelled"],
  paused: ["queued", "running", "cancelled"],
  verifying: ["ready_for_review", "running", "failed"],
  ready_for_review: ["done", "running", "failed"],
  done: [],
  failed: [],
  cancelled: [],
};

export function taskTransitionAllowed(from: TaskState, to: TaskState): boolean {
  return TASK_EDGES[from].includes(to);
}

export function requestTransitionAllowed(from: RequestState, to: RequestState): boolean {
  return REQUEST_EDGES[from].includes(to);
}
