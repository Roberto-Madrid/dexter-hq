import { ValidationError } from './errors.js';
import { normalizeRepoUrl } from './policy.js';
import { looksLikeSecret } from './redact.js';

const SHA40 = /^[0-9a-f]{40}$/i;

/** Refuses to run at all if a credential-shaped value was passed on the command line. */
export function assertNoSecretInArgv(argv, envVarName, env = process.env) {
  const configured = env?.[envVarName];
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    if (configured && arg.includes(configured)) {
      throw new ValidationError(
        `Refusing to run: the value of ${envVarName} was passed as a command-line argument. ` +
          `Credentials must come from the environment only. Rotate the key — argv is visible to other processes.`,
      );
    }
    if (/^--?(api[-_]?key|token|secret|authorization)(=|$)/i.test(arg)) {
      throw new ValidationError(
        `Refusing to run: "${arg.split('=')[0]}" is not a supported option. The credential is read from ${envVarName} only.`,
      );
    }
    if (looksLikeSecret(arg)) {
      throw new ValidationError(
        'Refusing to run: a command-line argument looks like a credential. Pass secrets via the environment only.',
      );
    }
  }
}

/**
 * Every precondition from plan section 5 rule 2: allowlist, mission, scope
 * revision, expected commit, requested model, remaining dispatch slots.
 */
export function validateLaunch({
  policy,
  missionId,
  repoUrl,
  startingRef,
  expectedBaseCommit,
  modelId,
  discoveredModelIds,
  activeAgentCount,
  autoCreatePR,
  allowBranchRef = false,
}) {
  const problems = [];

  const normalizedRepo = normalizeRepoUrl(repoUrl);
  if (!normalizedRepo) {
    problems.push('repository: missing or unparseable --repo URL');
  } else {
    const allowed = new Set(policy.repositoryAllowlist.map(normalizeRepoUrl).filter(Boolean));
    if (!allowed.has(normalizedRepo)) {
      problems.push(
        `repository: "${repoUrl}" is not in repositoryAllowlist (${[...allowed].join(', ') || 'empty'}). ` +
          'Refusing to dispatch against an unapproved repository.',
      );
    }
  }

  const mission = policy.missions?.[missionId];
  if (!missionId) {
    problems.push('mission: --mission is required');
  } else if (!mission) {
    problems.push(
      `mission: "${missionId}" is not defined in the policy missions map (${Object.keys(policy.missions ?? {}).join(', ') || 'empty'})`,
    );
  } else if (Array.isArray(mission.repositories) && mission.repositories.length > 0 && normalizedRepo) {
    const missionRepos = new Set(mission.repositories.map(normalizeRepoUrl).filter(Boolean));
    if (!missionRepos.has(normalizedRepo)) {
      problems.push(`mission: "${missionId}" does not permit repository "${repoUrl}"`);
    }
  }

  if (!startingRef || typeof startingRef !== 'string') {
    problems.push('scope revision: --starting-ref is required (branch name or commit SHA)');
  }
  if (!expectedBaseCommit || !SHA40.test(String(expectedBaseCommit))) {
    problems.push('expected base commit: --base-commit must be a full 40-character commit SHA');
  } else if (startingRef && SHA40.test(startingRef) && startingRef.toLowerCase() !== String(expectedBaseCommit).toLowerCase()) {
    problems.push(
      `expected base commit: --starting-ref (${startingRef}) and --base-commit (${expectedBaseCommit}) disagree`,
    );
  } else if (startingRef && !SHA40.test(startingRef) && !allowBranchRef) {
    problems.push(
      `scope revision: --starting-ref "${startingRef}" is a moving ref. The API pins the agent to whatever that ref ` +
        'points at when the run starts, which this client cannot verify. Pass the SHA, or add --allow-branch-ref to accept the risk.',
    );
  }

  let effectiveModelRequest = null;
  if (modelId !== null && modelId !== undefined) {
    if (!Array.isArray(discoveredModelIds)) {
      problems.push('model: discovery data unavailable; refusing to send an unverified model id');
    } else if (!discoveredModelIds.includes(modelId)) {
      problems.push(
        `model: "${modelId}" was not returned by GET /v1/models discovery (${discoveredModelIds.join(', ') || 'none'}). ` +
          'Model ids must come from discovery, never from a remembered alias.',
      );
    } else if (
      Array.isArray(policy.allowedModelIds) &&
      policy.allowedModelIds.length > 0 &&
      !policy.allowedModelIds.includes(modelId)
    ) {
      problems.push(`model: "${modelId}" is not in the policy allowedModelIds`);
    } else {
      effectiveModelRequest = { id: modelId };
    }
  }

  const limit = Number(policy.maxConcurrentAgents);
  if (!Number.isFinite(limit) || limit <= 0) {
    problems.push('concurrency: policy maxConcurrentAgents must be a positive number');
  } else if (activeAgentCount === null || activeAgentCount === undefined) {
    problems.push('concurrency: active agent count is unknown; refusing to launch blind against the dispatch limit');
  } else if (activeAgentCount >= limit) {
    problems.push(`concurrency: ${activeAgentCount}/${limit} dispatch slots already in use`);
  }

  if (autoCreatePR === true && policy.autoCreatePR !== true) {
    problems.push('autoCreatePR: policy keeps automatic PR creation off; --auto-create-pr is not permitted under this policy');
  }

  if (problems.length > 0) {
    throw new ValidationError(`Launch rejected: ${problems.length} precondition(s) failed.`, { problems });
  }

  return {
    repoUrl,
    normalizedRepo,
    missionId,
    startingRef,
    expectedBaseCommit: String(expectedBaseCommit).toLowerCase(),
    requestedModel: effectiveModelRequest,
    autoCreatePR: autoCreatePR === true,
    slots: { used: activeAgentCount, limit },
  };
}
