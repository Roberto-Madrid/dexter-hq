import { randomUUID } from "node:crypto";
import { pinsFromIds, readCatalogMatch } from "../gateway/catalog.ts";
import { holdVersionChanges, type VersionHold } from "../kernel/versions.ts";
import type { ConnectorDeps } from "./connector.ts";
import { PIN_FAILURE_ACTION, type ConnectorStore, type PinResolution } from "./connector-store.ts";
import { reconcileConnector, type ReconcileResult } from "./reconcile.ts";

/** After the catalog could not be read, the tick waits this long before asking Cursor again. */
export const PIN_FAILURE_RETRY_MS = 60 * 60 * 1000;

export type ModelCatalog = { listModels(): Promise<string[]> };

export type PinOwnerResult = {
  ownerId: string;
  status: "recorded" | "skipped" | "backoff" | "failed";
  reason?: string;
  held?: VersionHold[];
  approvals?: string[];
  missing?: string[];
};

export type PinsResult = { configured: boolean; owners: PinOwnerResult[] };

/** The once-per-day key: midnight UTC of `at`. */
export function pinDayStart(at: string): string {
  return `${new Date(at).toISOString().slice(0, 10)}T00:00:00.000Z`;
}

async function recordFailure(store: ConnectorStore, ownerId: string, at: string, since: string, reason: string, lastFailure: string | null) {
  await store.appendEvent({ ownerId, actor: "hq", action: PIN_FAILURE_ACTION, target: "cursor_models", result: { reason }, at });
  // One alert a day: later failures the same day only add events.
  if (lastFailure && lastFailure >= since) return;
  await store.savePost({
    id: randomUUID(),
    ownerId,
    type: "alert",
    author: "hq",
    body: `Daily model check could not read Cursor's model list (${reason}). Launches keep their current pins; HQ retries hourly.`,
    repo: null,
    verified: true,
  });
}

/**
 * The daily version check. Once per UTC day per owner it reads the catalog, picks one id per role-sheet family, and
 * appends one `model_resolutions` row per family: the first pin is the baseline, the same version is `confirmed`, and a
 * new version is a `held` row plus a pending `model_upgrade` approval. A held version never becomes the pin by itself:
 * approving the card starts the upgrade check (hq/upgrade-check.ts), which appends a non-held `upgrade:` row only after
 * the version passes. Those switch rows (and `rollback:` rows) never count as the daily check.
 */
export async function resolveDailyPins(input: {
  store: ConnectorStore;
  cursor: Partial<ModelCatalog> | null;
  sheetText: string;
  now?: () => string;
  ownerIds?: string[];
}): Promise<PinsResult> {
  const { store } = input;
  const listModels = input.cursor?.listModels?.bind(input.cursor);
  if (!listModels) return { configured: false, owners: [] };
  const at = (input.now ?? (() => new Date().toISOString()))();
  const since = pinDayStart(at);
  const ownerIds = input.ownerIds ?? [...new Set((await store.listBots()).map((bot) => bot.ownerId))];
  const owners: PinOwnerResult[] = [];
  const due: { ownerId: string; lastFailure: string | null }[] = [];
  for (const ownerId of ownerIds) {
    if (await store.pinsResolvedSince(ownerId, since)) {
      owners.push({ ownerId, status: "skipped", reason: "resolved_today" });
      continue;
    }
    const lastFailure = await store.lastPinFailureAt(ownerId);
    if (lastFailure && Date.parse(at) - Date.parse(lastFailure) < PIN_FAILURE_RETRY_MS) {
      owners.push({ ownerId, status: "backoff", reason: "retry_after_failure" });
      continue;
    }
    due.push({ ownerId, lastFailure });
  }
  if (due.length === 0) return { configured: true, owners };

  let incoming: { family: string; version: string }[] = [];
  let failure: string | null = null;
  try {
    incoming = pinsFromIds(await listModels(), readCatalogMatch(input.sheetText));
    if (incoming.length === 0) failure = "no_catalog_match";
  } catch {
    failure = "cursor_unreachable";
  }
  for (const { ownerId, lastFailure } of due) {
    if (failure) {
      await recordFailure(store, ownerId, at, since, failure, lastFailure);
      owners.push({ ownerId, status: "failed", reason: failure });
      continue;
    }
    const current = await store.currentPins(ownerId);
    const held = holdVersionChanges(current, incoming);
    const heldFamilies = new Set(held.map((row) => row.family));
    const pinned = new Map(current.map((row) => [row.family, row.version]));
    const rows: PinResolution[] = incoming.map((row) => {
      if (heldFamilies.has(row.family)) return { ...row, held: true, reason: `held: pinned ${pinned.get(row.family)}` };
      return { ...row, held: false, reason: pinned.has(row.family) ? "confirmed" : "baseline" };
    });
    const written = await store.recordPinResolutions({ ownerId, since, at, rows });
    if (!written.recorded) {
      owners.push({ ownerId, status: "skipped", reason: "resolved_today" });
      continue;
    }
    const seen = new Set(incoming.map((row) => row.family));
    const missing = current.filter((row) => !seen.has(row.family)).map((row) => row.family);
    const approvals = written.approvals.map((row) => row.id);
    await store.appendEvent({
      ownerId,
      actor: "hq",
      action: "pins_resolved",
      target: since.slice(0, 10),
      result: { pins: rows, held, approvals, missing },
      at,
    });
    owners.push({ ownerId, status: "recorded", held, approvals, missing });
  }
  return { configured: true, owners };
}

export type TickStepError = { error: string };

/**
 * The per-minute tick: close finished agents, then the weekly fleet report (when given), then the daily version
 * check. Each step fails soft: a throw becomes a short error code and the next step still runs.
 */
export async function connectorTick<F = never>(
  deps: Pick<ConnectorDeps, "store" | "cursor" | "cursorConfigured" | "now">,
  sheetText: string,
  steps: { fleet?: () => Promise<F> } = {},
): Promise<{
  reconcile: ReconcileResult | TickStepError;
  fleet?: F | { status: "error" };
  pins: PinsResult | (TickStepError & { configured: boolean; owners: [] });
}> {
  let reconcile: ReconcileResult | TickStepError;
  try {
    reconcile = await reconcileConnector(deps);
  } catch {
    reconcile = { error: "reconcile_failed" };
  }
  let fleet: F | { status: "error" } | undefined;
  if (steps.fleet) {
    try {
      fleet = await steps.fleet();
    } catch {
      fleet = { status: "error" };
    }
  }
  let pins: PinsResult | (TickStepError & { configured: boolean; owners: [] });
  try {
    const cursor = deps.cursorConfigured ? deps.cursor : null;
    pins = await resolveDailyPins({ store: deps.store, cursor, sheetText, now: deps.now });
  } catch {
    pins = { configured: true, owners: [], error: "pins_check_failed" };
  }
  return { reconcile, ...(steps.fleet ? { fleet } : {}), pins };
}
