# Handoff

Entry point for a fresh HQ session. Read `AGENTS.md`, `portfolio.json`, the active
mission state, this file, `config/dispatch-policy.json`, then run `dispatch recover`.
Trust recover over this file if they disagree.

**Written:** 2026-10-02T22:36:00Z

## Where things stand

HQ bootstrap is **merged to `main`** (`631b40b` and later). BARBER-RECOVERY is
**in flight**, not merely prepared. Combined work is draft
[PR #6](https://github.com/Roberto-Madrid/dexter-barber/pull/6) on
`cursor/barber-integration` @ `7e516a5`. Nothing is merged to `dexter-barber`
`main` (`9ddad27`) and nothing is deployed.

To run HQ on a laptop instead of in the cloud, follow `docs/LOCAL_BOOT.md`.

## Open owner decisions

1. Authorize `supabase/migrations/20260919094500_cancel_notification.sql`. Until
   applied, customer cancellations succeed and notify nobody.
2. Mark PR #6 ready, merge it, or leave it draft. PRs #4 and #5 are absorbed by #6.
3. Accept the slightly-lighter "Later visits" hint (`#86868b` vs `#6e6e73`) in
   light mode, or revert that token.

## Live facts that override older files

- Opus monthly limit is exhausted until 2026-10-11. Do not request `claude-opus-5`.
- Portrait is not locked in a Safari tab. CSS overlay + manifest only.
- Model ladder is in `config/dispatch-policy.json` and `.cursor/skills/dexter-cost`.
- Native launches bypass the ladder and record no cost. Prefer `tools/dispatch`
  for cloud workers so `usage` can report cents.
- `DEXTER_CURSOR_API_KEY` is attached to environment
  `16a2c703-b3e1-11f1-bb68-864e54d14197` and authenticates.
- Intended third repo: `https://github.com/Roberto-Madrid/dexter-workers`
  (private, HQ dispatch target, not the product). GitHub create from a
  worker failed: `GraphQL: Resource not accessible by integration
  (createRepository)`. Owner must create that private repo on GitHub, then
  add it to the **existing** Cursor environment
  `16a2c703-b3e1-11f1-bb68-864e54d14197`. Do not recreate the environment.

## Do not

Do not start a new mission, merge, deploy, or apply the migration unless the
owner says so in this session. Do not touch Vercel
`prj_yFeb9XnErOYVXO3SSu4IfYBTu7JZ` or Supabase `uzmvhoejpqhgsffpqdnf`.
