/**
 * launch_agent on a `handoff` request: build the maintenance bundle from the venture repo, store it as a tool artifact
 * behind a mission-scoped `handoff` board note, and add a short pointer to the brief. The full bundle never goes in
 * the brief (it is far over the token police word cap); the pointer names the artifact and the in-repo sources.
 * Dexter only launches the receiving agent: nothing here follows up on it.
 */
import { randomUUID } from "node:crypto";
import { buildHandoffBundle, renderHandoffBundle, type HandoffBundle } from "../kernel/handoff-bundle.ts";
import { sheetFamilies } from "../kernel/role-sheet.ts";
import type { RoleSheet } from "../kernel/types.ts";
import type { ConnectorAuth, ConnectorPost, ConnectorRequest, ConnectorStore } from "./connector-store.ts";
import { loadCrews } from "./crews.ts";
import { HANDOFF_CREW, collectHandoffInputFromFiles, type HandoffRepoSource } from "./handoff.ts";
import { artifactIdFor, spillToolOutput } from "./tool-artifacts.ts";
import { SKILL_MAX_WORDS, skillBudget } from "./token-police.ts";

/** A rendered bundle is several 20k-char sections; it is stored whole up to this cap and flagged truncated beyond. */
export const HANDOFF_ARTIFACT_MAX_CHARS = 250_000;
const OPEN_STATES = new Set(["queued", "running", "needs_you", "blocked", "paused", "verifying", "ready_for_review"]);
const LIST_MAX = 12;

export function isHandoffRequest(request: ConnectorRequest | null): boolean {
  return request?.card?.crew === HANDOFF_CREW;
}

export type HandoffLaunchRefusal = { ok: false; body: { status: "refused" | "not-configured"; reason: string } & Record<string, unknown> };
export type HandoffLaunchPlan = {
  brief: string;
  summary: { artifactId: string; postId: string; sha: string; chars: number; truncated: boolean; redactions: number };
  /** Writes the artifact and its board note. Call it only once the launch is going ahead. */
  commit: () => Promise<void>;
};

function briefPointer(bundle: HandoffBundle, artifactId: string, chars: number, redactions: number): string {
  const runbook = [...new Set(bundle.runbook.map((item) => item.source))].join(", ");
  const commands = bundle.tests.commands.slice(0, LIST_MAX).join("; ");
  return [
    `Maintenance handoff bundle for ${bundle.repo} at ${bundle.sha} (artifact ${artifactId}, ${chars} chars).`,
    "Read it with get_context artifactId if you have the connector; otherwise read these sources in your checkout.",
    `Charter: ${bundle.charter.source}. Architecture: ${bundle.architecture.source}. Runbook: ${runbook}. Deployment: ${bundle.deployment.source}.`,
    `Checks before any merge: ${commands}.`,
    `Capabilities: ${bundle.capabilities.join(", ")}.`,
    `Shortcut debt: ${bundle.shortcutDebt.length} (search the code for shortcut markers). Open tasks: ${bundle.openTasks.length}. Known issues: ${bundle.knownIssues.length}. Secret values redacted: ${redactions}.`,
    "You own maintenance from here; Dexter launches you once and does not drive you after this.",
  ].join("\n");
}

/**
 * Builds the handoff plan for one launch, or the refusal. Fails closed: no source, an unreadable repo, a bundle the
 * schema rejects (a secret file among the sources, or a secret that survived redaction), or a brief over the word cap.
 */
export async function planHandoffLaunch(input: {
  store: ConnectorStore;
  sheet: RoleSheet;
  source: HandoffRepoSource | null | undefined;
  auth: ConnectorAuth;
  request: ConnectorRequest;
  repo: string;
  ref: string | null;
  family: string;
  brief: string;
  now: string;
}): Promise<{ ok: true; plan: HandoffLaunchPlan } | HandoffLaunchRefusal> {
  if (!input.source) return { ok: false, body: { status: "not-configured", reason: "handoff_source_unavailable" } };
  let snapshot: Awaited<ReturnType<HandoffRepoSource>>;
  try {
    snapshot = await input.source({ repo: input.repo, ref: input.ref });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 120) : "unknown";
    return { ok: false, body: { status: "refused", reason: "handoff_source_failed", detail } };
  }
  const others = (await input.store.listRequests()).filter(
    (row) => row.ownerId === input.request.ownerId && row.repo === input.repo && row.id !== input.request.id && OPEN_STATES.has(row.status),
  );
  // dexter-shortcut: known issues are the repo's blocked requests only; upgrade path: add live dead ends and failed Checker runs from the board.
  const knownIssues = others.filter((row) => row.status === "blocked").map((row) => `${row.id}: ${row.goal}`.slice(0, 300));
  const openTasks = others.map((row) => ({ id: row.id, title: row.goal.slice(0, 300) || row.id, status: row.status }));
  const collected = collectHandoffInputFromFiles(snapshot.files, {
    repo: input.repo,
    sha: snapshot.sha,
    generatedAt: input.now,
    destination: { kind: "model_family", family: input.family },
    allowedFamilies: [...sheetFamilies(input.sheet)],
    capabilities: loadCrews().get(HANDOFF_CREW)?.capabilities ?? [],
    knownIssues,
    openTasks,
  });
  if ("missing" in collected) return { ok: false, body: { status: "refused", reason: "handoff_sources_missing", missing: collected.missing } };
  const built = buildHandoffBundle(collected);
  if (!built.ok) return { ok: false, body: { status: "refused", reason: "handoff_bundle_invalid", reasons: built.reasons } };
  const bundle = built.bundle;
  const rendered = renderHandoffBundle(bundle);
  const redactions = bundle.redactions.reduce((sum, row) => sum + row.count, 0);
  const postId = randomUUID();
  const artifactId = artifactIdFor(postId);
  const brief = `${input.brief}\n\n${briefPointer(bundle, artifactId, rendered.length, redactions)}`;
  const budget = skillBudget(brief);
  if (budget.over) return { ok: false, body: { status: "refused", reason: "brief_over_word_cap", words: budget.words, maxWords: SKILL_MAX_WORDS } };
  const truncated = rendered.length > HANDOFF_ARTIFACT_MAX_CHARS;
  const plan: HandoffLaunchPlan = {
    brief,
    summary: { artifactId, postId, sha: bundle.sha, chars: rendered.length, truncated, redactions },
    commit: async () => {
      const output = await spillToolOutput(input.store, {
        ownerId: input.auth.ownerId,
        postId,
        author: input.auth.name,
        authorId: input.auth.id,
        text: rendered,
        repo: input.repo,
        scope: "mission",
        requestId: input.request.id,
        at: input.now,
        maxChars: HANDOFF_ARTIFACT_MAX_CHARS,
      });
      const row: ConnectorPost = {
        id: postId,
        ownerId: input.auth.ownerId,
        type: "handoff",
        author: input.auth.name,
        body: `Maintenance handoff bundle for ${input.repo} at ${bundle.sha}: ${bundle.runbook.length} runbook docs, ${bundle.shortcutDebt.length} shortcut debt items, ${redactions} secret values redacted.`,
        repo: input.repo,
        verified: false,
        authorId: input.auth.id,
        status: null,
        verifiedBy: null,
        scope: "mission",
        requestId: input.request.id,
        sha: bundle.sha,
        createdAt: input.now,
        output: output.kind === "inline" ? output.text : output.preview,
        outputChars: output.chars,
        artifactId: output.kind === "artifact" ? output.artifactId : null,
      };
      await input.store.savePost(row);
    },
  };
  return { ok: true, plan };
}
