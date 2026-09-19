/**
 * Thin bindings for the Cursor Cloud Agents API v1 (public beta).
 * Paths and payload shapes are transcribed from the live endpoints
 * documentation; see tools/dispatch/README.md for the verification record.
 */
export function createApi(http) {
  return {
    /** GET /v1/me — identity of the key, used for auth-check. */
    me: () => http.request({ method: 'GET', path: '/v1/me' }),

    /** GET /v1/models — the only permitted source of model ids. */
    listModels: () => http.request({ method: 'GET', path: '/v1/models' }),

    /** GET /v1/repositories — strict rate limit: 1/user/min, 30/user/hour. */
    listRepositories: () => http.request({ method: 'GET', path: '/v1/repositories' }),

    /** POST /v1/agents — never auto-retried; a second POST can duplicate work. */
    createAgent: (body) => http.request({ method: 'POST', path: '/v1/agents', body, retry: false }),

    listAgents: (query) => http.request({ method: 'GET', path: '/v1/agents', query }),

    getAgent: (agentId) => http.request({ method: 'GET', path: `/v1/agents/${encodeURIComponent(agentId)}` }),

    /** POST /v1/agents/{id}/runs — follow-up; 409 agent_busy when a run is live. */
    createRun: (agentId, body) =>
      http.request({ method: 'POST', path: `/v1/agents/${encodeURIComponent(agentId)}/runs`, body, retry: false }),

    listRuns: (agentId, query) =>
      http.request({ method: 'GET', path: `/v1/agents/${encodeURIComponent(agentId)}/runs`, query }),

    getRun: (agentId, runId) =>
      http.request({
        method: 'GET',
        path: `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      }),

    cancelRun: (agentId, runId) =>
      http.request({
        method: 'POST',
        path: `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
        retry: false,
      }),

    listArtifacts: (agentId) =>
      http.request({ method: 'GET', path: `/v1/agents/${encodeURIComponent(agentId)}/artifacts` }),

    /** GET /v1/agents/{id}/usage — token usage only; no cost or quota figures. */
    getUsage: (agentId, runId) =>
      http.request({
        method: 'GET',
        path: `/v1/agents/${encodeURIComponent(agentId)}/usage`,
        query: runId ? { runId } : undefined,
      }),
  };
}
