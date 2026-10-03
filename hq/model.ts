import type { PlanCard, RequestState, TaskState, Tier } from "../kernel/types.ts";

export type TaskRow = {
  id: string;
  requestId: string;
  persona: string;
  role: string;
  dependencies: string[];
  state: TaskState;
  retriesLeft: number;
  lastCheckpoint: string | null;
  requiresDesignApproval: boolean;
  leaseGeneration: number;
  leasedUntil: string | null;
  failedChecks: number;
  quickEdit: boolean;
  brief: string;
  createdAt: string;
};

export type RunRow = {
  id: string;
  taskId: string;
  runtime: string;
  model: string | null;
  version: string | null;
  pool: string | null;
  routingReason: string;
  leaseGeneration: number;
  status: string;
  usage: Record<string, number>;
  checkpoint: string | null;
  idempotencyKey: string;
  escalation: { from: string; to: string; failedChecks: number } | null;
};

export type RequestRow = {
  id: string;
  goal: string;
  crew: string;
  tier: Tier;
  planVersion: number;
  definitionOfDone: string;
  status: RequestState;
  notices: string[];
  card: PlanCard | null;
  createdAt: string;
  updatedAt: string;
};

export type MessageRow = { role: string; body: string; at: string; requestId: string | null };
export type PostRow = { id: string; type: string; body: string; evidence: string[]; taskId: string | null };
export type ArtifactRow = { id: string; type: string; location: string; contentHash: string; producer: string };
export type OutcomeRow = { runId: string; passed: boolean; checksFailed: number };

export interface HqStore {
  now(): string;
  listRequests(): Promise<RequestRow[]>;
  listTasks(): Promise<TaskRow[]>;
  listRuns(): Promise<RunRow[]>;
  listMessages(): Promise<MessageRow[]>;
  listPosts(): Promise<PostRow[]>;
  listArtifacts(): Promise<ArtifactRow[]>;
  listOutcomes(): Promise<OutcomeRow[]>;
  addMessage(role: string, body: string, requestId: string | null): Promise<void>;
  saveRequest(row: RequestRow): Promise<void>;
  saveTasks(rows: TaskRow[]): Promise<void>;
  patchRequest(id: string, patch: Partial<Pick<RequestRow, "status" | "notices" | "updatedAt">>): Promise<void>;
  patchTask(id: string, patch: Partial<TaskRow>): Promise<void>;
  saveRun(row: RunRow): Promise<void>;
  patchRun(id: string, patch: Partial<RunRow>): Promise<void>;
  activeSlots(): Promise<number>;
  setActiveSlots(value: number): Promise<void>;
  poolReserved(pool: string): Promise<number>;
  setPoolReserved(pool: string, value: number): Promise<void>;
  stopped(): Promise<boolean>;
  setStopped(value: boolean): Promise<void>;
  seenCallback(id: string): Promise<boolean>;
  rememberCallback(id: string): Promise<void>;
  addPost(row: PostRow): Promise<void>;
  addArtifact(row: ArtifactRow): Promise<void>;
  addOutcome(row: OutcomeRow): Promise<void>;
  approved(requestId: string): Promise<boolean>;
}
