# HQ capabilities record

Written by HQ on 2026-09-19 while integrating the bootstrap branches. Every line carries
a label:

- **supported** — verified first-hand during bootstrap, with evidence named.
- **reported** — observed by someone else; the source is cited.
- **unverified** — plausible but not tested here.
- **unavailable** — confirmed absent or not exposed.

Documentation proving a feature exists is never grounds for **supported**. Only an
observation against this account is.

## Authentication and account

| Capability | Label | Evidence |
| --- | --- | --- |
| Cursor API key reaches agent runs | supported | `DEXTER_CURSOR_API_KEY` present in run `bc-a629fd9e-32e5-52fe-8a42-01fa24e93be5`, created after the owner attached it |
| Key authenticates | supported | `GET /v1/me` HTTP 200; `bootstrap/evidence/live-api-verification.md` |
| Key is user-scoped, not a service account | supported | `/v1/me` resolves to the owner's individual account; usage bills to their plan |
| Secrets propagate to runs created *before* attachment | unavailable | The coordinator run predates attachment and never received it. Live calls must be delegated to a newer run. |
| Repository discovery | supported | `GET /v1/repositories` returned 9 repos including both `dexter-barber` and `dexter-hq` |
| Model discovery | supported | `GET /v1/models` returned 38 IDs, recorded verbatim in `config/dispatch-policy.json` |

## Dispatch

| Capability | Label | Evidence |
| --- | --- | --- |
| Cross-repository dispatch from HQ to the product repo | supported | Agent `bc-82f15814-538b-4106-b939-fa1e7e7b0453` launched against `dexter-barber` from HQ |
| Launch pinned to an exact base commit | supported | Pinned `9ddad27bc056e1715118dda8b04962108659d31b`; the agent reported that exact HEAD |
| Worker preflight detects a stale checkout | unverified | The one probe matched its base, so only the happy path ran. The *correction* path of plan section 7 is untested. |
| Result retrieval | supported | `bootstrap/evidence/live-dispatch-proofs.md` |
| Bounded follow-up | supported | Two separate follow-ups across two sessions, each sent only after status showed `IDLE` |
| Live `409 agent_busy` handling | unverified | Mock-tested only; the agent was never busy when followed up |
| Cancelling a live run | unverified | Not attempted; cancelling would have destroyed the evidence |
| Client-supplied `agentId` idempotency | reported | Documented `409 agent_id_conflict`; mock-tested, not provoked live |

## Continuity

| Capability | Label | Evidence |
| --- | --- | --- |
| Durable records survive the process | supported | `recover` replayed the agent ID from a fresh clone under `env -i` with no key and no network |
| A fresh session with no prior conversation can resume | supported | Run `bc-eb15b322-d3fe-599b-83e6-71136c95f634` recovered the agent from `.dexter/dispatch/records/` and completed a live follow-up |
| Human-readable handoff stays accurate on its own | unavailable | It did not. `handoff.md` still claimed nothing had been dispatched after an agent existed. Fixed, and `AGENTS.md` now makes `recover` authoritative over prose. |
| Continuous unattended HQ operation | unavailable | No verified wake-up mechanism. Do not describe HQ as continuously staffed. |

## Isolation and integration

| Capability | Label | Evidence |
| --- | --- | --- |
| Concurrent isolated writers on separate VMs | supported | Two workers wrote 17 and 35 files on separate branches with no shared state |
| Integration without loss | supported | All 52 files byte-identical to their source branches after merge; tests pass at the integration commit |
| Contracts fit across isolated writers | supported | The client coded defensively against a policy file it was forbidden to create; on the combined tree it reads that real file and resolves the allowlist from it |
| Separate VMs isolate the hosted database | unavailable | They do not. Separate disks and branches do not isolate a shared Supabase project. Use isolated development data or serialize database changes. |

## Cost and spending

| Capability | Label | Evidence |
| --- | --- | --- |
| Per-agent cost after the fact | supported | `GET /v1/agents/{id}/usage` returns an undocumented `cost` object; probe agent totalled 17.4139 charged cents across 3 runs |
| `chargedCents` distinguishes included from on-demand usage | unverified | The field exists but its billing semantics are not documented |
| Remaining allowance or balance | unavailable | `/v1/usage`, `/v1/me/usage`, `/v1/billing` all 404 |
| Hard spending cap enforceable from HQ | unavailable | None exists. Only the owner's Spending dashboard can disable on-demand usage. Concurrency limits are not dollar caps. |
| Effective model telemetry | unavailable | Not returned by v1. `originalModelName` is the requested name; a null effective model always means unknown. |

## Corrections to the master plan

These postdate revision 2.1 and override it where they conflict.

- The barber repository is `Roberto-Madrid/dexter-barber`, renamed from `Dexter`. The
  old name only redirects. **supported.**
- Plan section 7 step 1, "confirm remote repository identity", is impossible from inside
  the cloud runtime: a dispatched worker sees `pwd` as `/workspace` and an empty
  `git remote -v`. Confirm the assigned repository from the task contract plus `HEAD`
  instead. **supported.**
- A non-empty `git.branches` entry on a finished run is not evidence of a push.
  **supported.**
- The cloud environment already existed and covers both repositories; it did not need
  creating. **supported.**
- No machine-readable OpenAPI document is reachable, so run-status values come from
  prose and examples. Anything unrecognised maps to `unknown`. **supported.**

## Pre-existing assets, not created during bootstrap

In `dexter-barber`: `.cursor/environment.json`, `.cursor/dispatch.json`,
`.cursor/agents/builder.md` and `verifier.md`, and five `.cursor/skills/dexter-*` skills.
**reported**, from a read-only inventory.

The presence of `.cursor/agents/*.md` definition files is **not** evidence that any
worker was ever invoked. Delegation is proven by recorded agent IDs and returned results,
which is what this document does.
