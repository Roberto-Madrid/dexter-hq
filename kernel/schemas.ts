import { z } from "zod";
import {
  REQUEST_STATES,
  TASK_STATES,
  type Approval,
  type Artifact,
  type Capability,
  type Dossier,
  type Event,
  type MemoryItem,
  type Message,
  type ModelRow,
  type Outcome,
  type PlanCard,
  type PoolUsage,
  type Post,
  type Request,
  type RoleSheet,
  type RoutingDecision,
  type Run,
  type Schedule,
  type Task,
  type Verdict,
} from "./types.ts";

const iso = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const caps = z.object({
  nativeUnits: z.number().nonnegative().optional(),
  perTask: z.number().nonnegative().optional(),
  perMission: z.number().nonnegative().optional(),
});

export const RequestSchema = z.object({
  id: uuid,
  ownerId: uuid,
  goal: z.string().min(1),
  crew: z.string().min(1),
  tier: z.enum(["T0", "T1", "T2", "T3"]),
  planVersion: z.number().int().positive(),
  definitionOfDone: z.string().min(1),
  status: z.enum(REQUEST_STATES),
  priority: z.number().int(),
  permissionsProfile: z.string().min(1),
  caps,
  projectId: uuid.nullable(),
  sketchHash: z.string().nullable(),
  createdAt: iso,
}) satisfies z.ZodType<Request>;

export const TaskSchema = z.object({
  id: uuid,
  ownerId: uuid,
  requestId: uuid,
  persona: z.string().min(1),
  role: z.string().min(1),
  dependencies: z.array(uuid),
  expectedArtifact: z.string().nullable(),
  cap: caps,
  state: z.enum(TASK_STATES),
  retriesLeft: z.number().int().nonnegative(),
  lastCheckpoint: z.string().nullable(),
  requiresDesignApproval: z.boolean(),
  priority: z.number().int(),
  leaseGeneration: z.number().int().nonnegative(),
  leasedUntil: iso.nullable(),
  createdAt: iso,
}) satisfies z.ZodType<Task>;

export const RunSchema = z.object({
  id: uuid,
  ownerId: uuid,
  taskId: uuid,
  runtime: z.string().min(1),
  modelRowId: uuid.nullable(),
  leaseGeneration: z.number().int().nonnegative(),
  receipt: z.string().nullable(),
  heartbeat: iso.nullable(),
  status: z.string().min(1),
  usage: z.record(z.number()),
  checkpointToken: z.string().nullable(),
}) satisfies z.ZodType<Run>;

export const PostSchema = z.object({
  id: uuid,
  ownerId: uuid,
  type: z.enum(["finding", "question", "offer", "answer", "dead_end", "alert", "handoff", "shortcut"]),
  author: z.string().min(1),
  signature: z.string().min(1),
  taskId: uuid.nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  verifiedBy: z.string().nullable(),
  expiresAt: iso.nullable(),
  status: z.enum(["claimed", "verified", "stale"]).nullable(),
}) satisfies z.ZodType<Post>;

export const ArtifactSchema = z.object({
  id: uuid,
  ownerId: uuid,
  type: z.string().min(1),
  contentHash: z.string().min(1),
  location: z.string().min(1),
  producer: z.string().min(1),
  versionOrCommit: z.string().nullable(),
}) satisfies z.ZodType<Artifact>;

export const ApprovalSchema = z.object({
  id: uuid,
  ownerId: uuid,
  requestId: uuid.nullable(),
  action: z.string().min(1),
  target: z.string().min(1),
  planVersion: z.number().int().positive(),
  sketchHash: z.string().nullable(),
  approvedAt: iso,
}) satisfies z.ZodType<Approval>;

export const MemoryItemSchema = z.object({
  id: uuid,
  ownerId: uuid,
  scope: z.enum(["owner", "project", "mission"]),
  fact: z.string().min(1),
  provenance: z.string().min(1),
  validity: z.string().nullable(),
  supersedes: uuid.nullable(),
  projectId: uuid.nullable(),
  requestId: uuid.nullable(),
}) satisfies z.ZodType<MemoryItem>;

export const EventSchema = z.object({
  id: uuid,
  ownerId: uuid,
  actor: z.string().min(1),
  action: z.string().min(1),
  target: z.string().min(1),
  result: z.record(z.unknown()).nullable(),
  usage: z.record(z.number()).nullable(),
  approvalId: uuid.nullable(),
  at: iso,
}) satisfies z.ZodType<Event>;

