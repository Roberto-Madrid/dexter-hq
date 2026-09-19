import {
  AgentBusyError,
  ApiError,
  AuthError,
  ConflictError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  TransientError,
} from './errors.js';
import { redact } from './redact.js';

const IDEMPOTENT = new Set(['GET', 'HEAD']);

function parseRetryAfter(headerValue, now) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(headerValue);
  return Number.isFinite(when) ? Math.max(0, when - now) : null;
}

function describe(body) {
  if (body && typeof body === 'object') {
    const code = body.code ?? body.error ?? null;
    const message = body.message ?? body.detail ?? null;
    return { code: typeof code === 'string' ? code : null, message: typeof message === 'string' ? message : null };
  }
  return { code: null, message: typeof body === 'string' && body.length < 500 ? body : null };
}

/**
 * Minimal HTTP layer over `fetch`. Injectable so tests run fully offline.
 * The Authorization header is constructed here and nowhere else, and is never
 * placed into anything that gets logged or persisted.
 */
export function createHttpClient({
  baseUrl,
  credential,
  fetchImpl = globalThis.fetch,
  logger,
  timeoutMs = 30000,
  maxRetries = 3,
  baseBackoffMs = 500,
  maxBackoffMs = 15000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const root = String(baseUrl).replace(/\/+$/, '');

  function buildUrl(path, query) {
    const url = new URL(`${root}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url;
  }

  function classify(status, body, headers) {
    const { code, message } = describe(body);
    const text = message ?? `HTTP ${status}`;
    const details = { status, code, body: redact(body) };

    if (status === 401 || status === 403) {
      return new AuthError(
        `Cursor API rejected the credential (HTTP ${status}${code ? `, ${code}` : ''}). ` +
          `Verify the key attached to this environment is valid and has access; the value is never printed.`,
        details,
        status,
      );
    }
    if (status === 429) {
      return new RateLimitError(
        `Cursor API rate limit hit (HTTP 429${code ? `, ${code}` : ''}): ${text}`,
        details,
        parseRetryAfter(headers?.get?.('retry-after'), now()),
      );
    }
    if (status === 404) return new NotFoundError(`Not found (HTTP 404${code ? `, ${code}` : ''}): ${text}`, details);
    if (status === 409) {
      if (code === 'agent_busy') {
        return new AgentBusyError(
          'Agent is busy: a run is already CREATING or RUNNING. Wait for it to terminate or cancel it; do not resend the follow-up.',
          details,
        );
      }
      return new ConflictError(`Conflict (HTTP 409${code ? `, ${code}` : ''}): ${text}`, details, code ?? 'conflict');
    }
    if (status === 410) return new ApiError(`Gone (HTTP 410${code ? `, ${code}` : ''}): ${text}`, { status, code, details });
    if (status >= 500) return new TransientError(`Upstream failure (HTTP ${status}): ${text}`, details, status);
    return new ApiError(`Cursor API error (HTTP ${status}${code ? `, ${code}` : ''}): ${text}`, { status, code, details });
  }

  async function once(method, url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Accept: 'application/json' };
      // Built here only; never logged, never persisted, never forwarded.
      headers.Authorization = `Bearer ${credential.get()}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      const response = await fetchImpl(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const raw = await response.text();
      let parsed = null;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
      }
      return { status: response.status, headers: response.headers, body: parsed };
    } catch (err) {
      if (err?.name === 'AbortError') {
        const timeout = new TimeoutError(
          `Request timed out after ${timeoutMs}ms: ${method} ${url.pathname}. ` +
            (IDEMPOTENT.has(method) ? 'Safe to retry.' : 'Outcome is UNKNOWN — reconcile before any retry.'),
          { method, path: url.pathname, timeoutMs },
        );
        timeout.ambiguous = !IDEMPOTENT.has(method);
        throw timeout;
      }
      if (err?.kind) throw err;
      const transient = new TransientError(`Network failure on ${method} ${url.pathname}: ${err?.message ?? 'unknown'}`, {
        method,
        path: url.pathname,
      });
      transient.ambiguous = !IDEMPOTENT.has(method);
      throw transient;
    } finally {
      clearTimeout(timer);
    }
  }

  async function request({ method = 'GET', path, query, body, retry = IDEMPOTENT.has(method) }) {
    const url = buildUrl(path, query);
    let attempt = 0;

    for (;;) {
      let result;
      try {
        result = await once(method, url, body);
      } catch (err) {
        const retryable = retry && (err.kind === 'transient' || err.kind === 'timeout');
        if (!retryable || attempt >= maxRetries) throw err;
        const delay = backoff(attempt, null);
        logger?.debug?.(`retrying ${method} ${path} after ${err.kind}`, { attempt: attempt + 1, delayMs: delay });
        await sleep(delay);
        attempt += 1;
        continue;
      }

      if (result.status >= 200 && result.status < 300) return result;

      const error = classify(result.status, result.body, result.headers);
      const retryable = retry && (error.kind === 'transient' || error.kind === 'rate_limit');
      if (!retryable || attempt >= maxRetries) throw error;
      const delay = backoff(attempt, error.retryAfterMs);
      logger?.debug?.(`retrying ${method} ${path} after ${error.kind}`, { attempt: attempt + 1, delayMs: delay });
      await sleep(delay);
      attempt += 1;
    }
  }

  function backoff(attempt, retryAfterMs) {
    if (retryAfterMs !== null && retryAfterMs !== undefined) return Math.min(retryAfterMs, maxBackoffMs);
    const exponential = Math.min(baseBackoffMs * 2 ** attempt, maxBackoffMs);
    return Math.round(exponential * (0.5 + random() * 0.5));
  }

  return { request, backoff, baseUrl: root };
}
