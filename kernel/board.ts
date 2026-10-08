import type { FindingStatus, PostType } from "./types.ts";

export const POST_TYPES: readonly PostType[] = [
  "finding",
  "question",
  "offer",
  "answer",
  "dead_end",
  "alert",
  "handoff",
  "shortcut",
];

/** Post types that start claimed and can be verified: facts and token-saving tips. */
export const VERIFIABLE_POST_TYPES: readonly PostType[] = ["finding", "shortcut"];

export function verifyFinding(
  post: { type: PostType; status: FindingStatus | null; author: string },
  actor: { author: string; deterministic: boolean },
): { ok: true; status: "verified" } | { ok: false; reason: string } {
  if (!VERIFIABLE_POST_TYPES.includes(post.type)) return { ok: false, reason: "not_a_finding" };
  if (post.status !== "claimed") return { ok: false, reason: "not_claimed" };
  if (!actor.deterministic && actor.author === post.author) {
    return { ok: false, reason: "same_author" };
  }
  return { ok: true, status: "verified" };
}

export function deadEndActive(expiresAt: string | null, nowIso: string): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) > Date.parse(nowIso);
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signAuthor(author: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(author));
  return hex(sig);
}
