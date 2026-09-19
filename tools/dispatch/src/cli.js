import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createContext } from './context.js';
import { createLogger } from './logger.js';
import { DispatchError, Kind, ValidationError } from './errors.js';
import { requirePolicy } from './policy.js';
import { assertNoSecretInArgv } from './validate.js';
import { redact } from './redact.js';
import { authCheck } from './commands/auth-check.js';
import { discover } from './commands/discover.js';
import { launch } from './commands/launch.js';
import { status } from './commands/status.js';
import { result } from './commands/result.js';
import { followup } from './commands/followup.js';
import { recover } from './commands/recover.js';
import { cancel } from './commands/cancel.js';
import { usage } from './commands/usage.js';

export const EXIT = Object.freeze({
  OK: 0,
  VALIDATION: 1,
  API: 2,
  NO_CREDENTIAL: 3,
  AMBIGUOUS: 4,
  BUSY: 5,
});

const OPTIONS = {
  'task-id': { type: 'string' },
  'agent-id': { type: 'string' },
  'run-id': { type: 'string' },
  mission: { type: 'string' },
  repo: { type: 'string' },
  'starting-ref': { type: 'string' },
  'base-commit': { type: 'string' },
  model: { type: 'string' },
  'prompt-file': { type: 'string' },
  policy: { type: 'string' },
  'records-dir': { type: 'string' },
  'api-base': { type: 'string' },
  'log-level': { type: 'string' },
  wait: { type: 'boolean', default: false },
  artifacts: { type: 'boolean', default: false },
  refresh: { type: 'boolean', default: false },
  'auto-create-pr': { type: 'boolean', default: false },
  'allow-branch-ref': { type: 'boolean', default: false },
  'work-on-current-branch': { type: 'boolean', default: false },
  'no-repos': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

const USAGE = `dispatch <command> [options]

Commands
  auth-check   Verify the API credential is attached and accepted (never prints it)
  discover     List model ids (GET /v1/models) and permitted repositories (GET /v1/repositories)
  launch       Create an agent for an approved mission at an explicit base commit
  status       Read agent + run state; --wait polls with backoff and a hard timeout
  result       Read the terminal run result, pushed branches, and artifact references
  followup     Submit one bounded follow-up, only while the agent is IDLE
  recover      Rebuild known agent/run ids from durable local records (offline by default)
  cancel       Cancel the active run of an owned agent
  usage        Report token usage; cost and allowance are reported as unknown

Common options
  --task-id <id>            Durable client task id (preferred handle for every command)
  --agent-id <bc-...>       Explicit agent id instead of a task record
  --run-id <run-...>        Explicit run id
  --policy <path>           Dispatch policy path (default: config/dispatch-policy.json)
  --records-dir <path>      Durable record directory (default: policy recordsDir)
  --api-base <url>          Override the API base URL
  --log-level <level>       silent | error | warn | info | debug

launch options
  --mission <id>            Mission id defined in the policy missions map
  --repo <url>              Repository URL; must be in the policy allowlist
  --starting-ref <ref>      Branch or commit SHA passed to the API as repos[0].startingRef
  --base-commit <sha40>     Expected base commit, recorded durably
  --model <id>              Model id from discovery; omit to use the account default
  --prompt-file <path>      File containing the approved task text (never passed via argv)
  --allow-branch-ref        Permit a moving branch ref as --starting-ref
  --auto-create-pr          Only honoured when the policy sets autoCreatePR: true
  --work-on-current-branch  Push to startingRef instead of a generated cursor/ branch

The credential is read from the environment variable named by the policy's
"apiKeyEnv" (default DEXTER_CURSOR_API_KEY). It is never accepted as an argument.
`;

const NEEDS_POLICY = new Set(['launch']);
const OFFLINE_CAPABLE = new Set(['recover']);

function readPromptFile(path) {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new ValidationError(`Cannot read --prompt-file "${path}": ${err.code ?? 'read error'}.`);
  }
}

