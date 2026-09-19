# dispatch — Cursor Cloud Agents client for Dexter HQ

A thin, authenticated CLI for the Cursor Cloud Agents API v1 (public beta). HQ uses it to
launch, observe, follow up on, and recover delegated workers. It is deliberately small:
no framework, no dashboard, no message bus, no vector store, and **zero runtime
dependencies**.

## Runtime

Node.js (ESM, `>=20.11`), plain JavaScript with JSDoc-style comments.

Justification: the only transport needed is `fetch`, the only test harness needed is
`node:test`, and argument parsing is covered by `node:util.parseArgs` — all built into the
Node runtime that both Dexter repositories already use. A TypeScript build step would add
a toolchain and a compile artifact for a tool of this size, and Python would introduce a
second language into a JavaScript workspace. Dependency count is zero, so the client has
no supply-chain surface of its own and runs offline.

## Commands

```
dispatch auth-check   # verify the credential is attached and accepted (never prints it)
dispatch discover     # model ids from GET /v1/models, repositories from GET /v1/repositories
dispatch launch       # create one agent for an approved mission at an explicit base commit
dispatch status       # agent + run state; --wait polls with backoff and a hard timeout
dispatch result       # terminal run result, pushed branches, artifact references
dispatch followup     # one bounded follow-up, only while the agent is IDLE
dispatch recover      # rebuild agent/run ids from durable local records (offline by default)
dispatch cancel       # cancel the active run of an owned agent
dispatch usage        # token usage and reported cost in cents; allowance stays unknown
```

Run `dispatch help` for the full option list. Every command writes a single JSON document
to stdout and human-readable diagnostics to stderr.

Exit codes: `0` ok, `1` validation/policy, `2` API failure, `3` credential absent,
`4` ambiguous create, `5` agent busy.

### Example

```bash
dispatch discover --no-repos
dispatch launch \
  --task-id barber-001 \
  --mission barber-recovery \
  --repo https://github.com/Roberto-Madrid/dexter-barber \
  --starting-ref 53fac961c485b8ff6799b838a062f50905af0682 \
  --base-commit 53fac961c485b8ff6799b838a062f50905af0682 \
  --model composer-2 \
  --prompt-file missions/barber-001.md
dispatch status --task-id barber-001 --wait
dispatch result --task-id barber-001
```

## Credential handling

The API key is read **only** from an environment variable whose name comes from the policy
file's `apiKeyEnv` (default `DEXTER_CURSOR_API_KEY`, matching the pre-existing
`dexter-barber/.cursor/dispatch.json`). It is never accepted as a command-line argument,
never written to a durable record, never placed in a child environment, and never logged.

- The `Authorization` header is constructed in exactly one place (`src/http.js`) and is
  masked wherever a header object is serialized.
- `src/redact.js` masks registered literal secret values, prefixed credential shapes
  (`key_`, `sk-`, `gh?_`, JWTs), `Bearer`/`Basic` header values, URL userinfo, and
  unprefixed high-entropy tokens. Git SHAs, agent ids and run ids are deliberately left
  readable.
- The client aborts before any work if a credential-shaped value appears in `argv`.
- The task prompt is read from `--prompt-file`, never from `argv`.

If the variable is unset, `auth-check` returns `ok: false`, `reason: secret_not_available`
and exit code `3` with an actionable message naming the variable. It does not crash and it
does not attempt a network call.

## Dispatch policy contract

The client **reads** `config/dispatch-policy.json` and never writes it — that file is owned
elsewhere. It is read defensively: a missing file is tolerated by `auth-check`, `discover`
and `recover` (built-in defaults apply), and `launch` fails loudly with the expected path.
Override the location with `--policy <path>`.

### Two shapes, one source of truth

HQ authors the policy as a nested governance document (`"kind": "dispatch-policy"`) that
carries rationale, enforcement notes and provenance the client has no use for. The flat
table below is the client's internal contract. When the file is the canonical document,
`adaptCanonicalPolicy` in `src/policy.js` **derives** every flat key from it:

