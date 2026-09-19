import { redact, redactString } from './redact.js';

/**
 * Failure kinds are stable strings; callers and tests branch on `kind`, never
 * on message text.
 */
export const Kind = Object.freeze({
  VALIDATION: 'validation',
  MISSING_CREDENTIAL: 'missing_credential',
  AUTH: 'auth',
  BUSY: 'busy',
  RATE_LIMIT: 'rate_limit',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  TRANSIENT: 'transient',
  TIMEOUT: 'timeout',
  AMBIGUOUS: 'ambiguous',
  API: 'api',
  POLICY: 'policy',
});

export class DispatchError extends Error {
  constructor(message, { kind = Kind.API, code = null, status = null, details = null, retryAfterMs = null } = {}) {
    super(redactString(message));
    this.name = new.target.name;
    this.kind = kind;
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.details = details === null ? null : redact(details);
  }

  toJSON() {
    return {
      error: this.name,
      kind: this.kind,
      code: this.code,
      status: this.status,
      message: this.message,
      retryAfterMs: this.retryAfterMs,
      details: this.details,
    };
  }
}

export class ValidationError extends DispatchError {
  constructor(message, details) {
    super(message, { kind: Kind.VALIDATION, code: 'validation_failed', details });
  }
}

export class PolicyError extends DispatchError {
  constructor(message, details) {
    super(message, { kind: Kind.POLICY, code: 'policy_unavailable', details });
  }
}

export class MissingCredentialError extends DispatchError {
  constructor(envVar) {
    super(
      `Cursor API credential not available in this environment: environment variable "${envVar}" is unset or empty. ` +
        `Attach the existing secret to this environment under that exact name (Cursor Dashboard → Cloud Agents → Secrets), ` +
        `then re-run. This client never accepts the key as a CLI argument and never prints it.`,
      { kind: Kind.MISSING_CREDENTIAL, code: 'secret_not_available', details: { envVar } },
    );
    this.envVar = envVar;
  }
}

export class AuthError extends DispatchError {
  constructor(message, details, status = 401) {
    super(message, { kind: Kind.AUTH, code: 'unauthorized', status, details });
  }
}

export class AgentBusyError extends DispatchError {
  constructor(message, details) {
    super(message, { kind: Kind.BUSY, code: 'agent_busy', status: 409, details });
  }
}

export class RateLimitError extends DispatchError {
  constructor(message, details, retryAfterMs = null) {
    super(message, { kind: Kind.RATE_LIMIT, code: 'rate_limited', status: 429, details, retryAfterMs });
  }
}

export class NotFoundError extends DispatchError {
  constructor(message, details) {
    super(message, { kind: Kind.NOT_FOUND, code: 'not_found', status: 404, details });
  }
}

export class ConflictError extends DispatchError {
  constructor(message, details, code = 'conflict') {
    super(message, { kind: Kind.CONFLICT, code, status: 409, details });
  }
}

export class TransientError extends DispatchError {
  constructor(message, details, status = null) {
    super(message, { kind: Kind.TRANSIENT, code: 'transient_failure', status, details });
  }
}

export class TimeoutError extends DispatchError {
  constructor(message, details) {
    super(message, { kind: Kind.TIMEOUT, code: 'request_timeout', details });
  }
}

/**
 * A create request whose outcome is unknown. Never a plain failure: an agent
 * may already exist server-side, so the caller must reconcile before retrying.
 */
export class AmbiguousCreateError extends DispatchError {
  constructor(message, details) {
    super(message, { kind: Kind.AMBIGUOUS, code: 'create_ambiguous', details });
  }
}

export class ApiError extends DispatchError {
  constructor(message, { status, code, details } = {}) {
    super(message, { kind: Kind.API, code: code ?? 'api_error', status, details });
  }
}
