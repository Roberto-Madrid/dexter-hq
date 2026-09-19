import { Kind } from '../errors.js';
import { resolveTarget } from './status.js';

/**
 * Reports only what the API genuinely exposes: per-run token counts from
 * GET /v1/agents/{id}/usage. Cost, spend and remaining allowance are NOT in
 * any documented v1 response, so they are reported as `unknown` — never
 * derived from token counts or model names.
 */
export async function usage(ctx, options) {
  const target = resolveTarget(ctx, options);

  let tokens = { available: false, reason: null, totalUsage: null, runs: [] };
  try {
    const { body } = await ctx.api.getUsage(target.agentId, options.runId ?? undefined);
    tokens = {
      available: true,
      reason: null,
      totalUsage: body?.totalUsage ?? null,
      runs: Array.isArray(body?.runs) ? body.runs : [],
    };
  } catch (err) {
    if (err.kind === Kind.NOT_FOUND || err.kind === Kind.RATE_LIMIT || err.kind === Kind.TRANSIENT) {
      tokens = { available: false, reason: err.kind, totalUsage: null, runs: [] };
    } else {
      throw err;
    }
  }

  return {
    command: 'usage',
    ok: true,
    agentId: target.agentId,
    tokens,
    cost: { value: null, currency: null, status: 'unknown', reason: 'not_exposed_by_api' },
    allowanceRemaining: { value: null, status: 'unknown', reason: 'not_exposed_by_api' },
    effectiveModel: { value: null, status: 'unknown', reason: 'not_exposed_by_api' },
  };
}