| Flat key | Derived from |
| --- | --- |
| `apiKeyEnv` | `credentials.cursor_api_key_env` |
| `apiBase` | `api.base_url` |
| `recordsDir` | `dispatch_records.directory` |
| `repositoryAllowlist` | `repository_allowlist.entries[].canonical_url` |
| `missions` | `missions{}`, with `repository_ids` resolved against the allowlist entry ids |
| `allowedModelIds` | `model_policy.discovery.available_model_ids` |
| `maxConcurrentAgents` | `concurrency_limits.concurrent_implementation_workers` |
| `autoCreatePR` | `pull_requests.auto_create_pr_during_bootstrap` |
| `requestTimeoutMs` / `pollTimeoutMs` | `timeouts.request_ms` / `timeouts.poll_ms` |

Derived values win over same-named raw keys, because `missions` exists in both shapes and
the canonical form carries the repository restriction under `repository_ids`. Do not add
flat keys to a canonical document: they will be ignored and the two shapes will drift.
A file that is *not* the canonical document is read as the flat schema directly.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `apiBase` | string | `https://api.cursor.com` | API root. |
| `apiKeyEnv` | string | `DEXTER_CURSOR_API_KEY` | Environment variable holding the API key. Must be `UPPER_SNAKE_CASE`. |
| `autoCreatePR` | boolean | `false` | Master switch for automatic PR creation. `--auto-create-pr` is rejected unless this is `true`. |
| `maxConcurrentAgents` | number | `2` | Dispatch slots. `launch` counts `ACTIVE` agents and refuses when the limit is reached. |
| `recordsDir` | string | `.dexter/dispatch` | Durable record root, relative to the working directory. |
| `repositoryAllowlist` | string[] | `[]` | Permitted repository URLs. `launch` requires a non-empty list. |
| `allowedModelIds` | string[] | `[]` | Optional narrowing of discovered model ids. Empty means "any discovered id". |
| `missions` | object | `{}` | `{ "<missionId>": { "description": string, "repositories": string[] } }`. An empty/absent `repositories` means the mission is not repository-restricted. |
| `requestTimeoutMs` | number | `30000` | Per-request timeout. |
| `pollTimeoutMs` | number | `900000` | Hard ceiling for `status --wait`. |

Repository comparison is normalized: scheme, `git@host:` form, `.git` suffix, trailing
slash and letter case are all ignored.

Minimal example:

```json
{
  "apiKeyEnv": "DEXTER_CURSOR_API_KEY",
  "apiBase": "https://api.cursor.com",
  "autoCreatePR": false,
  "maxConcurrentAgents": 2,
  "repositoryAllowlist": [
    "https://github.com/Roberto-Madrid/dexter-hq",
    "https://github.com/Roberto-Madrid/dexter-barber"
  ],
  "missions": {
    "barber-recovery": {
      "description": "Barber application recovery",
      "repositories": ["https://github.com/Roberto-Madrid/dexter-barber"]
    }
  }
}
```

## Durable records

Records live under `<recordsDir>/records/<taskId>.json` with an append-only
`<recordsDir>/journal.jsonl`. Each file is written atomically (temp file, `fsync`, rename)
with mode `0600`, and is passed through redaction on the way out.

An intent record is written **before** the create request and the returned ids are written
**immediately after**, so no outcome is ever lost. Record states:

`intent` → `launched` | `ambiguous` → `reconciled` | `not_created`, then `closed`.

`recover` rebuilds every known agent and run id from these files alone, in a fresh process,
with no credential and no network access.

Records contain no secrets, but they are operational state rather than source.

HQ **commits** `.dexter/dispatch/` deliberately (`dispatch_records.committed: true` in the
policy): a durable agent id is worthless if it only exists on the disk of the session that
created it. Committing the records is what lets a later HQ session with no access to the
originating conversation run `dispatch recover` from the repository root and pick the work
back up. A consumer of this client that does not need cross-session recovery should
`.gitignore` `.dexter/` instead. This tool writes nothing outside `recordsDir`.

## Ambiguity, concurrency, and state handling

- A create that times out or fails at the network layer is **ambiguous, not failed**. The
  client marks the record `ambiguous` and reconciles with supported lookups only:
  `GET /v1/agents/{clientAgentId}`, then paged `GET /v1/agents` matching a
  `[task:<taskId>]` marker embedded in the agent `name`. It never re-POSTs.
- A client-generated `agentId` (`bc-<uuid>`) is supplied on create. `409 agent_id_conflict`
  is treated as "already exists" and resolved by lookup. Server-side idempotency is used
  when it is there but never assumed.
