import { Kind } from '../errors.js';
import { normalizeRepoUrl } from '../policy.js';

/**
 * The only sanctioned source of model ids and permitted repositories.
 * Repository listing is heavily rate limited (1/user/min, 30/user/hour per
 * the live docs) and can take tens of seconds, so its absence is reported as
 * `available: false` rather than failing the whole command.
 */
export async function discover(ctx, { includeRepositories = true } = {}) {
  const models = await ctx.api.listModels();
  const items = Array.isArray(models.body?.items) ? models.body.items : [];

  const discoveredModels = items.map((m) => ({
    id: m.id,
    displayName: m.displayName ?? null,
    aliases: Array.isArray(m.aliases) ? m.aliases : [],
    parameters: Array.isArray(m.parameters)
      ? m.parameters.map((p) => ({ id: p.id, values: (p.values ?? []).map((v) => v.value) }))
      : [],
    defaultVariantParams: (m.variants ?? []).find((v) => v.isDefault)?.params ?? null,
  }));

  let repositories = { available: false, reason: 'not_requested', items: [] };
  if (includeRepositories) {
    try {
      const repos = await ctx.api.listRepositories();
      const urls = (Array.isArray(repos.body?.items) ? repos.body.items : []).map((r) => r.url).filter(Boolean);
      const allowed = new Set((ctx.policy.repositoryAllowlist ?? []).map(normalizeRepoUrl).filter(Boolean));
      repositories = {
        available: true,
        reason: null,
        items: urls.map((url) => ({ url, inPolicyAllowlist: allowed.has(normalizeRepoUrl(url)) })),
      };
    } catch (err) {
      if (err.kind === Kind.RATE_LIMIT || err.kind === Kind.TRANSIENT || err.kind === Kind.TIMEOUT) {
        repositories = { available: false, reason: err.kind, message: err.message, items: [] };
      } else {
        throw err;
      }
    }
  }

  return {
    command: 'discover',
    ok: true,
    models: { available: true, count: discoveredModels.length, items: discoveredModels },
    repositories,
    policyAllowlist: ctx.policy.repositoryAllowlist ?? [],
  };
}

export function discoveredModelIds(discoverResult) {
  return discoverResult.models.items.map((m) => m.id);
}
