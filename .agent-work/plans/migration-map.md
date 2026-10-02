# Migration map — G0

Base: `main` @ `13a9c298e2d4fe86c94e531dc117c2d913ab629d`. Narrative and command output: `docs/AUDIT.md`. Actions marked proposed are not executed; OA-1 approves them.

| Current path | What it is | Works today | V5 target path | Action | Risk |
| --- | --- | --- | --- | --- | --- |
| `AGENTS.md` | v2 HQ charter (rewritten at the root in G0). | Readable. Previous text is at `legacy/pre-v5/AGENTS.md`. | `AGENTS.md` (Appendix C.1) | adapt (done) | v2 delegation rules no longer sit at the root. |
| `bootstrap/` | 2026-09-19 capability and API evidence. | Readable. No re-run command. Live calls not repeated in G0. | `legacy/pre-v5/bootstrap/` | move to `legacy/` (proposed, not executed) | Evidence loss if someone deletes instead of moving. |
| `config/dispatch-policy.json` | Dispatch allowlist and API policy. | Canonical-policy tests passed inside `npm test` (72/72). | Stays until dispatch is retired. Role sheet is a new file, `gateway/role-sheet.yaml`. | keep | Branch patterns omit `v5` and `v5-*`. |
| `.cursor/skills/` | Four v2 skills. | Readable. No runner, not executed. | Keep beside `.cursor/rules/dexter.mdc`. | keep | Skills describe v2, not V5 personas. |
| `.dexter/dispatch/` | Journal and preflight record. | `dispatch recover` exit 0, 1 record, offline. | Keep until G2 Postgres. | keep | History, not a live queue. |
| `docs/LOCAL_BOOT.md` | Laptop boot brief. | Readable. Not executed (needs the owner key on a laptop). | `docs/LOCAL_BOOT.md` | keep | Describes v2 dispatch. |
| `handoff.md` | v2 session handoff (2026-10-02). | Readable. Not edited. | V5 handoffs: `.agent-work/handoffs/`. | keep | Two handoff files until OA-1. |
| `missions/BARBER-RECOVERY/` | Prepared recovery mission. | `state.json` parses. Not activated by this audit. | `missions/BARBER-RECOVERY/` | keep | Do not activate, and do not touch barber hosting. |
| `portfolio.json` | Status projection. | JSON parses. Workers row is stale: the private repo exists. | `portfolio.json` | keep | Stale workers status. Barber Vercel and Supabase ids must stay unchanged. |
| `README.md` | Intro. Bootstrap section is stale (client is installed). | Readable. Tests prove the client exists. Not rewritten. | `README.md` in G7 | keep until G7 | Readers are told the client is missing. |
| `reference/Dexter_HQ_Plan_v2.1.md` | v2.1 reference plan. | Readable. Not loaded into the V5 spec copy. | same path | keep | Must stay out of automatic instruction discovery. |
| `roles/` | v2 role briefs. | Readable. No runner. | `personas/`, `crews/` later | keep | Quarantine only after V5 personas exist and OA-1 says so. |
| `tools/dispatch/` | Cursor Cloud Agents CLI, zero dependencies. | No install step. No build script. `npm test` 72 pass, 0 fail. `dispatch help` exit 0. | `tools/dispatch/` until `adapters/cursor-cloud.ts` | keep | This is the working client. Do not break it while adding V5. |

## New in G0 (no prior path)

| Path | V5 role |
| --- | --- |
| `DEXTER_V5_ACTION_PLAN.md` | Resume file for any tool |
| `docs/MASTER_PLAN_V5.md` | Appendix A, verbatim |
| `docs/CONSTITUTION.md` | A.4 |
| `docs/adr/0001-v5-adoption.md`, `docs/adr/0002-v5-1-pools-role-sheet-ceo.md` | §11 |
| `docs/THIRD_PARTY.md`, `checklists/lazy-ladder.md`, `checklists/principles.md` | Appendix D, original wording |
| `.env.example` | Names only (C.6) |
| `.github/pull_request_template.md` | C.5 |
| `.gitignore` | Ignores `.agent-work/tmp/`, env files, `node_modules/` |
| `.agent-work/` | Ledger, tasks, handoffs, lanes, evidence |
| `CLAUDE.md` | `@AGENTS.md` only |
| `.cursor/rules/dexter.mdc` | Always applied; points at `AGENTS.md` |
| `legacy/pre-v5/AGENTS.md` | Preserved charter. Not a deletion. |

## Not in this repo

No database schema, no migrations, no deploy config. Env name in running code today: `DEXTER_CURSOR_API_KEY`. External services and the barber Vercel/Supabase identifiers are listed in `docs/AUDIT.md`.
