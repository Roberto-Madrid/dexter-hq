import { createHmac, timingSafeEqual } from "node:crypto";
import { CallbackSchema, type CallbackBody } from "../kernel/contracts.ts";
import { newId } from "./memory.ts";
import type { HqStore } from "./model.ts";

export function signCallback(secret: string, raw: string): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function eventIdOf(body: CallbackBody): string {
  return body.eventId ?? `${body.run_id ?? body.runId}:${body.result ?? "event"}`;
}

export async function acceptCallback(
  store: HqStore,
  secret: string,
  raw: string,
  signature: string | null,
): Promise<{ ok: boolean; status: number; duplicate: boolean }> {
  if (!signature || !same(signature, signCallback(secret, raw))) return { ok: false, status: 401, duplicate: false };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, duplicate: false };
  }
  const parsed = CallbackSchema.safeParse(json);
  if (!parsed.success) return { ok: false, status: 400, duplicate: false };
  const body = parsed.data;
  const eventId = eventIdOf(body);
  if (await store.seenCallback(eventId)) return { ok: true, status: 200, duplicate: true };
  await store.rememberCallback(eventId);
  const runKey = body.runId ?? body.run_id ?? null;
  if (body.post) {
    await store.addPost({
      id: newId(),
      type: body.post.type,
      body: body.post.body,
      evidence: body.post.evidence,
      taskId: null,
    });
  }
  if (body.checkpoint && runKey) {
    const run = (await store.listRuns()).find((item) => item.id === runKey);
    if (run) {
      await store.patchRun(run.id, { checkpoint: body.checkpoint });
      await store.patchTask(run.taskId, { lastCheckpoint: body.checkpoint });
    }
  }
  if (body.artifact) {
    await store.addArtifact({
      id: newId(),
      type: body.artifact.type,
      location: body.artifact.location,
      contentHash: body.artifact.contentHash,
      producer: "callback",
    });
  }
  if (body.outcome && runKey) {
    await store.addOutcome({ runId: runKey, passed: body.outcome.passed, checksFailed: body.outcome.checksFailed });
  }
  if (body.dossier) {
    await store.addPost({
      id: newId(),
      type: "handoff",
      body: body.dossier.nextAction,
      evidence: body.dossier.verified,
      taskId: null,
    });
  }
  return { ok: true, status: 200, duplicate: false };
}
