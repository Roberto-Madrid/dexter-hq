import { MissingCredentialError } from './errors.js';
import { registerSecret } from './redact.js';

/**
 * The credential is read from the environment only. It is never accepted from
 * argv, never echoed, and never written to a record. `hasCredential` exposes
 * presence, never shape or length.
 */
export function readCredential(envVarName, env = process.env) {
  const raw = env?.[envVarName];
  const present = typeof raw === 'string' && raw.trim().length > 0;
  if (present) registerSecret(raw.trim());
  return {
    envVar: envVarName,
    present,
    get: () => {
      if (!present) throw new MissingCredentialError(envVarName);
      return raw.trim();
    },
  };
}

export function requireCredential(envVarName, env = process.env) {
  const credential = readCredential(envVarName, env);
  if (!credential.present) throw new MissingCredentialError(envVarName);
  return credential;
}
