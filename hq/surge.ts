import type { ConnectorApproval } from "./connector-store.ts";

/**
 * How long an approved `surge` raises the global agent cap. After this the cap reads as the normal one again;
 * no write is needed to revert.
 */
// dexter-shortcut: docs/MASTER_PLAN_V6.md gives no surge duration, so this is a fixed 24h constant; upgrade path: an owner setting next to the weekly Council cap.
export const SURGE_TTL_MS = 24 * 60 * 60 * 1000;

/** When an approved surge stops counting, or null when the approval is not an approved surge with a decision time. */
export function surgeExpiresAt(approval: Pick<ConnectorApproval, "action" | "status" | "decidedAt">): string | null {
  if (approval.action !== "surge" || approval.status !== "approved" || !approval.decidedAt) return null;
  const decided = Date.parse(approval.decidedAt);
  if (!Number.isFinite(decided)) return null;
  return new Date(decided + SURGE_TTL_MS).toISOString();
}

/** True only for an approved surge whose expiry is still ahead of `now`. */
export function surgeActive(approval: Pick<ConnectorApproval, "action" | "status" | "decidedAt">, now: string): boolean {
  const expiresAt = surgeExpiresAt(approval);
  return Boolean(expiresAt && Date.parse(now) < Date.parse(expiresAt));
}
