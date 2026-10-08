// Token police part B: the usage-receipt card. Backend only: owner JSON at GET /api/board?view=usage and the
// HQ chat "usage" answer. No screen. Reads the `usage_receipt` events part A writes (one per finished run).
// Missing data stays unknown: a cost total is null when any recorded receipt lacks it.
import type { ConnectorBot, ConnectorEvent } from "./connector-store.ts";

export const USAGE_RECEIPT_ACTION = "usage_receipt";
/** The newest receipts the card reads; `capped` says when there were more. */
export const USAGE_SCAN_LIMIT = 1000;
export const USAGE_STATUS_FILTERS = ["all", "recorded", "unavailable"] as const;
const DEFAULT_LIST = 20;
const MAX_LIST = 200;
const CHAT_LINES = 5;

type Totals = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number | null;
  cost_cents: number | null;
  charged_cents: number | null;
};

type RepoLine = { repo: string | null; runs: number; recorded: number; unavailable: number } & Pick<
  Totals,
  "input_tokens" | "output_tokens" | "cost_cents" | "charged_cents"
>;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Adds a known value; one unknown makes the sum unknown for good. */
function addKnown(sum: number | null | undefined, value: number | null): number | null {
  if (sum === null || value === null) return null;
  return (sum ?? 0) + value;
}

function emptyTotals(): Totals {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, cost_cents: 0, charged_cents: 0 };
}

function receiptRow(event: ConnectorEvent, botNames: Map<string, string>): Record<string, unknown> {
  const r = event.result ?? {};
  const botId = str(r.botId);
  const row: Record<string, unknown> = {
    at: event.at,
    target: event.target,
    status: r.status === "recorded" ? "recorded" : "unavailable",
    reason: str(r.reason),
    agentId: str(r.agentId),
    runId: str(r.runId),
    botId,
    bot: botId ? (botNames.get(botId) ?? null) : null,
    requestId: str(r.requestId),
    repo: str(r.repo),
    role: str(r.role),
    runStatus: str(r.runStatus),
    input_tokens: num(r.input_tokens),
    output_tokens: num(r.output_tokens),
    cache_read_tokens: num(r.cache_read_tokens),
    total_tokens: num(r.total_tokens),
    cost_cents: num(r.cost_cents),
    charged_cents: num(r.charged_cents),
  };
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
}

