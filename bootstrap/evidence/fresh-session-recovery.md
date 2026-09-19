# Fresh-session recovery proof

The proof deliberately left open by `bootstrap/evidence/live-dispatch-proofs.md`
("Deliberately not proved here"): whether the records committed to
`bootstrap/live-proofs` are sufficient for an HQ session with **no conversation history**
to recover an in-flight agent and resume operations against it.

This session had no prior context. It was given the repository, the branch name, and the
instruction to recover the agent from the durable records without being told its id.

Every claim below is labelled:

- **supported** — this session ran the command and saw the output quoted here.
- **reported** — the dispatched agent stated it; correct by its own account.
- **unverified** — believed but not demonstrated here.
- **unavailable** — the platform does not expose it.

## Provenance

| Item | Value | Label |
| --- | --- | --- |
| Branch | `bootstrap/fresh-recovery` | supported |
| Cut from | `origin/bootstrap/live-proofs` at `87eb37618fa369de70da07f6b89456deaba52796` | supported |
| Node runtime | v22.14.0 | supported |
| `DEXTER_CURSOR_API_KEY` | present in this run's environment; presence tested via `-n "${VAR:-}"`, value never read, printed, logged, or passed as an argument | supported |
| Barber repository | not modified; `git status --short --branch` returned only `## main...origin/main` before and after all work, and HEAD stayed `9ddad27bc056e1715118dda8b04962108659d31b` | supported |
| Agents created | none | supported |

## 1. Orientation from `AGENTS.md` and `handoff.md`

**supported.** The documented startup read order in `AGENTS.md` is: `AGENTS.md` →
`portfolio.json` → the active mission `state.json` → `handoff.md` →
`config/dispatch-policy.json`, and "nothing else by default". Following exactly that order
was enough to orient: identity, the delegation prohibition, the status vocabulary, the
credential rules, the repository allowlist, and the boundary around the barber application
were all clear without outside help.

