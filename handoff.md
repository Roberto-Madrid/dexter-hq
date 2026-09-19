# Handoff

Entry point for a fresh HQ session. Read `AGENTS.md`, `portfolio.json`, the active
mission state, this file, `config/dispatch-policy.json`, then run `dispatch recover`
against the committed records in `.dexter/dispatch/`. Nothing else by default.

**Written:** 2026-09-19T05:15:00Z by HQ, integrating five bootstrap branches.
**HQ integration commit for this work:** see `bootstrap/integration`.

## Where things stand

Bootstrap is **substantially complete**. Live cross-repository dispatch, exact-commit
pinning, result retrieval, follow-up, durable recovery, and fresh-session recovery have
all been demonstrated against the live API with recorded IDs and costs. Per-item status
with evidence is in `bootstrap/acceptance.md` and `bootstrap/capabilities.md`.

BARBER-RECOVERY is **prepared, not dispatched**. Activation requires the explicit owner
prompt in master plan section 20. Do not start it on your own initiative.

## Live dispatch state

`DEXTER_CURSOR_API_KEY` is attached to cloud environment
`16a2c703-b3e1-11f1-bb68-864e54d14197` and authenticates (`/v1/me` HTTP 200). It is
user-scoped to the owner, not a service account, so usage bills to the owner's plan.
A secret reaches only runs created *after* it was attached; an older run will not have it
and must delegate live calls to a newer one.

One agent has been dispatched by HQ. It is a bootstrap probe, not a product mission:

| Field | Value |
| --- | --- |
| Agent | `bc-82f15814-538b-4106-b939-fa1e7e7b0453` |
| Task | `hq-preflight-001`, read-only preflight probe |
| Repository | `Roberto-Madrid/dexter-barber` |
| Pinned base | `9ddad27bc056e1715118dda8b04962108659d31b` |
| Reported HEAD | matched the pinned base |
| Runs | 3, all finished; last was a fresh-session follow-up |
| Lifetime cost | 17.4139 charged cents |
| Record | `.dexter/dispatch/records/hq-preflight-001.json` |

Nothing is in flight. This agent needs no further follow-up; it exists as evidence.
Recover it with `dispatch recover`, which works offline with no API key.

## Owner-confirmed corrections that override the master plan

The master plan (`reference/Dexter_HQ_Plan_v2.1.md`, revision 2.1) is authoritative for
intent, but these facts postdate it. Where they conflict, these win:

| Plan says | Correct current value |
| --- | --- |
| Barber repo is `Roberto-Madrid/Dexter` (sections 4, 16) | `Roberto-Madrid/dexter-barber`. Renamed; GitHub still redirects. The old name is a historical alias only. |
| API credentials were absent (section 2) | Attached and verified working. |
| Cloud environment setup needs establishing | Already exists, repo-file managed from `dexter-barber/.cursor/environment.json`, already covers both repositories. Do not recreate it. |
| Workers must "confirm remote repository identity" (section 7 step 1) | Impossible from inside the cloud runtime: a dispatched worker sees `pwd` as `/workspace` and an empty `git remote -v`. Confirm the assigned repository from the task contract plus `HEAD` instead. |

## Remaining limitations

- Allowance, remaining balance, and effective model are not exposed by the v1 API. Cost
  is available per agent via `usage` (`rawCostCents`, `chargedCents`) but only after the
  fact. No hard spending cap is enforceable from HQ; only the owner's Spending dashboard
  can disable on-demand usage. `paid_overage_enabled` stays `false`.
- Unproven and honest about it: the stale-checkout *correction* path (the one probe
  matched its base, so only the happy path ran), live `409 agent_busy` handling, and
  cancelling a live run.
- A non-empty `git.branches` entry on a finished run is **not** evidence of a push.

## Next actions, in order

1. Owner decides whether to merge `bootstrap/integration` into `main`. The policy sets
   `merge_to_protected: integrator_only_with_owner_authorization`, so do not merge
   unasked.
2. Owner checks the on-demand usage toggle at `cursor.com/dashboard/spending` if a hard
   overage guarantee is wanted.
3. Only on the owner's explicit instruction: activate BARBER-RECOVERY via master plan
   section 20, dispatching a project lead against the then-current verified tip of
   `dexter-barber`. Resolve that tip fresh; do not reuse `9ddad27`.

## Standing reminders

- Do not load `reference/Dexter_HQ_Plan_v2.1.md` into every prompt. Reference-only, and
  excluded from automatic instruction discovery.
- Do not touch the barber application, Vercel project `prj_yFeb9XnErOYVXO3SSu4IfYBTu7JZ`,
  or Supabase project `uzmvhoejpqhgsffpqdnf`.
- Two concurrent implementation workers by default.
- No secret values in any file, ever.
- Update this file, `portfolio.json`, and the active mission state before the session
  ends. A stale handoff already caused a fresh session to conclude that nothing had been
  dispatched when an agent existed; trust `.dexter/dispatch/` over any narrative.
