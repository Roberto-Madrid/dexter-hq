export const REQUEST_STATES = [
  "queued",
  "running",
  "needs_you",
  "blocked",
  "paused",
  "verifying",
  "ready_for_review",
  "done",
  "failed",
  "cancelled",
] as const;

export const TASK_STATES = [
  "queued",
  "leased",
  "working",
  "blocked",
  "in_review",
  "done",
  "failed",
  "gave_up",
] as const;

export type RequestState = (typeof REQUEST_STATES)[number];
export type TaskState = (typeof TASK_STATES)[number];
export type Tier = "T0" | "T1" | "T2" | "T3";
export type CouncilMode = "off" | "quick" | "standard" | "adversarial";
export type PostType =
  | "finding"
  | "question"
  | "offer"
  | "answer"
  | "dead_end"
  | "alert"
  | "handoff"
  | "shortcut"
  | "verdict";
export type FindingStatus = "claimed" | "verified" | "stale";
export type Sensitivity = "none" | "client" | "personal";
export type CancelState = "confirmed" | "requested" | "unsupported" | "unconfirmed";

export type Caps = {
  nativeUnits?: number;
  perTask?: number;
  perMission?: number;
};

export type Request = {
  id: string;
  ownerId: string;
  goal: string;
  crew: string;
  tier: Tier;
  planVersion: number;
  definitionOfDone: string;
  status: RequestState;
  priority: number;
  permissionsProfile: string;
  caps: Caps;
  projectId: string | null;
  sketchHash: string | null;
  createdAt: string;
};

export type Task = {
  id: string;
  ownerId: string;
  requestId: string;
  persona: string;
  role: string;
  dependencies: string[];
  expectedArtifact: string | null;
  cap: Caps;
  state: TaskState;
  retriesLeft: number;
  lastCheckpoint: string | null;
  requiresDesignApproval: boolean;
  priority: number;
  leaseGeneration: number;
  leasedUntil: string | null;
  createdAt: string;
};

export type Run = {
  id: string;
  ownerId: string;
  taskId: string;
  runtime: string;
  modelRowId: string | null;
  leaseGeneration: number;
  receipt: string | null;
  heartbeat: string | null;
  status: string;
  usage: Record<string, number>;
  checkpointToken: string | null;
};

export type Post = {
  id: string;
  ownerId: string;
  type: PostType;
  author: string;
  signature: string;
  taskId: string | null;
  confidence: number;
  evidence: string[];
  verifiedBy: string | null;
  expiresAt: string | null;
  status: FindingStatus | null;
};

export type Artifact = {
  id: string;
  ownerId: string;
  type: string;
  contentHash: string;
  location: string;
  producer: string;
  versionOrCommit: string | null;
};

export type Approval = {
  id: string;
  ownerId: string;
  requestId: string | null;
  action: string;
  target: string;
  planVersion: number;
  sketchHash: string | null;
  approvedAt: string;
};

export type MemoryItem = {
  id: string;
  ownerId: string;
  scope: "owner" | "project" | "mission";
  fact: string;
  provenance: string;
  validity: string | null;
  supersedes: string | null;
  projectId: string | null;
  requestId: string | null;
};

export type Event = {
  id: string;
  ownerId: string;
  actor: string;
  action: string;
  target: string;
  result: Record<string, unknown> | null;
  usage: Record<string, number> | null;
  approvalId: string | null;
  at: string;
};

export type Capability = {
  id: string;
  ownerId: string;
  name: string;
  operations: string[];
  permissionClass: string;
  needsApproval: boolean;
  availability: string;
  schemaVersion: number;
};

export type Schedule = {
  id: string;
  ownerId: string;
  requestId: string | null;
  cron: string;
  enabled: boolean;
  nextAt: string | null;
};

export type Message = {
  id: string;
  ownerId: string;
  requestId: string | null;
  role: string;
  body: string;
  at: string;
};

export type ModelRow = {
  id: string;
  family: string;
  version: string;
  variant: string;
  pricePerToken: number;
  trainsOnPrompts: boolean;
  pool: string;
  available: boolean;
  releasedAt: string;
};

export type Outcome = {
  runId: string;
  modelRowId: string;
  passed: boolean;
  checksFailed: number;
  escalated: boolean;
};

export type PoolUsage = {
  pool: string;
  weekStart: string;
  runsReserved: number;
  weeklyCap: number;
};

export type RoleBinding = {
  family: string;
  pool: string;
  reasoningEffort?: string;
  weeklyRunCap?: number;
};

export type RoleSheet = {
  version: number;
  ceo: {
    family: string;
    reasoningEffort: string;
    pool: string;
    onUnavailable: "hold_and_notify";
  };
  roles: Record<string, RoleBinding>;
  councilFamilies: string[];
  poolOrder: string[];
  quickEditRule: { maxChangedLines: number; excludedPaths: string[] };
  escalation: { afterFailedChecks: number; ladders: Record<string, string[]> };
  versionPolicy: { variant: "standard"; priceGuard: "no_increase" };
};

export type RoutingDecision = {
  status: "resolved" | "hold";
  held: boolean;
  role: string;
  family: string | null;
  version: string | null;
  modelRowId: string | null;
  pool: string | null;
  routingReason: string;
  alert: string | null;
  escalation: { from: string; to: string; failedChecks: number } | null;
};

export type PlanCard = {
  crew: string;
  personas: string[];
  councilMode: CouncilMode;
  tier: Tier;
  definitionOfDone: string;
  outOfScope: string;
  needsOwner: string[];
  newScreen: boolean;
  outwardAction: boolean;
  requiresDesignApproval: boolean;
  requiresApproval: boolean;
};

export type DossierFinding = { claim: string; evidence: string; confidence: number };
export type DossierDeadEnd = { approach: string; why: string; conditions: string };

export type Dossier = {
  status: "done" | "blocked" | "give_up_with_notes";
  done: string[];
  verified: string[];
  unverified: string[];
  findings: DossierFinding[];
  deadEnds: DossierDeadEnd[];
  nextAction: string;
};

export type Verdict = {
  result: "pass" | "changes" | "discuss";
  actions: string[];
};

export type RunSpec = {
  idempotencyKey: string;
  taskId: string;
  checkpoint?: string | null;
  brief?: string;
  /** `owner/name`; null or absent starts a no-repo run. */
  repo?: string | null;
  /** Branch or ref to start from; absent uses the repo's default branch. */
  startingRef?: string | null;
  /** A pinned model id from the runtime's catalog; absent uses the account default. */
  modelId?: string | null;
};

export type RunHandle = {
  id: string;
  runtime: string;
};

export type RunStatus = {
  state: string;
  usage: Record<string, number>;
};

export type CancelResult = {
  state: CancelState;
  httpStatus?: number;
  errorCode?: string;
};

export interface Runtime {
  start(spec: RunSpec): Promise<RunHandle>;
  status(handle: RunHandle): Promise<RunStatus>;
  cancel(handle: RunHandle): Promise<CancelResult>;
  collect(handle: RunHandle): Promise<Artifact[]>;
}