- Only GET requests are retried, with exponential backoff, jitter, `Retry-After` support
  and a bounded attempt count. Creates and follow-ups are never retried automatically.
- A follow-up is withheld entirely unless the agent reports `IDLE`; a `409 agent_busy` is
  reported once and never re-sent.
- `status --wait` has a hard timeout and always leaves a resume record.
- `autoCreatePR` defaults to `false`.
- Requested and effective model are reported separately. Effective model is always `null`
  with `effectiveSource: "not_exposed_by_api"` — it is never inferred.

## Live schema verification

Verified against <https://cursor.com/docs/cloud-agent/api/endpoints> on **2026-09-19**.
The page is labelled "Cloud Agents API v1 — public beta; APIs may change before general
availability", so treat everything below as a snapshot.

### Confirmed from the live documentation

| Endpoint | Fields this client relies on |
| --- | --- |
| `POST /v1/agents` | Request: `prompt.text` (required), `model.id`, `name` (max 100 chars), `repos[].url`, `repos[].startingRef`, `workOnCurrentBranch`, `autoCreatePR`, `agentId` (client-supplied, `bc-` form, re-POST returns `409 agent_id_conflict`). Response: `{ agent, run }` with `agent.id`, `agent.name`, `agent.status`, `agent.url`, `agent.latestRunId`, `run.id`, `run.agentId`, `run.status`. |
| `GET /v1/agents` | `items[]` with `id`, `name`, `status`, `url`, `createdAt`, `updatedAt`, `latestRunId`; `nextCursor` **omitted** (not `null`) when exhausted; `limit` max 100; `includeArchived`. |
| `GET /v1/agents/{id}` | `status` ∈ `ACTIVE` / `IDLE` / `ARCHIVED`, plus `repos`, `autoCreatePR`, `workOnCurrentBranch`, `latestRunId`. |
| `POST /v1/agents/{id}/runs` | Request `prompt.text`; response `{ run }`. One active run per agent; `409 agent_busy` while another run is `CREATING` or `RUNNING`. |
| `GET /v1/agents/{id}/runs/{runId}` | `id`, `agentId`, `status`, `createdAt`, `updatedAt`, `durationMs` (terminal), `result` (terminal), `git.branches[] = { repoUrl, branch?, prUrl? }`. Documented explicitly: `git` is **per-agent, not per-run**, and `repoUrl` here has no scheme. |
| `POST /v1/agents/{id}/runs/{runId}/cancel` | Returns `{ id }`; `409 run_not_cancellable` for an already-terminal or never-active run; cancellation is terminal. |
| `GET /v1/agents/{id}/artifacts` | `items[] = { path, sizeBytes, updatedAt }`, `path` relative to `artifacts/`. |
| `GET /v1/agents/{id}/usage` | `totalUsage` and `runs[] = { id, usageUuid?, usage }` with `inputTokens`, `outputTokens`, `cacheWriteTokens`, `cacheReadTokens`, `totalTokens`; optional `runId` query. |
| `GET /v1/me` | `apiKeyName`, `createdAt`; `userId` / `userEmail` / `userFirstName` / `userLastName` present only for user-scoped keys and omitted for service-account keys. |
| `GET /v1/models` | `items[] = { id, displayName, description?, aliases?, parameters?, variants? }`; `model.id` must be a value returned here. |
| `GET /v1/repositories` | `items[] = { url }`; documented rate limit 1/user/minute and 30/user/hour, and documented as possibly taking tens of seconds. |
| Auth | Both Basic and Bearer are accepted. This client sends `Authorization: Bearer <key>`. |

