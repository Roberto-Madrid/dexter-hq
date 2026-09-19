import { Kind } from '../errors.js';

/**
 * Confirms the credential is attached and accepted. Reports presence only —
 * never the value, never a prefix, never a length.
 */
export async function authCheck(ctx) {
  const base = {
    command: 'auth-check',
    credentialStatus: { envVar: ctx.apiKeyEnv, present: ctx.credential.present },
    policy: { source: ctx.policySource, present: ctx.policyPresent },
    apiBase: ctx.http?.baseUrl ?? null,
  };

  if (!ctx.credential.present) {
    return {
      ...base,
      ok: false,
      authenticated: false,
      reason: 'secret_not_available',
      message:
        `Cursor API credential not available in this environment: "${ctx.apiKeyEnv}" is unset or empty. ` +
        `Attach the existing secret to this environment under that exact name, then re-run. ` +
        `No live API call was attempted and no value was read or printed.`,
    };
  }

  try {
    const { body } = await ctx.api.me();
    return {
      ...base,
      ok: true,
      authenticated: true,
      identity: {
        apiKeyName: body?.apiKeyName ?? null,
        keyScope: body?.userId === undefined ? 'service_account' : 'user',
        userId: body?.userId ?? null,
        userEmail: body?.userEmail ?? null,
        createdAt: body?.createdAt ?? null,
      },
    };
  } catch (err) {
    if (err.kind === Kind.AUTH) {
      return { ...base, ok: false, authenticated: false, reason: 'credential_rejected', message: err.message };
    }
    throw err;
  }
}