export const CapabilitySchema = z.object({
  id: uuid,
  ownerId: uuid,
  name: z.string().min(1),
  operations: z.array(z.string()),
  permissionClass: z.string().min(1),
  needsApproval: z.boolean(),
  availability: z.string().min(1),
  schemaVersion: z.number().int().positive(),
}) satisfies z.ZodType<Capability>;

export const ScheduleSchema = z.object({
  id: uuid,
  ownerId: uuid,
  requestId: uuid.nullable(),
  cron: z.string().min(1),
  enabled: z.boolean(),
  nextAt: iso.nullable(),
}) satisfies z.ZodType<Schedule>;

export const MessageSchema = z.object({
  id: uuid,
  ownerId: uuid,
  requestId: uuid.nullable(),
  role: z.string().min(1),
  body: z.string(),
  at: iso,
}) satisfies z.ZodType<Message>;

export const ModelRowSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  version: z.string().min(1),
  variant: z.string().min(1),
  pricePerToken: z.number().nonnegative(),
  trainsOnPrompts: z.boolean(),
  pool: z.string().min(1),
  available: z.boolean(),
  releasedAt: iso,
}) satisfies z.ZodType<ModelRow>;

export const OutcomeSchema = z.object({
  runId: z.string().min(1),
  modelRowId: z.string().min(1),
  passed: z.boolean(),
  checksFailed: z.number().int().nonnegative(),
  escalated: z.boolean(),
}) satisfies z.ZodType<Outcome>;

export const PoolUsageSchema = z.object({
  pool: z.string().min(1),
  weekStart: iso,
  runsReserved: z.number().int().nonnegative(),
  weeklyCap: z.number().int().positive(),
}) satisfies z.ZodType<PoolUsage>;

const RoleBindingSchema = z.object({
  family: z.string().min(1),
  pool: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  weeklyRunCap: z.number().int().positive().optional(),
});

export const RoleSheetSchema = z.object({
  version: z.number().int().positive(),
  ceo: z.object({
    family: z.string().min(1),
    reasoningEffort: z.string().min(1),
    pool: z.string().min(1),
    onUnavailable: z.literal("hold_and_notify"),
  }),
  roles: z.record(RoleBindingSchema),
  councilFamilies: z.array(z.string().min(1)).min(1),
  poolOrder: z.array(z.string().min(1)).min(1),
  quickEditRule: z.object({
    maxChangedLines: z.number().int().positive(),
    excludedPaths: z.array(z.string()),
  }),
  escalation: z.object({
    afterFailedChecks: z.number().int().positive(),
    ladders: z.record(z.array(z.string().min(1)).min(1)),
  }),
  versionPolicy: z.object({
    variant: z.literal("standard"),
    priceGuard: z.literal("no_increase"),
  }),
}) satisfies z.ZodType<RoleSheet>;

export const RoutingDecisionSchema = z.object({
  status: z.enum(["resolved", "hold"]),
  held: z.boolean(),
  role: z.string().min(1),
  family: z.string().nullable(),
  version: z.string().nullable(),
  modelRowId: z.string().nullable(),
  pool: z.string().nullable(),
  routingReason: z.string().min(1),
  alert: z.string().nullable(),
  escalation: z
    .object({
      from: z.string().min(1),
      to: z.string().min(1),
      failedChecks: z.number().int().nonnegative(),
    })
    .nullable(),
}) satisfies z.ZodType<RoutingDecision>;

export const PlanCardSchema = z.object({
  crew: z.string().min(1),
  personas: z.array(z.string().min(1)),
  councilMode: z.enum(["off", "quick", "standard", "adversarial"]),
  tier: z.enum(["T0", "T1", "T2", "T3"]),
  definitionOfDone: z.string().min(1),
  outOfScope: z.string(),
  needsOwner: z.array(z.string()),
  newScreen: z.boolean(),
  outwardAction: z.boolean(),
  requiresDesignApproval: z.boolean(),
  requiresApproval: z.boolean(),
}) satisfies z.ZodType<PlanCard>;

export const DossierSchema = z.object({
  status: z.enum(["done", "blocked", "give_up_with_notes"]),
  done: z.array(z.string()),
  verified: z.array(z.string()),
  unverified: z.array(z.string()),
  findings: z.array(
    z.object({
      claim: z.string(),
      evidence: z.string(),
      confidence: z.number(),
    }),
  ),
  deadEnds: z.array(
    z.object({
      approach: z.string(),
      why: z.string(),
      conditions: z.string(),
    }),
  ),
  nextAction: z.string(),
}) satisfies z.ZodType<Dossier>;

export const VerdictSchema = z.object({
  result: z.enum(["pass", "changes", "discuss"]),
  actions: z.array(z.string()),
}) satisfies z.ZodType<Verdict>;
