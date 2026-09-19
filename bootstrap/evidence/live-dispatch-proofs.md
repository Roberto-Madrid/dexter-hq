# Live dispatch proofs

Acceptance evidence for the Dexter HQ dispatch capability, produced by exercising
`tools/dispatch/` against the live Cursor Cloud Agents API on **2026-09-19**.

Every claim below is labelled:

- **supported** — this session ran the command and saw the output quoted here.
- **reported** — a dispatched agent stated it; correct by its own account, not independently
  re-executed by HQ.
- **unverified** — believed but not demonstrated here.
- **unavailable** — the platform does not expose it.

Scope note: this document covers HQ dispatch capability only. It is not barber recovery.
It deliberately does not cover the fresh-session recovery proof — see
[Deliberately not proved here](#deliberately-not-proved-here).

Sibling evidence files `bootstrap/capabilities.md` and
`bootstrap/evidence/live-api-verification.md` are owned by a different worker and are not
modified here.

## Provenance

| Item | Value | Label |
| --- | --- | --- |
| Branch | `bootstrap/live-proofs` | supported |
| Branched from | `origin/bootstrap/integration` at `017bcf1307eb06cb39dab884c0a4df869c00f91b` | supported |
| Integration tip verified | `git rev-parse origin/bootstrap/integration` returned the same SHA the assignment named | supported |
| HEAD at start of work | `017bcf1307eb06cb39dab884c0a4df869c00f91b` | supported |
| Node runtime | v22.14.0 | supported |
| Client test suite | 68 tests, 68 pass, 0 fail (`node --test tools/dispatch/test/*.test.js`) | supported |

Credential handling: `DEXTER_CURSOR_API_KEY` was read only from the environment. It was
never printed, echoed, logged, committed, or passed as a command argument. A scan of every
committed dispatch record and every file authored here found zero occurrences of the
literal key value (**supported**).

## 0. Authentication

`dispatch auth-check`:

```json
{
  "ok": true,
  "authenticated": true,
  "apiBase": "https://api.cursor.com",
  "identity": {
    "apiKeyName": "DEXTER_CURSOR_API_KEY",
    "keyScope": "user",
    "userId": 431080337,
    "userEmail": "robbtm40@gmail.com",
    "createdAt": "2026-09-19T04:45:37.078Z"
  }
}
```

The key is **user-scoped**, not a service account: `userId` and `userEmail` are present,
and the live docs state those fields are omitted for service-account keys (**supported**).

Consequence, **supported**: the key inherits the owner's own repository access. Anything
this key can reach, a dispatched agent can reach. The policy allowlist is an operational
control inside this repository, not a platform restriction.

## 1. Discovery

`dispatch discover --no-repos` returned **38 model ids** (**supported**). The full list is
recorded verbatim in `config/dispatch-policy.json` under
`model_policy.discovery.available_model_ids`, in API order.

Confirmed shape: each entry is a bare `id` plus a separate parameter list. For example:

```json
{
  "id": "claude-opus-5",
  "displayName": "Claude Opus 5",
  "aliases": ["opus-latest", "opus", "opus-5"],
  "parameters": [
    { "id": "thinking", "values": ["false", "true"] },
    { "id": "context", "values": ["300k", "1m"] },
    { "id": "effort", "values": ["low", "medium", "high", "xhigh", "max"] },
    { "id": "fast", "values": ["false", "true"] }
  ]
}
```

Composite kebab-case slugs such as `claude-opus-5-thinking-high` are in-session subagent
names and are **not** valid API model ids (**supported** by their absence from all 38 ids).

`dispatch discover` (one call including repositories) returned **9 permitted repositories**
(**supported**). The rate limit is documented at 1/user/minute and 30/user/hour, so this
endpoint was called exactly once in this session and the response cached to
`/tmp/proofs/discover-full.json`:

| Repository | In policy allowlist |
| --- | --- |
| `Roberto-Madrid/dexter-barber` | yes |
| `Roberto-Madrid/dexter-hq` | yes |
| `Roberto-Madrid/demo2` | no |
| `Roberto-Madrid/voyporti` | no |
| `elbmin79/BandiRutas` | no |
| `elbmin79/-BandeeRutas` | no |
| `elbmin79/MiaMotel` | no |
| `elbmin79/MiaMotelAssistant` | no |
| `elbmin79/Discovery-Sistema` | no |

Owner-casing, **supported**: the API reports `Roberto-Madrid` while git remotes and agent
records use `roberto-madrid`. `normalizeRepoUrl` lowercases host and path, so both target
repositories matched the allowlist. A regression test in `tools/dispatch/test/policy.test.js`
pins this.

Policy updated (**supported**): `model_policy.discovery.discovered` is now `true` with
timestamp `2026-09-19T04:56:00Z`, the 38 ids are recorded, and each
`selection.roles[*].requested_model_id` names an id drawn from that list.

## 2. Cross-repository dispatch at an exact commit

Base commit resolved by HQ before launching, via `git ls-remote` against the barber
repository URL (**supported** — the barber working tree was never touched):

```
9ddad27bc056e1715118dda8b04962108659d31b	refs/heads/main
```

Launch command and result (**supported**):

| Field | Value |
| --- | --- |
| Task id | `hq-preflight-001` |
| Mission | `hq-bootstrap-preflight` |
| Repository | `https://github.com/Roberto-Madrid/dexter-barber` |
| `startingRef` / `--base-commit` | `9ddad27bc056e1715118dda8b04962108659d31b` |
| Requested model | `composer-2.5` |
| **Agent id** | **`bc-82f15814-538b-4106-b939-fa1e7e7b0453`** |
| First run id | `run-6f7f0123-ed8e-417b-aa1e-7c07b43af70f` |
| Agent URL | `https://cursor.com/agents/bc-82f15814-538b-4106-b939-fa1e7e7b0453` |
| `autoCreatePR` | `false` |
| Dispatch slots | 0 of 2 used by this client; 2 agents ACTIVE account-wide |
| Effective model | `null`, `effectiveSource: "not_exposed_by_api"` — **unavailable** |

The client supplied `agentId: bc-82f15814-...` on create and the API returned that same id
(**supported**). The ambiguity-reconciliation design therefore rests on observed behaviour,
not an assumption.

The agent's task was read-only preflight evidence per master plan section 7, from
`bootstrap/missions/hq-preflight-001.md`: confirm remote identity and working directory,
report dirty state, report actual `git rev-parse HEAD`, and state whether HEAD equals the
assigned base. It was told explicitly to change nothing, push nothing, and report a
mismatch honestly rather than correcting it.

### The stale-checkout test result

The run reached `FINISHED` in 30 487 ms. Verbatim result (**reported** by the agent):

```
## 1. Remote identity

**`pwd` output:**
/workspace

**`git remote -v` output:**
(no output)

## 2. Dirty state

**`git status --porcelain` output:**
(no output)

The working tree is clean.

## 3. Actual HEAD

**`git rev-parse HEAD` output:**
9ddad27bc056e1715118dda8b04962108659d31b

## 4. Base comparison

Actual HEAD equals the assigned base commit 9ddad27bc056e1715118dda8b04962108659d31b.

**MATCH**
```

**HEAD matched the pinned base commit.** Commit pinning via `repos[0].startingRef` works:
an agent launched at an explicit 40-character SHA started on exactly that commit
(**supported** at the launch end, **reported** at the agent end).

Two qualifications, both honest limits on that conclusion:

- This was a **match**, so the test exercised the happy path. It did not demonstrate what
  happens when the runtime *does* supply a stale checkout; that branch of plan section 7
  remains **unverified**.
- The barber tip was resolved seconds before launch and `main` was unchanged afterwards, so
  a stale checkout was unlikely to arise in this particular window.

### Plan section 7 step 1 is not satisfiable as written

**supported**, and a finding worth acting on: the worker reported `pwd` as `/workspace` and
`git remote -v` as **empty**. The cloud runtime hands the agent a checkout with no git
remote configured. Plan section 7 step 1 asks every worker to "confirm remote repository
identity" — from inside the runtime, a worker **cannot** do that with `git remote -v`. The
plan should either drop that step or restate it as "confirm the assigned repository from
the task contract and confirm HEAD", which is what is actually verifiable.

### Nothing was written to the barber repository

**supported.** `dispatch result` reported one branch entry:

```json
{ "repoUrl": "github.com/Roberto-Madrid/dexter-barber",
  "branch": "cursor/hq-bootstrap-preflight-task-hq-preflight-001-69d8" }
```

That branch **does not exist on the remote**. `git ls-remote ... 'refs/heads/cursor/*'`
returned only two pre-existing branches (`cursor/barber-repo-rename-d763`,
`cursor/dexter-os-m001-d763`), and `refs/heads/main` was still
`9ddad27bc056e1715118dda8b04962108659d31b` after the run.

So a non-empty `git.branches` reports the branch name **assigned** to the agent, not a
branch that was pushed. Treating it as proof of a push would be wrong; `result` now says so
in a `branchesMeaning` field.

## 3. Result retrieval and follow-up

Exactly **one** follow-up was sent, and only after `status` showed the agent `IDLE`
(**supported**). Prompt: `bootstrap/missions/hq-preflight-001-followup.md`, asking for the
committer date and subject of HEAD, with the read-only constraints repeated.

| Field | Value |
| --- | --- |
| Follow-up run id | `run-683a8d33-85bd-4831-96c9-a9fe14ced912` |
| State on submit | `CREATING` → mapped to `queued` |
| Terminal state | `FINISHED`, 6 571 ms |

Verbatim result (**reported**):

```
1. **Committer date** (`git log -1 --format=%cI HEAD`):
2026-09-19T04:08:58+00:00

2. **Subject line** (`git log -1 --format=%s HEAD`):
Merge branch 'cursor/barber-repo-rename-d763' into main
```

The subject is consistent with the pre-existing remote branch `cursor/barber-repo-rename-d763`
observed independently by HQ (**supported**), which corroborates that the agent read the
real commit rather than inventing an answer. HQ did not separately re-read the commit
object, so the date and subject themselves stay **reported**.

No second follow-up was sent. The agent was never busy when a follow-up was submitted, so
the `409 agent_busy` path remains **unverified** against the live API (it is covered by
tests against mocks).

## 4. Cost — the concrete budget answer

`dispatch usage --task-id hq-preflight-001` (**supported**):

| Scope | `rawCostCents` | `chargedCents` |
| --- | --- | --- |
| **Agent total** | **14.2628** | **14.2628** |
| Run `run-6f7f0123-…` (preflight) | 11.1379 | 11.1379 |
| Run `run-683a8d33-…` (follow-up) | 3.1249 | 3.1249 |

Tokens for the agent: 19 858 input, 786 output, 0 cache-write, 142 528 cache-read,
163 172 total.

What this means for the owner's budget question:

- **supported** — one bounded, read-only, two-run agent on `composer-2.5` cost
  **14.2628 cents (~US$0.14)** in total.
- **supported** — `chargedCents` equals `rawCostCents` here. The charge was **not** zeroed
  out, so this work was billed rather than absorbed silently.
- **unavailable** — whether that charge draws down included allowance or becomes paid
  overage is not exposed. `GET /v1/agents/{id}/usage` has no allowance field, and the
  client reports `allowanceRemaining.status: "unknown"` rather than guessing.
- **unavailable** — there is still no API-side spending cap. Budget discipline remains a
  platform-billing setting plus operational restraint, not something this client enforces.
- **supported** — the `cost` object is **undocumented**. It is absent from the published v1
  schema and was found only by reading a live response. It may change without notice.

Two agents were permitted for this task. **One** was created. The budget ceiling was not
reached.

## 5. Durable recovery

The durable record at `.dexter/dispatch/records/hq-preflight-001.json` holds the agent id,
the current run id, the agent URL, the mission, the repository, the pinned base commit, and
the last known run state (**supported**). The append-only journal
`.dexter/dispatch/journal.jsonl` holds all five lifecycle events, including the **first**
run id, which the record itself no longer carries because the follow-up overwrote `runId`.

Fresh-process proof (**supported**). Run with a stripped environment — no API key, no
inherited shell state, a new process:

```
env -i PATH=/usr/bin:/bin HOME=/tmp node tools/dispatch/bin/dispatch.js recover
```

```json
{
  "command": "recover", "ok": true, "offline": true, "count": 1,
  "needsReconciliation": [],
  "tasks": [{
    "taskId": "hq-preflight-001",
    "state": "launched",
    "agentId": "bc-82f15814-538b-4106-b939-fa1e7e7b0453",
    "runId": "run-683a8d33-85bd-4831-96c9-a9fe14ced912",
    "agentUrl": "https://cursor.com/agents/bc-82f15814-538b-4106-b939-fa1e7e7b0453",
    "repository": "https://github.com/Roberto-Madrid/dexter-barber",
    "expectedBaseCommit": "9ddad27bc056e1715118dda8b04962108659d31b",
    "lastKnownRunState": { "raw": "FINISHED", "state": "completed", "terminal": true }
  }]
}
```

The same command confirmed `DEXTER_CURSOR_API_KEY` was **not** present in that process's
environment, so recovery is genuinely offline and credential-free.

`.dexter/dispatch/` is **committed on this branch**. The client README previously advised
gitignoring it; that advice is correct for a consumer that does not need cross-session
recovery and wrong for HQ, where an agent id that lives only on one session's disk is
worthless. The README and `dispatch_records.committed` in the policy now say so explicitly.

### Deliberately not proved here

The fresh-HQ-session recovery proof is **not** attempted in this document. A session that
already knows the agent id cannot honestly test whether the committed records are
sufficient to find it. That proof belongs to a worker with no access to this conversation.

For that worker, everything needed is on this branch:

1. Check out `bootstrap/live-proofs`.
2. From the repository root, run `node tools/dispatch/bin/dispatch.js recover`.
3. Expect exactly one task, `hq-preflight-001`, resolving to agent
   `bc-82f15814-538b-4106-b939-fa1e7e7b0453`.
4. With `DEXTER_CURSOR_API_KEY` attached, `status`, `result` and `usage --task-id
   hq-preflight-001` should all resolve against the live API from those records alone.

## Client defects found and fixed

All four were found by live use and are fixed in `tools/dispatch/**` on this branch, each
with a regression test. The client had never made a live authenticated call before this
session, so none of these could have surfaced earlier.

**1. The client could not read HQ's policy file at all.** (`src/policy.js`)

The client documented and parsed a flat schema (`repositoryAllowlist`, `apiKeyEnv`,
`missions`) while `config/dispatch-policy.json` is authored in a nested governance form
(`repository_allowlist.entries[]`, `credentials.cursor_api_key_env`). Nothing errored: the
flat keys were simply absent, `repositoryAllowlist` fell back to `[]`, and `requirePolicy`
refused **every** launch. Fixed by deriving the flat contract from the canonical document
(`adaptCanonicalPolicy`) rather than duplicating it in the file.

A sub-defect in the first version of that fix, caught by its own test: `missions` exists in
both shapes, so letting the raw block win dropped each mission's `repository_ids`
restriction **silently** — a mission with no `repositories` key is treated as unrestricted.
Derived values now win.

**2. The concurrency limit was unsatisfiable by construction.** (`src/commands/launch.js`)

`countActiveAgents` counted every ACTIVE agent returned by `GET /v1/agents`. That endpoint
returns **all 21** of the key owner's agents, including this HQ session and unrelated
projects. The first live launch was refused with `2/2 dispatch slots already in use`, where
both "slots" were HQ's own session workers. Since HQ is always ACTIVE while dispatching,
this was a permanent deadlock. Only agents carrying the client's `[task:<id>]` name marker
now consume a slot; the account-wide count is still reported for transparency.

**3. Cost was reported as unavailable when the API returns it.** (`src/commands/usage.js`)

`usage` hard-coded `cost: { status: "unknown", reason: "not_exposed_by_api" }`. The live
response carries `cost: { rawCostCents, chargedCents }`. Now read through when present,
labelled `reported` with its source field, and still `unknown` when absent — never
estimated from tokens. Allowance genuinely remains unavailable.

**4. Generated branch names were redacted as secrets.** (`src/redact.js`)

`cursor/hq-bootstrap-preflight-task-hq-preflight-001-69d8` is long, mixed-case and contains
digits, so the unprefixed high-entropy heuristic masked it to `cursor/[REDACTED]`. That
protected nothing and destroyed the operator's ability to find the branch. Identifier-valued
keys (`branch`, `url`, `ref`, `prUrl`, …) now skip that heuristic while known credential
shapes, `Authorization` headers and registered literals are still masked.

## Summary of what remains unproven

| Item | Label | Why |
| --- | --- | --- |
| Stale-checkout correction path | unverified | The live run matched its base, so the mismatch branch never executed. |
| Live `409 agent_busy` handling | unverified | The agent was IDLE whenever a follow-up was sent. Covered against mocks only. |
| Effective model actually used | unavailable | No documented v1 response returns a resolved model. |
| Remaining included allowance | unavailable | No v1 endpoint exposes allowance or a spending cap. |
| Fresh-HQ-session recovery | not attempted here | Deliberately left to a worker with no access to this conversation. |
| Cancel against a live run | unverified | Cancelling would have destroyed the evidence, and a second agent was not authorised. |
