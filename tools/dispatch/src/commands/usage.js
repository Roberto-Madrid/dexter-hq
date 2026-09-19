import { Kind } from '../errors.js';
import { resolveTarget } from './status.js';

/**
 * Reports per-run token counts from GET /v1/agents/{id}/usage, plus the cost
 * figures that endpoint actually returns.
 *
 * `cost` is NOT in the published v1 schema but is present in live responses as
 * `{ rawCostCents, chargedCents }`. It is read straight through when present
 * and reported `unknown` when absent — never derived from tokens or model ids.
 * Remaining allowance genuinely has no v1 representation.
 */
function readCost(container) {
  const cost = container?.cost;
  if (!cost || typeof cost !== 'object') return null;
  const raw = typeof cost.rawCostCents === 'number' ? cost.rawCostCents : null;
  const charged = typeof cost.chargedCents === 'number' ? cost.chargedCents : null;
  if (raw === null && charged === null) return null;
  return { rawCostCents: raw, chargedCents: charged };
}

export async function usage(ctx, options) {
  const target = resolveTarget(ctx, options);

  let tokens = { available: false, reason: null, totalUsage: null, runs: [] };
  let cost = { status: 'unknown', reason: 'not_returned_by_api', rawCostCents: null, chargedCents: null, currency: null, source: null };
  try {
    const { body } = await ctx.api.getUsage(target.agentId, options.runId ?? undefined);
    tokens = {
      available: true,
      reason: null,
      totalUsage: body?.totalUsage ?? null,
      runs: Array.isArray(body?.runs) ? body.runs : [],
    };

    const top = readCost(body);
    const total = readCost(body?.totalUsage);
    const observed = top ?? total;
    if (observed) {
      cost = {
        status: 'reported',
        reason: 'undocumented_field_present_in_live_response',
        ...observed,
        currency: 'USD_cents',
        source: top ? 'usage.cost' : 'usage.totalUsage.cost',
      };
    }
  } catch (err) {
    if (err.kind === Kind.NOT_FOUND || err.kind === Kind.RATE_LIMIT || err.kind === Kind.TRANSIENT) {
      tokens = { available: false, reason: err.kind, totalUsage: null, runs: [] };
      cost = { ...cost, reason: err.kind };
    } else {
      throw err;
    }
  }

  const perRunCosts = (tokens.runs ?? [])
    .map((r) => ({ runId: r?.id ?? null, ...(readCost(r) ?? readCost(r?.usage) ?? {}) }))
    .filter((r) => r.rawCostCents !== undefined || r.chargedCents !== undefined);

  return {
    command: 'usage',
    ok: true,
    agentId: target.agentId,
    tokens,
    cost,
    perRunCosts,
    allowanceRemaining: { value: null, status: 'unknown', reason: 'not_exposed_by_api' },
    effectiveModel: { value: null, status: 'unknown', reason: 'not_exposed_by_api' },
  };
}