/** Owner JSON card. Filters: repo, requestId, status (all|recorded|unavailable), limit (list length, <=200). */
export function usageCard(
  receipts: readonly ConnectorEvent[],
  bots: readonly ConnectorBot[],
  query: URLSearchParams,
  nowIso: string,
): { status: 200 | 400; body: Record<string, unknown> } {
  const repo = query.get("repo");
  const requestId = query.get("requestId") ?? query.get("request_id");
  const status = query.get("status") ?? "all";
  if (!(USAGE_STATUS_FILTERS as readonly string[]).includes(status)) {
    return { status: 400, body: { status: "refused", reason: "invalid_filter", filter: "status" } };
  }
  const limitRaw = Number(query.get("limit") ?? DEFAULT_LIST);
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(Math.floor(limitRaw), MAX_LIST) : DEFAULT_LIST;
  const botNames = new Map(bots.map((bot) => [bot.id, bot.name]));
  const matched = receipts
    .filter((event) => event.action === USAGE_RECEIPT_ACTION)
    .filter((event) => !repo || event.result?.repo === repo)
    .filter((event) => !requestId || event.result?.requestId === requestId)
    .filter((event) => status === "all" || (status === "recorded") === (event.result?.status === "recorded"))
    .sort((a, b) => b.at.localeCompare(a.at));
  const totals = emptyTotals();
  const byRepo = new Map<string, RepoLine>();
  let recorded = 0;
  for (const event of matched) {
    const r = event.result ?? {};
    const key = str(r.repo) ?? "";
    const line = byRepo.get(key) ?? { repo: str(r.repo), runs: 0, recorded: 0, unavailable: 0, input_tokens: 0, output_tokens: 0, cost_cents: 0, charged_cents: 0 };
    byRepo.set(key, line);
    line.runs += 1;
    if (r.status !== "recorded") {
      line.unavailable += 1;
      continue;
    }
    recorded += 1;
    line.recorded += 1;
    const input = num(r.input_tokens) ?? 0;
    const output = num(r.output_tokens) ?? 0;
    totals.input_tokens += input;
    totals.output_tokens += output;
    totals.cache_read_tokens += num(r.cache_read_tokens) ?? 0;
    totals.cache_write_tokens += num(r.cache_write_tokens) ?? 0;
    totals.total_tokens = addKnown(totals.total_tokens, num(r.total_tokens));
    totals.cost_cents = addKnown(totals.cost_cents, num(r.cost_cents));
    totals.charged_cents = addKnown(totals.charged_cents, num(r.charged_cents));
    line.input_tokens += input;
    line.output_tokens += output;
    line.cost_cents = addKnown(line.cost_cents, num(r.cost_cents));
    line.charged_cents = addKnown(line.charged_cents, num(r.charged_cents));
  }
  if (recorded === 0) {
    totals.total_tokens = null;
    totals.cost_cents = null;
    totals.charged_cents = null;
  }
  for (const line of byRepo.values()) {
    if (line.recorded === 0) {
      line.cost_cents = null;
      line.charged_cents = null;
    }
  }
  return {
    status: 200,
    body: {
      asOf: nowIso,
      filters: Object.fromEntries(Object.entries({ repo, requestId, status }).filter(([, value]) => value)),
      count: matched.length,
      recorded,
      unavailable: matched.length - recorded,
      totals,
      totalsCover: "recorded receipts only; input tokens include cache reads and writes; null means unknown",
      capped: receipts.length >= USAGE_SCAN_LIMIT,
      byRepo: [...byRepo.values()].sort((a, b) => b.input_tokens - a.input_tokens),
      receipts: matched.slice(0, limit).map((event) => receiptRow(event, botNames)),
    },
  };
}

function cents(value: number | null): string {
  return value === null ? "unknown" : `${value} cents`;
}

/** HQ chat "usage": DB-only, no model. */
export function answerUsage(receipts: readonly ConnectorEvent[] | null, bots: readonly ConnectorBot[], nowIso: string): string {
  if (!receipts) return `Usage receipts unavailable. As of ${nowIso}.`;
  const card = usageCard(receipts, bots, new URLSearchParams(), nowIso).body;
  const count = Number(card.count);
  if (count === 0) return `No usage receipts yet. HQ writes one when a Cursor run finishes. As of ${nowIso}.`;
  const t = card.totals as Totals;
  const head =
    `Usage receipts: ${count} ${count === 1 ? "run" : "runs"} (${card.recorded} recorded, ${card.unavailable} unavailable). ` +
    `${t.input_tokens} input tokens (cache read ${t.cache_read_tokens}), ${t.output_tokens} output tokens. Charged: ${cents(t.charged_cents)}. As of ${nowIso}.`;
  const lines = (card.receipts as Record<string, unknown>[]).slice(0, CHAT_LINES).map((row) => {
    const who = [row.repo ?? "no repo", row.role, row.bot].filter(Boolean).join(" · ");
    const what =
      row.status === "recorded"
        ? `${row.input_tokens ?? "?"} in/${row.output_tokens ?? "?"} out`
        : `unavailable (${row.reason ?? "unknown"})`;
    return `- ${String(row.at).slice(0, 16)}Z ${who}: ${what} ${row.agentId ?? ""}${row.runId ? `:${row.runId}` : ""}`.trimEnd();
  });
  const more = count > CHAT_LINES ? [`(${count - CHAT_LINES} more: GET /api/board?view=usage)`] : [];
  return [head, ...lines, ...more].join("\n");
}