export async function run(argv, deps = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    fetchImpl = globalThis.fetch,
    stdout = process.stdout,
    stderr = process.stderr,
    sleep,
    random,
    now,
  } = deps;

  const command = argv[0];
  let parsed;
  try {
    parsed = parseArgs({ args: argv.slice(1), options: OPTIONS, allowPositionals: false, strict: true });
  } catch (err) {
    stderr.write(`${err.message}\n\n${USAGE}`);
    return EXIT.VALIDATION;
  }
  const flags = parsed.values;

  if (!command || flags.help || command === 'help') {
    stdout.write(USAGE);
    return command && command !== 'help' ? EXIT.VALIDATION : EXIT.OK;
  }

  const logger = createLogger({ level: flags['log-level'] ?? 'info', stdout, stderr });

  try {
    const options = {
      policy: flags.policy,
      recordsDir: flags['records-dir'],
      apiBase: flags['api-base'],
    };

    // Probe the policy first so the configured secret variable name is known
    // before any argv hygiene check runs.
    const probe = createContext({ options, env, cwd, fetchImpl, logger, sleep, random, online: false });
    assertNoSecretInArgv(argv, probe.apiKeyEnv, env);

    const offline = OFFLINE_CAPABLE.has(command) && !flags.refresh;
    const ctx = offline
      ? probe
      : createContext({ options, env, cwd, fetchImpl, logger, sleep, random, online: true });
    ctx.now = now;
    ctx.sleep = sleep;

    if (NEEDS_POLICY.has(command)) {
      requirePolicy({ policy: ctx.policy, source: ctx.policySource, present: ctx.policyPresent }, command);
    }

    if (!offline && command !== 'auth-check' && !ctx.credential.present) {
      // Fail with the same actionable message auth-check gives, not a crash.
      ctx.credential.get();
    }

    const payload = await dispatch(command, ctx, flags);
    logger.result(payload);
    return exitCodeFor(payload);
  } catch (err) {
    if (err instanceof DispatchError) {
      logger.result({ ok: false, ...err.toJSON() });
      if (err.kind === Kind.MISSING_CREDENTIAL) return EXIT.NO_CREDENTIAL;
      if (err.kind === Kind.AMBIGUOUS) return EXIT.AMBIGUOUS;
      if (err.kind === Kind.BUSY) return EXIT.BUSY;
      if (err.kind === Kind.VALIDATION || err.kind === Kind.POLICY) return EXIT.VALIDATION;
      return EXIT.API;
    }
    logger.result({ ok: false, error: 'UnexpectedError', message: String(redact(err?.message ?? err)) });
    return EXIT.API;
  }
}

async function dispatch(command, ctx, flags) {
  const target = { taskId: flags['task-id'], agentId: flags['agent-id'], runId: flags['run-id'] };

  switch (command) {
    case 'auth-check':
      return authCheck(ctx);
    case 'discover':
      return discover(ctx, { includeRepositories: !flags['no-repos'] });
    case 'launch':
      return launch(ctx, {
        taskId: flags['task-id'],
        missionId: flags.mission,
        repoUrl: flags.repo,
        startingRef: flags['starting-ref'],
        baseCommit: flags['base-commit'],
        model: flags.model ?? null,
        prompt: readPromptFile(flags['prompt-file']),
        autoCreatePR: flags['auto-create-pr'],
        allowBranchRef: flags['allow-branch-ref'],
        workOnCurrentBranch: flags['work-on-current-branch'],
      });
    case 'status':
      return status(ctx, { ...target, wait: flags.wait, includeArtifacts: flags.artifacts });
    case 'result':
      return result(ctx, target);
    case 'followup':
      return followup(ctx, { ...target, prompt: readPromptFile(flags['prompt-file']) });
    case 'recover':
      return recover(ctx, { taskId: flags['task-id'] ?? null, refresh: flags.refresh });
    case 'cancel':
      return cancel(ctx, target);
    case 'usage':
      return usage(ctx, target);
    default:
      throw new ValidationError(`Unknown command "${command}". Run "dispatch help" for the command list.`);
  }
}

function exitCodeFor(payload) {
  if (payload.ok) return EXIT.OK;
  if (payload.reason === 'secret_not_available') return EXIT.NO_CREDENTIAL;
  if (payload.reason === 'agent_busy') return EXIT.BUSY;
  if (payload.reason === 'credential_rejected') return EXIT.API;
  return EXIT.API;
}

export { USAGE };
