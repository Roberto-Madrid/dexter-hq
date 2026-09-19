# Handoff

Entry point for a fresh HQ session. Read `AGENTS.md`, `portfolio.json`, the active
mission state, this file, then `config/dispatch-policy.json`. Nothing else by default.

**Written:** 2026-09-19T04:36:00Z by the `bootstrap/hq-files` worker
**HQ base commit for this work:** `53fac961c485b8ff6799b838a062f50905af0682`

## Where things stand

Bootstrap is **partial**. HQ operating files are being written; no dispatch capability has
been proven. Do not proceed into application work while claiming cross-project autonomy.

BARBER-RECOVERY is **prepared, not dispatched**. It is not activated. Activation requires
the explicit owner prompt in master plan section 20.

Per-item bootstrap acceptance status, with evidence, is in `bootstrap/acceptance.md`.

## Owner-confirmed corrections that override the master plan

The master plan (`reference/Dexter_HQ_Plan_v2.1.md`, revision 2.1) is authoritative for
intent, but these facts postdate it. Where they conflict, these win:

| Plan says | Correct current value |
| --- | --- |
| Barber repo is `Roberto-Madrid/Dexter` (sections 4, 16) | `Roberto-Madrid/dexter-barber`. Renamed; GitHub still redirects the old name. The old name is a historical alias only. |
| API credentials were absent (section 2) | `DEXTER_CURSOR_API_KEY` is configured by the owner but is **not injected into agent runs**. Configured-but-not-reaching-runs, not missing-entirely. Do not ask the owner to create another key. |
| Cloud environment setup needs establishing | The environment already exists, is repo-file managed from `dexter-barber/.cursor/environment.json`, and already includes both repositories. Do not propose recreating it. |

## The one blocker that gates everything

`DEXTER_CURSOR_API_KEY` does not reach agent runs. Verified absent in run
`bc-7c2ba0a5-660e-56c3-a728-5af2a12816c8` on 2026-09-19 without reading its value.

Consequences: no API authentication check, no repository discovery, no **model
discovery** (so every model ID in `config/dispatch-policy.json` is `null` and
`"discovered": false`), and no live cross-repository dispatch.

**Owner action:** attach the existing `DEXTER_CURSOR_API_KEY` secret to cloud environment
`16a2c703-b3e1-11f1-bb68-864e54d14197` so it is injected into agent runs. Never send the
value in chat.

Unblocked work meanwhile: local dispatch-client implementation and mocked tests.

## Next actions, in order

1. Owner attaches the secret so it reaches agent runs.
2. Run read-only authentication, repository, and model discovery. Populate the
   `model_policy.discovery` block and set `"discovered": true` with a timestamp. Never
   seed model IDs from memory or from the plan.
3. Confirm applicable billing and available spending controls. `paid_overage_enabled`
   stays `false`.
4. Complete and test `tools/dispatch/**` (owned by a separate worker on a separate branch).
5. Prove the remaining live capabilities in plan section 6E.
6. Integrate the bootstrap branches to `main`, then publish the bootstrap report.
7. Only after bootstrap acceptance: activate BARBER-RECOVERY.

## In-flight work at the time of writing

Three bootstrap workers on separate branches; an integrator combines them later. No PRs
were opened and nothing was merged to `main`.

| Branch | Owner | Paths |
| --- | --- | --- |
| `bootstrap/hq-files` | this worker | `AGENTS.md`, `portfolio.json`, `roles/`, `config/dispatch-policy.json`, `handoff.md`, `missions/BARBER-RECOVERY/`, `bootstrap/acceptance.md` |
| separate branch | second worker | `tools/dispatch/**` |
| separate branch | third worker | `bootstrap/capabilities.md` |

No live agent IDs or run IDs are pending retrieval; nothing was dispatched.

## Standing reminders

- Do not load `reference/Dexter_HQ_Plan_v2.1.md` into every prompt. Reference-only, and
  excluded from automatic instruction discovery.
- Do not touch the barber application, Vercel project `prj_yFeb9XnErOYVXO3SSu4IfYBTu7JZ`,
  or Supabase project `uzmvhoejpqhgsffpqdnf`.
- Two concurrent implementation workers by default.
- No secret values in any file, ever.
- Update this file and the active mission state before the session ends.
