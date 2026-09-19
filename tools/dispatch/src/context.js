import { createApi } from './api.js';
import { createHttpClient } from './http.js';
import { createStore } from './store.js';
import { loadPolicy } from './policy.js';
import { readCredential } from './secrets.js';

/**
 * Wires policy → credential → transport → store. `online: false` builds
 * everything except the HTTP layer so local-only commands work with no key.
 */
export function createContext({
  options = {},
  env = process.env,
  cwd = process.cwd(),
  fetchImpl = globalThis.fetch,
  logger,
  sleep,
  random,
  online = true,
} = {}) {
  const loaded = loadPolicy({ path: options.policy, cwd });
  const policy = loaded.policy;
  const apiKeyEnv = options.apiKeyEnv ?? policy.apiKeyEnv;
  const credential = readCredential(apiKeyEnv, env);
  const store = createStore({ dir: options.recordsDir ?? policy.recordsDir, cwd });

  let http = null;
  let api = null;
  if (online) {
    http = createHttpClient({
      baseUrl: options.apiBase ?? policy.apiBase,
      credential,
      fetchImpl,
      logger,
      timeoutMs: options.requestTimeoutMs ?? policy.requestTimeoutMs,
      sleep,
      random,
    });
    api = createApi(http);
  }

  return { policy, policySource: loaded.source, policyPresent: loaded.present, apiKeyEnv, credential, store, http, api, logger };
}
