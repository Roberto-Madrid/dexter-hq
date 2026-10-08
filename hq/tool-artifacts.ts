// Token police part B: tool output over 200 chars goes to an artifact, like agent-brake's `run_bounded`
// (full output kept, a short preview returned). The full text is one append-only `tool_output` event on
// the existing `events` table, so there is no migration; replies carry a pointer and the first 200 chars.
// dexter-shortcut: artifacts live in `events.result`, not Supabase Storage plus an `artifacts` row; upgrade path: move
// the text to Storage and point an `artifacts` row (location, content_hash) at it once outputs outgrow jsonb.
import { createHash } from "node:crypto";
import type { ConnectorEvent, ConnectorStore, PostScope } from "./connector-store.ts";

export const TOOL_OUTPUT_INLINE_CHARS = 200;
/** Stored artifacts are capped so the event log stays readable; the reply says when output was cut. */
export const TOOL_OUTPUT_MAX_CHARS = 20_000;
export const TOOL_OUTPUT_ACTION = "tool_output";
/** One get_context page stays under the 6000-char reply cap, JSON escaping included. */
export const ARTIFACT_PAGE_JSON_CHARS = 4500;

export type ToolArtifact = {
  id: string;
  ownerId: string;
  postId: string;
  author: string;
  authorId: string | null;
  sha256: string;
  chars: number;
  storedChars: number;
  truncated: boolean;
  text: string;
  repo: string | null;
  scope: PostScope | null;
  requestId: string | null;
  at: string;
};

/** What a post stores and replies with. `text` when short; `preview` + `artifactId` when spilled. */
export type OutputRef =
  | { kind: "inline"; text: string; chars: number }
  | { kind: "artifact"; artifactId: string; preview: string; chars: number; truncated: boolean };

export function artifactTarget(id: string): string {
  return `artifact:${id}`;
}

export function artifactIdFor(postId: string): string {
  const hex = createHash("sha256").update(`tool-output:${postId}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Short output stays inline. Long output is written once as a `tool_output` event (actor hq, so it never counts
 * as bot activity), keyed by its post, and the caller keeps only the first 200 chars plus the pointer.
 * `text` must already be secret-scrubbed.
 */
export async function spillToolOutput(
  store: ConnectorStore,
  input: {
    ownerId: string;
    postId: string;
    author: string;
    authorId: string | null;
    text: string;
    repo: string | null;
    scope: PostScope | null;
    requestId: string | null;
    at: string;
    /** Stored-text cap; defaults to TOOL_OUTPUT_MAX_CHARS. Handoff bundles pass a larger one. */
    maxChars?: number;
  },
): Promise<OutputRef> {
  const chars = input.text.length;
  if (chars <= TOOL_OUTPUT_INLINE_CHARS) return { kind: "inline", text: input.text, chars };
  const id = artifactIdFor(input.postId);
  const stored = input.text.slice(0, input.maxChars ?? TOOL_OUTPUT_MAX_CHARS);
  const truncated = stored.length < chars;
  const existing = await readToolArtifact(store, id);
  if (!existing) {
    await store.appendEvent({
      ownerId: input.ownerId,
      actor: "hq",
      action: TOOL_OUTPUT_ACTION,
      target: artifactTarget(id),
      result: {
        artifactId: id,
        postId: input.postId,
        author: input.author,
        authorId: input.authorId,
        sha256: createHash("sha256").update(stored, "utf8").digest("hex"),
        chars,
        storedChars: stored.length,
        truncated,
        repo: input.repo,
        scope: input.scope,
        requestId: input.requestId,
        text: stored,
      },
      at: input.at,
    });
  }
  return { kind: "artifact", artifactId: id, preview: input.text.slice(0, TOOL_OUTPUT_INLINE_CHARS), chars, truncated };
}

function artifactFromEvent(event: ConnectorEvent | undefined): ToolArtifact | null {
  const r = event?.result;
  if (!event || !r || typeof r.artifactId !== "string" || typeof r.text !== "string" || typeof r.postId !== "string") return null;
  const scope = r.scope === "shared" || r.scope === "project" || r.scope === "mission" ? r.scope : null;
  return {
    id: r.artifactId,
    ownerId: event.ownerId,
    postId: r.postId,
    author: typeof r.author === "string" ? r.author : "unknown",
    authorId: typeof r.authorId === "string" ? r.authorId : null,
    sha256: typeof r.sha256 === "string" ? r.sha256 : "",
    chars: typeof r.chars === "number" ? r.chars : r.text.length,
    storedChars: typeof r.storedChars === "number" ? r.storedChars : r.text.length,
    truncated: r.truncated === true,
    text: r.text,
    repo: typeof r.repo === "string" ? r.repo : null,
    scope,
    requestId: typeof r.requestId === "string" ? r.requestId : null,
    at: event.at,
  };
}

export async function readToolArtifact(store: ConnectorStore, id: string): Promise<ToolArtifact | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const found = await store.listRecentEvents(TOOL_OUTPUT_ACTION, { target: artifactTarget(id), limit: 1 });
  return artifactFromEvent(found[0]);
}

/** One page of an artifact whose JSON stays under ARTIFACT_PAGE_JSON_CHARS. */
export function artifactPage(artifact: ToolArtifact, offsetRaw: unknown): Record<string, unknown> {
  const parsed = Number(offsetRaw ?? 0);
  const offset = Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), artifact.text.length) : 0;
  let end = Math.min(artifact.text.length, offset + ARTIFACT_PAGE_JSON_CHARS);
  while (end > offset && JSON.stringify(artifact.text.slice(offset, end)).length > ARTIFACT_PAGE_JSON_CHARS) {
    end = offset + Math.floor((end - offset) * 0.8);
  }
  return {
    id: artifact.id,
    postId: artifact.postId,
    by: artifact.author,
    chars: artifact.chars,
    storedChars: artifact.storedChars,
    truncated: artifact.truncated,
    offset,
    text: artifact.text.slice(offset, end),
    nextOffset: end < artifact.text.length ? end : null,
  };
}
