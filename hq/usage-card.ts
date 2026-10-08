// Token police part B: usage receipt card (stub for the red run).
import type { ConnectorBot, ConnectorEvent } from "./connector-store.ts";

export function usageCard(
  _receipts: readonly ConnectorEvent[],
  _bots: readonly ConnectorBot[],
  _query: URLSearchParams,
  _nowIso: string,
): { status: number; body: Record<string, unknown> } {
  return { status: 501, body: { status: "error", reason: "not_implemented" } };
}
