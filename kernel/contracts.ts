import { z } from "zod";
import { DossierSchema, PlanCardSchema } from "./schemas.ts";

export const CHANNELS = {
  board: "hq:board",
  runs: "hq:runs",
  chat: "hq:chat",
} as const;

export const ChatRequestSchema = z.object({
  text: z.string().min(1).max(8_000),
});

export const UiCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  crew: z.string(),
  tier: z.string(),
  stage: z.string(),
  personas: z.array(z.string()),
  updatedAt: z.string(),
  evidenceAt: z.string().nullable(),
  tasksDone: z.number().int().nonnegative(),
  tasksTotal: z.number().int().nonnegative(),
  usageByPool: z.record(z.number()),
  blocker: z.string().nullable(),
  badges: z.array(z.string()),
  model: z.string().nullable(),
  pool: z.string().nullable(),
  routingReason: z.string().nullable(),
});

export const ChatResultSchema = z.object({
  kind: z.enum(["status", "cost", "list", "plan", "hold"]),
  text: z.string(),
  modelCalls: z.number().int().nonnegative(),
  card: PlanCardSchema.nullable(),
  notices: z.array(z.string()),
  requestId: z.string().nullable(),
  asOf: z.string(),
});

export const StopReportSchema = z.object({
  id: z.string(),
  runtime: z.string(),
  state: z.enum(["stopping", "stopped", "unconfirmed"]),
  httpStatus: z.number().int().min(100).max(599).optional(),
  errorCode: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
});

export const StopResultSchema = z.object({
  reports: z.array(StopReportSchema),
  asOf: z.string(),
});

export const TickResultSchema = z.object({
  dispatched: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  held: z.number().int().nonnegative(),
  bought: z.literal(false),
  asOf: z.string(),
});

export const CallbackSchema = z
  .object({
    eventId: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    result: z.string().optional(),
    post: z
      .object({
        type: z.enum(["finding", "question", "offer", "answer", "dead_end", "alert", "handoff", "shortcut"]),
        body: z.string(),
        evidence: z.array(z.string()).default([]),
      })
      .optional(),
    checkpoint: z.string().optional(),
    dossier: DossierSchema.optional(),
    artifact: z
      .object({
        type: z.string().min(1),
        location: z.string().min(1),
        contentHash: z.string().min(1),
      })
      .optional(),
    outcome: z
      .object({
        passed: z.boolean(),
        checksFailed: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .refine((value) => Boolean(value.eventId || value.run_id || value.runId), "missing event");

export type ChatResult = z.infer<typeof ChatResultSchema>;
export type UiCard = z.infer<typeof UiCardSchema>;
export type StopReport = z.infer<typeof StopReportSchema>;
export type TickResult = z.infer<typeof TickResultSchema>;
export type CallbackBody = z.infer<typeof CallbackSchema>;