It was **not** sufficient on the one fact this exercise turned on. See
[section 6](#6-the-gap-in-hqs-durable-records).

## 2. Agent id recovered from the durable records

**supported.** Recovered without being told, and without the originating conversation.

| Item | Value |
| --- | --- |
| **Recovered agent id** | **`bc-82f15814-538b-4106-b939-fa1e7e7b0453`** |
| **Recovered from** | **`.dexter/dispatch/records/hq-preflight-001.json`** (field `agentId`, equal to `clientAgentId`) |
| Corroborating record | `.dexter/dispatch/journal.jsonl`, all five pre-existing lifecycle events |
| Task id | `hq-preflight-001` |
| Mission | `hq-bootstrap-preflight` |
| Target repository | `https://github.com/Roberto-Madrid/dexter-barber` |
| Pinned base commit | `9ddad27bc056e1715118dda8b04962108659d31b` |

How the record directory was found from the prescribed read order, **supported**: step 5,
`config/dispatch-policy.json`, carries `dispatch_records.directory: ".dexter/dispatch"`
together with `committed: true` and the instruction to run `dispatch recover` from the
repository root. Nothing in steps 1–4 points there. The chain holds, but only at the last
step of the read order, and only after step 4 has actively told you the opposite.

`bootstrap/evidence/live-dispatch-proofs.md` also names the agent id in full, but that file
is outside the startup read order and was read only after the id had already been recovered
from the durable record.

### Offline recovery, fresh process, no credential

**supported.** Re-ran the stripped-environment proof from `live-dispatch-proofs.md`, on this
branch:

```
env -i PATH=/exec-daemon:/usr/bin:/bin HOME=/tmp node tools/dispatch/bin/dispatch.js recover
```

```json
{
  "command": "recover", "ok": true, "offline": true, "count": 1,
  "needsReconciliation": [],
  "tasks": [{
    "taskId": "hq-preflight-001",
    "state": "launched",
    "clientAgentId": "bc-82f15814-538b-4106-b939-fa1e7e7b0453",
    "agentId": "bc-82f15814-538b-4106-b939-fa1e7e7b0453",
    "runId": "run-683a8d33-85bd-4831-96c9-a9fe14ced912",
    "agentUrl": "https://cursor.com/agents/bc-82f15814-538b-4106-b939-fa1e7e7b0453",
    "missionId": "hq-bootstrap-preflight",
    "repository": "https://github.com/Roberto-Madrid/dexter-barber",
    "expectedBaseCommit": "9ddad27bc056e1715118dda8b04962108659d31b",
    "lastKnownRunState": { "raw": "FINISHED", "state": "completed", "terminal": true },
    "refreshed": false
  }]
}
```

The `PATH` differs from the earlier proof only because `node` lives at `/exec-daemon/node`
in this runtime rather than `/usr/bin`. The published command in `live-dispatch-proofs.md`
(`PATH=/usr/bin:/bin`) fails with `env: 'node': No such file or directory` here
(**supported**) — a copy-paste hazard in that document, not a defect in the client.

## 3. Live status from the recovered records alone

**supported.** `dispatch status --task-id hq-preflight-001`, before any follow-up:

| Field | Value |
| --- | --- |
| Agent status | `IDLE` → `acceptsFollowUp: true` |
| Agent name | `hq-bootstrap-preflight [task:hq-preflight-001]` |
| Latest run at that moment | `run-683a8d33-85bd-4831-96c9-a9fe14ced912`, `FINISHED` |
| Repos | `https://github.com/Roberto-Madrid/dexter-barber` |
| `autoCreatePR` | `false` |

The agent survived the session that created it and was reachable from the committed
records with no other input.

## 4. One follow-up, sent only to an IDLE agent

**supported.** The agent reported `IDLE` before submission, so the policy rule
`max_followups_per_agent_when_busy: 0` was never engaged. Exactly **one** follow-up was
sent in this session.

Prompt: `bootstrap/missions/hq-preflight-001-fu2.md` — one question, read-only constraints
repeated, asking for the number of files changed in the HEAD commit per
`git show --stat HEAD`.

| Field | Value |
| --- | --- |
| Follow-up run id | `run-96ba5f82-dc6a-44a6-8a2e-d3eeea5aa1ba` |
| State on submit | `CREATING` → mapped to `queued` |
| Terminal state | `FINISHED`, 7 086 ms, reached after 4 polls |

Verbatim result (**reported**):

```
1. **Number of files changed** (`git show --stat HEAD` summary line):

 6 files changed, 147 insertions(+), 3 deletions(-)
```

### Independently corroborated

**supported**, and this one does not have to rest on the agent's word. A read-only
`git show --stat 9ddad27bc056e1715118dda8b04962108659d31b` in HQ's own local barber
checkout returned the identical summary line:

```
 .cursor/dispatch.json        |  24 ++++++++++
 README.md                    |   8 +++-
 docs/dexter/context-index.md |   1 +
 docs/product/architecture.md |   2 +-
 package.json                 |   4 +-
 scripts/dexter-dispatch.ts   | 111 +++++++++++++++++++++++++++++++++++++++++++
 6 files changed, 147 insertions(+), 3 deletions(-)
```

So the file count is **supported**, not merely reported. The agent read the real commit.
Nothing was written: the barber working tree was clean before and after, and no `cursor/*`
branch was pushed by this run.

`409 agent_busy` against the live API remains **unverified** — as in the previous session,
the agent was IDLE whenever a follow-up was submitted.

## 5. Cost

**supported.** `dispatch usage --task-id hq-preflight-001`, after this session's follow-up:

| Scope | `rawCostCents` | `chargedCents` |
| --- | --- | --- |
| **Agent total (3 runs)** | **17.4139** | **17.4139** |
| `run-6f7f0123-…` (original preflight) | 11.1379 | 11.1379 |
| `run-683a8d33-…` (first follow-up) | 3.1249 | 3.1249 |
| `run-96ba5f82-…` (this session's follow-up) | 3.1511 | 3.1511 |

Agent tokens: 20 382 input, 927 output, 0 cache-write, 198 176 cache-read, 219 485 total.

- **supported** — this session's single read-only follow-up cost **3.1511 cents**, bringing
  the agent's lifetime total to **17.4139 cents (~US$0.17)**. The 14.2628 cents recorded in
  `live-dispatch-proofs.md` plus 3.1511 equals 17.4139 exactly, so the `cost` field
  accumulates per agent rather than resetting.
- **supported** — `chargedCents` still equals `rawCostCents`; the work was billed.
- **unavailable** — remaining allowance. `allowanceRemaining.status` is `unknown`,
  `reason: not_exposed_by_api`.
- **unavailable** — effective model. `effectiveModel.status` is `unknown`,
  `reason: not_exposed_by_api`. The requested model was `composer-2.5`.
- **supported** — the `cost` object is still undocumented; the client labels it
  `reason: "undocumented_field_present_in_live_response"` rather than treating it as schema.

## 6. The gap in HQ's durable records

This is the finding that matters, and it is **supported**.

**`handoff.md` is stale and, on the decisive point, actively misleading.** It is step 4 of
the mandatory startup read order, and it states:

> No live agent IDs or run IDs are pending retrieval; nothing was dispatched.

and

> Bootstrap is **partial**. HQ operating files are being written; no dispatch capability has
> been proven.

and names the unreached API key as "the one blocker that gates everything".

All three were true when written at `2026-09-19T04:36:00Z`. All three were false by
`2026-09-19T04:59:41Z`, when this very branch launched agent
`bc-82f15814-538b-4106-b939-fa1e7e7b0453` against the barber repository and committed the
records proving it. The branch tip commit message is literally "record live dispatch proofs
and commit durable dispatch records". `handoff.md` was never updated.

`AGENTS.md` requires the opposite: *"Before ending a session, update the mission
`state.json` and `handoff.md`."* The live-proofs session updated neither.

The same staleness runs through the other projection files (**supported**):

| File | Says | Actually true on this branch |
| --- | --- | --- |
| `handoff.md` | "nothing was dispatched"; API key is the gating blocker | One agent dispatched, three runs, key attached and authenticating |
| `portfolio.json` | `credentials.cursor_api_key.state: "configured-but-not-reaching-runs"`, `api_authentication: "not_tested"` | Key reaches runs; `auth-check` returned `authenticated: true` |
| `portfolio.json` | `checks.dispatch_client_authenticates: "blocked"`, `cross_repository_dispatch_proven: "blocked"` | Both demonstrated in `bootstrap/evidence/live-dispatch-proofs.md` |
| `missions/BARBER-RECOVERY/state.json` | blocker `api-key-not-reaching-runs` still open | No longer accurate |

Note that `config/dispatch-policy.json` **was** updated by that session — `model_policy.discovery.discovered`
is `true` with 38 live model ids. So the session updated the file it was actively writing and
skipped the two projection files `AGENTS.md` designates as the handoff surface. The failure
is not that durability was unimplemented; it is that durability was implemented in the
dispatch client and not applied to the human-readable state files.

### What that cost this session, concretely

**supported.** Recovery still succeeded, and succeeded from the prescribed read order —
but only because `config/dispatch-policy.json` (step 5) contradicted `handoff.md` (step 4)
and pointed at `.dexter/dispatch`. A session that had stopped reading at step 4, exactly as
`handoff.md`'s own "Next actions" list invites (item 1 is "Owner attaches the secret", which
has already happened), would have concluded that no agent existed, that dispatch was
blocked, and that the correct action was to wait on the owner. That conclusion would have
been wrong, and nothing in steps 1–4 would have contradicted it.

The workaround was to distrust step 4 and keep reading. That is not a property a fresh
session should have to supply on its own.

### Recommended corrections

Not applied here — this branch is evidence only, and `handoff.md`, `portfolio.json` and
`missions/BARBER-RECOVERY/state.json` are owned by the integration path.

1. Rewrite `handoff.md` to record that dispatch is proven, that the API key reaches runs,
   and that agent `bc-82f15814-538b-4106-b939-fa1e7e7b0453` exists, is IDLE, and is
   recoverable via `dispatch recover`.
2. Add `.dexter/dispatch/` to the `AGENTS.md` startup read order, or add an explicit
   "run `dispatch recover` before believing any narrative status file" step. The durable
   record should not be reachable only through a pointer inside step 5.
3. Correct the three stale fields in `portfolio.json` and the resolved blocker in
   `missions/BARBER-RECOVERY/state.json`.
4. Make the handoff update a checked item in `bootstrap/acceptance.md` rather than a
   standing reminder, since a standing reminder is exactly what was missed.

## 7. Second client defect found by live use

**supported**, and new — not among the four recorded in `live-dispatch-proofs.md`.

`assertNoSecretInArgv` in `tools/dispatch/src/validate.js` rejects any argument for which
`looksLikeSecret` is true. That heuristic returns true for a lowercase string of **48 or
more** characters containing a digit. A prompt-file path qualifies:

```
bootstrap/missions/hq-preflight-001-followup-2.md   (49 chars)
```

```json
{ "ok": false, "error": "ValidationError", "kind": "validation",
  "message": "Refusing to run: a command-line argument looks like a credential. Pass secrets via the environment only." }
```

The first session never hit this because its prompt path was 47 characters. The guard is
correct in intent and the failure is safe — it refuses rather than leaking — but it makes
the tool reject legitimate long file paths with a message that misdescribes the cause.

Worked around by renaming the prompt file to `bootstrap/missions/hq-preflight-001-fu2.md`
(42 chars), after which the follow-up succeeded. **No client code was changed on this
branch**; the fix belongs with a regression test, alongside the `IDENTIFIER_KEY` exemption
that already solves the same false positive for branch names in `src/redact.js`. The
natural fix is to exempt arguments that are values of path-valued options
(`--prompt-file`, `--policy`, `--records-dir`) or that resolve to an existing file.

## 8. Summary

| Question | Answer | Label |
| --- | --- | --- |
| Can a session with no history recover the agent id from committed records? | Yes — `bc-82f15814-538b-4106-b939-fa1e7e7b0453` from `.dexter/dispatch/records/hq-preflight-001.json` | supported |
| Does offline, credential-free recovery work in a fresh process? | Yes | supported |
| Can it reach the live agent from those records alone? | Yes — `status`, `followup`, `result`, `usage` all resolved | supported |
| Did the single follow-up succeed? | Yes — `run-96ba5f82-…`, FINISHED in 7 086 ms | supported |
| Was the agent's answer correct? | Yes — 6 files changed, 147 insertions, 3 deletions, matched independently | supported |
| Lifetime agent cost | 17.4139 cents charged | supported |
| Are the human-readable state files trustworthy for resumption? | **No** — `handoff.md`, `portfolio.json` and the BARBER-RECOVERY state were not updated after live dispatch | supported |
| Live `409 agent_busy` | Still not exercised | unverified |
| Remaining allowance / effective model | Not exposed by the API | unavailable |

**Verdict.** The *machine-readable* half of HQ's durability contract works exactly as
designed: `.dexter/dispatch/` is committed, self-describing, and sufficient on its own. The
*human-readable* half failed: the file `AGENTS.md` designates as the entry point for a
fresh session asserts that the thing this session just did was impossible. Recovery is
currently sufficient **for a session that reads all five startup files and trusts the
records over the narrative** — and not sufficient for one that takes `handoff.md` at its
word.
