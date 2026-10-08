import type { ChatResult } from "../kernel/contracts.ts";
import { validatePlanCard } from "../kernel/plan-card.ts";
import { preflight } from "../kernel/preflight.ts";
import { answerCost, answerList, answerStatus, snapshot } from "./board.ts";
import { classifyQuestion } from "./classify.ts";
import { isQuickEdit, loadCrews, type CrewFile } from "./crews.ts";
import type { HqDeps } from "./deps.ts";
import { newId } from "./memory.ts";
import type { HqStore, RequestRow, TaskRow } from "./model.ts";

function tasksFor(request: RequestRow, text: string, crew: CrewFile | undefined, now: string): TaskRow[] {
  const specs = crew?.tasks ?? [];
  const ids = new Map(specs.map((spec) => [spec.persona, newId()]));
  return specs.map((spec) => ({
    id: ids.get(spec.persona) ?? newId(),
    requestId: request.id,
    persona: spec.persona,
    role: spec.role,
    dependencies: spec.dependsOn.map((name) => ids.get(name)).filter((id): id is string => Boolean(id)),
    state: "queued",
    retriesLeft: 1,
    lastCheckpoint: null,
    requiresDesignApproval: request.card?.requiresDesignApproval ?? false,
    leaseGeneration: 0,
    leasedUntil: null,
    failedChecks: 0,
    quickEdit: spec.role === "builder" && isQuickEdit(text),
    brief: text,
    createdAt: now,
  }));
}

export async function handleChat(
  store: HqStore,
  deps: HqDeps,
  text: string,
  crews = loadCrews(),
  onDelta?: (delta: string) => void,
): Promise<ChatResult> {
  const kind = classifyQuestion(text);
  await store.addMessage("owner", text, null);
  if (kind !== "work") {
    const board = await snapshot(store, deps.slotCap);
    const body = kind === "status" ? answerStatus(board) : kind === "cost" ? answerCost(board) : answerList(board);
    await store.addMessage("dexter", body, null);
    return { kind, text: body, modelCalls: 0, card: null, notices: [], requestId: null, asOf: store.now() };
  }
  const before = deps.ceo.calls;
  if (!deps.ceoEnabled) {
    const notice = "The decision path is unreachable. New plans are held.";
    await store.addMessage("dexter", notice, null);
    return {
      kind: "hold",
      text: notice,
      modelCalls: 0,
      card: null,
      notices: ["ceo_unavailable"],
      requestId: null,
      asOf: store.now(),
    };
  }
  let decision;
  try {
    decision = await deps.ceo.decide(text, onDelta);
  } catch (error) {
    const raw = error instanceof Error ? error.message : "ceo_unavailable";
    const safe = raw.replace(/postgres(?:ql)?:\/\/\S+/gi, "[db]").replace(/eyJ[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 180);
    const code = safe.split(" ")[0]?.replace(/[^a-z0-9_]/gi, "") || "ceo_unavailable";
    console.error(safe);
    const notice = "The decision path is unreachable. New plans are held.";
    await store.addMessage("dexter", notice, null);
    return {
      kind: "hold",
      text: notice,
      modelCalls: deps.ceo.calls - before,
      card: null,
      notices: code === "ceo_unavailable" ? ["ceo_unavailable"] : ["ceo_unavailable", code],
      requestId: null,
      asOf: store.now(),
    };
  }
  if (decision.model !== deps.sheet.ceo.family || decision.effort !== deps.sheet.ceo.reasoningEffort) {
    const notice = "The decision was refused because it was not the fixed decision model.";
    await store.addMessage("dexter", notice, null);
    return {
      kind: "hold",
      text: notice,
      modelCalls: deps.ceo.calls - before,
      card: null,
      notices: ["off_sheet"],
      requestId: null,
      asOf: store.now(),
    };
  }
  const validated = validatePlanCard(decision.card, deps.shippedCrews);
  // A plan stays a card. Runs start only through the connector (caps, event log); the chat never dispatches.
  // The preflight hold the old dispatch applied stays here, so a secret-shaped ask still lands on Needs you.
  const findings = preflight(text, deps.knownHosts);
  const now = store.now();
  const request: RequestRow = {
    id: newId(),
    goal: text,
    crew: validated.card.crew,
    tier: validated.card.tier,
    planVersion: 1,
    definitionOfDone: validated.card.definitionOfDone,
    status: findings.length > 0 ? "needs_you" : "queued",
    notices: [...validated.notices, ...findings.map((finding) => `${finding.kind}:${finding.rule}`)],
    card: validated.card,
    createdAt: now,
    updatedAt: now,
  };
  await store.saveRequest(request);
  const tasks = tasksFor(request, text, crews.get(validated.card.crew), now);
  if (tasks.length > 0) await store.saveTasks(tasks);
  await store.addMessage("dexter", decision.text, request.id);
  return {
    kind: "plan",
    text: decision.text,
    modelCalls: deps.ceo.calls - before,
    card: validated.card,
    notices: validated.notices,
    requestId: request.id,
    asOf: store.now(),
  };
}
