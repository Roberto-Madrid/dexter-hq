/**
 * Central redaction. Every string that leaves this process — stdout, stderr,
 * error messages, durable records — passes through `redact`.
 */

const REDACTED = '[REDACTED]';

/** Literal secret values registered at runtime (never persisted anywhere). */
const literals = new Set();

const SENSITIVE_KEY = /^(authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|cookie|set-cookie|token|access[-_]?token|accesstoken|refresh[-_]?token|secret|password|passwd|credential)$/i;

/** Prefixed credential shapes that are always secrets regardless of length. */
const PREFIXED = [
  /\bkey_[A-Za-z0-9_-]{12,}/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9_-]{12,}/g,
  /\bey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
];

/** Bearer/Basic auth header values in free text. */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Credentials embedded in URLs, e.g. https://x-access-token:abc@host. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi;

const OPAQUE = /[A-Za-z0-9_-]{40,}/g;

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) literals.add(value);
}

/** Exposed for tests; clears runtime-registered literals. */
export function resetSecrets() {
  literals.clear();
}

/**
 * Heuristic for unprefixed high-entropy tokens. Deliberately conservative so
 * that git SHAs, agent ids and run ids stay readable.
 */
export function looksLikeSecret(token) {
  if (token.length < 40) return false;
  if (/^[0-9a-f]+$/i.test(token) && token.length <= 64) return false; // git sha / hex digest
  if (/^[0-9]+$/.test(token)) return false;
  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  return (hasLower || hasUpper) && hasDigit && (hasUpper || token.length >= 48);
}

export function redactString(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = input;
  for (const literal of literals) {
    if (literal && out.includes(literal)) out = out.split(literal).join(REDACTED);
  }
  out = out.replace(URL_USERINFO, (_m, scheme) => `${scheme}${REDACTED}@`);
  out = out.replace(AUTH_SCHEME, (_m, scheme) => `${scheme} ${REDACTED}`);
  for (const re of PREFIXED) out = out.replace(re, REDACTED);
  out = out.replace(OPAQUE, (token) => (looksLikeSecret(token) ? REDACTED : token));
  return out;
}

/** Deep-redacts any JSON-ish value, masking sensitive keys outright. */
export function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), code: value.code };
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(val, seen);
  }
  return out;
}

export { REDACTED };