Run statuses `CREATING`, `RUNNING` and `FINISHED` appear in live response examples.
`ERROR`, `CANCELLED` and `EXPIRED` are named in the "Get A Run" prose as the terminal set
alongside `FINISHED` (`durationMs` "computed once the run reaches FINISHED, ERROR,
CANCELLED, or EXPIRED").

### Not confirmed — treated defensively

- **No machine-readable OpenAPI document was reachable.** The docs link to "the full
  OpenAPI specification", but `api.cursor.com/v1/openapi.json` returned 404 and the
  documentation-site paths tried returned 500 or non-JSON HTML. So the run-status list
  above is derived from prose and examples, not from an enumerated schema. Any status this
  client does not recognise maps to `unknown` — never to a guessed state.
- **Error response body shape is not documented as a schema.** Codes such as `agent_busy`,
  `agent_id_conflict`, `run_not_cancellable`, `invalid_last_event_id`, `stream_expired` and
  `cursor_expired` are named in prose. This client reads `code` and falls back to
  `error` / `message` / `detail`, and classifies primarily by HTTP status.
- **Rate-limit headers are not documented.** `Retry-After` is honoured if present (numeric
  seconds or HTTP date); otherwise exponential backoff applies.
- **Effective/resolved model is not returned** by any documented response. Reported as
  `null` / `unknown`, never inferred from the request.
- **Remaining allowance is not exposed** anywhere in v1; `usage` reports it as `unknown`.
  Cost, however, *is* returned — see "Corrections from live use" below.
- **No concurrency-limit endpoint exists.** Remaining dispatch slots are computed by
  counting `ACTIVE` agents from `GET /v1/agents` against the policy's
  `maxConcurrentAgents`. That is a client-side control, not a server-enforced cap.
- **Webhooks are "coming soon"** for v1; none are used. Completion is observed by polling.
- **SSE streaming (`.../stream`) is documented but not implemented here** — polling is
  sufficient for HQ's current needs and avoids the stream-retention and
  `Last-Event-ID` resume complexity.
- **`startingRef` pinning cannot be verified client-side.** The API accepts a branch or a
  SHA and resolves it when the run starts. `launch` therefore requires a full 40-character
  `--base-commit`, refuses a moving branch ref unless `--allow-branch-ref` is passed, and
  records the expected commit durably so integration can check it afterwards.
### Corrections from live use

`DEXTER_CURSOR_API_KEY` was later attached to the HQ environment and the client was
exercised end to end against the live API on 2026-09-19. Full evidence, including real ids
and SHAs, is in `bootstrap/evidence/live-dispatch-proofs.md`. What the live run changed:

- **Cost is returned, contrary to the note above.** `GET /v1/agents/{id}/usage` carries an
  undocumented `cost` object — `{ rawCostCents, chargedCents }` — both at the top level and
  per run. `usage` now reports it with `status: "reported"` and names the field it came
  from, and still reports `unknown` when the field is absent. It is never estimated.
- **Dispatch slots counted the wrong population.** `GET /v1/agents` returns every agent
  belonging to the key's owner, including their interactive sessions and unrelated
  projects. Counting all ACTIVE agents made the limit unsatisfiable by construction, since
  the HQ session issuing `launch` is itself ACTIVE. Only agents carrying this client's
  `[task:<id>]` name marker consume a slot; the account-wide total is reported alongside.
- **A branch in `git.branches` does not mean anything was pushed.** A finished run that
  wrote nothing still reported an entry for the branch name assigned to the agent, and that
  branch did not exist on the remote. `result` now labels this via `branchesMeaning`.
- **Generated branch names were being redacted as high-entropy secrets.** Identifier-valued
  keys (`branch`, `url`, `ref`, and friends) now skip the unprefixed-token heuristic while
  still masking known credential shapes.
- **A client-supplied `agentId` is honoured.** The returned `agent.id` equalled the
  `bc-<uuid>` sent on create, so the ambiguity design rests on observed behaviour.
- **Model ids are bare.** Discovery returned 38 ids of the form `claude-opus-5` plus a
  separate parameter list. Composite slugs such as `claude-opus-5-thinking-high` are
  in-session subagent names and are **not** valid API model ids.

## Tests

```bash
cd tools/dispatch
node --test test/*.test.js
```

Fully offline: no network, no API key, no dependency installation. All HTTP is a route
table injected in place of `fetch`; the fresh-process recovery test spawns the real binary
with a stripped environment.

Coverage: request-validation rejection (allowlist, mission, base commit, moving ref,
undiscovered model, dispatch slots, `autoCreatePR`); secret redaction in errors, logs,
durable records and `argv`; intent-record-before-launch ordering; duplicate-launch
ambiguity reconciled by lookup with an assertion that exactly one POST is ever sent;
`agent_id_conflict`; duplicate task id; busy agent both pre-flight and via `409 agent_busy`;
rate-limit backoff with `Retry-After`; transient retry and no-retry-on-create; every
documented run and agent status plus the unknown fallback; bounded polling to a hard
timeout with a resume record; and recovery of ids from durable records in a fresh process.
