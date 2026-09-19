import { redact, redactString } from './redact.js';

/**
 * Human-readable diagnostics go to stderr; machine-readable results go to
 * stdout. Both are redacted unconditionally.
 */
export function createLogger({ level = 'info', stderr = process.stderr, stdout = process.stdout } = {}) {
  const order = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  const threshold = order[level] ?? order.info;

  const emit = (lvl, message, meta) => {
    if ((order[lvl] ?? 99) > threshold) return;
    let line = `[dispatch] ${lvl}: ${redactString(String(message))}`;
    if (meta !== undefined) line += ` ${JSON.stringify(redact(meta))}`;
    stderr.write(`${line}\n`);
  };

  return {
    level,
    error: (m, meta) => emit('error', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    info: (m, meta) => emit('info', m, meta),
    debug: (m, meta) => emit('debug', m, meta),
    result: (value) => {
      stdout.write(`${JSON.stringify(redact(value), null, 2)}\n`);
    },
  };
}
