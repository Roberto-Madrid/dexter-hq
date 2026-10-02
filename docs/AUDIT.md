# Audit — dexter-hq at G0

Audited on `main` tip `13a9c298e2d4fe86c94e531dc117c2d913ab629d` (2026-10-02). Every top-level path is a row below. "Works today" cites a command that was run, or states that the path is documentation with no command. Empty cells are not allowed.

No path is proposed for deletion. Moves into `legacy/` beyond the charter copy below wait for OA-1. This audit executed one preserve-and-adapt: the previous root `AGENTS.md` was copied to `legacy/pre-v5/AGENTS.md` and the root file was rewritten. `git` will show that as a modification plus an addition, not a deletion.

## Top-level paths

| Path | What it is | Works today | V5 target path | Action | Risk |
| --- | --- | --- | --- | --- | --- |
| `AGENTS.md` | Short operating charter agents read on startup. | Present and readable. Previous text preserved at `legacy/pre-v5/AGENTS.md` (copy of `13a9c29`). Root file replaced in this story with Appendix C.1. | `AGENTS.md` | adapt (done) | A session that still expects the v2 delegation charter will not find it at the root. The copy remains. |
| `bootstrap/` | Bootstrap acceptance, capability record, task prompts, and live-API evidence from 2026-09-19. Eight markdown files. Not a test suite. | Readable records. `bootstrap/acceptance.md` itself says authentication was blocked in that run and later evidence says the key reached a later run. No bootstrap command exists to re-run. Not re-executed against live APIs in G0. | `legacy/pre-v5/bootstrap/` after OA-1 | move to `legacy/` (proposed, not executed) | Losing the evidence of what the live API actually returned. Do not delete. |
| `config/` | `dispatch-policy.json`: allowlist, Cursor API base, model discovery snapshot, concurrency, retry rules. | Loaded by the dispatch client. `npm test` in `tools/dispatch` passed the canonical-policy tests (72/72, `.agent-work/evidence/G0/dispatch-test.txt`). `node -e` JSON.parse succeeded. | `config/dispatch-policy.json` until a later story replaces dispatch. Role sheet will be `gateway/role-sheet.yaml` (G1/G2), additive. | keep | `allowed_branch_patterns` for HQ are `bootstrap/*`, `cursor/*`, `hq/*`. They do not include `v5` or `v5-*`. Not edited in G0 (this story does not own the file). A later dispatch onto a V5 branch needs an owner-approved policy edit. |
| `.cursor/` | Four skills: cost, draft-pr, i18n-visual, worker-preflight. No `rules/` directory before G0. | Skill files are readable instructions. This repo has no skill runner and no test that executes them. G0 adds `.cursor/rules/dexter.mdc` (always applied, points at `AGENTS.md`) and leaves the skills in place. | `.cursor/rules/dexter.mdc` plus the existing skills until personas replace them | keep | Skills still name the v2 workflow. They are not V5 personas. |
| `.dexter/` | Durable dispatch journal and one record, `records/hq-preflight-001.json`. | `node tools/dispatch/bin/dispatch.js recover` exited 0, offline, count 1, task `hq-preflight-001`, last known run state `completed` (`.agent-work/evidence/G0/dispatch-recover.txt`). Policy says the directory contains no secrets; the record keys are ids, urls, and states. | `.dexter/dispatch/` until V5 state moves to Postgres (G2). | keep | Recover replayed a finished preflight. It is history, not a live queue. |
| `docs/` | `LOCAL_BOOT.md` only, before G0. | The boot brief is readable. It was not executed: it asks the owner to export `DEXTER_CURSOR_API_KEY` on a laptop. G0 adds V5 docs beside it and does not rewrite the boot brief. | `docs/` (`MASTER_PLAN_V5.md`, `CONSTITUTION.md`, `AUDIT.md`, `THIRD_PARTY.md`, `adr/`) | adapt (V5 docs added; `LOCAL_BOOT.md` kept) | `LOCAL_BOOT.md` still describes v2 dispatch, not the V5 app. |
| `handoff.md` | v2 session handoff, written 2026-10-02T22:36:00Z. | Readable. Says HQ bootstrap is merged, BARBER-RECOVERY is in flight on dexter-barber PR 6, and names `DEXTER_CURSOR_API_KEY` as attached. No command. V5 handoff for this story is `.agent-work/handoffs/G0.md`. This file was not edited. | `.agent-work/handoffs/` for V5 stories. Keep `handoff.md` until OA-1. | keep | Two handoff locations until the owner accepts the V5 one. Trust `dispatch recover` over this file if they disagree, per the file itself. |
| `missions/` | `BARBER-RECOVERY` brief, decisions, and `state.json`. | `state.json` parses. Decisions file says the mission was prepared, not activated (2026-09-19). `handoff.md` later says recovery is in flight in the product repo. This audit did not activate it and did not edit it. | `missions/` (business records stay). Not a V5 kernel path. | keep | Do not treat the mission as activated from this audit. Do not touch the barber app, its Vercel project, or its Supabase project. |
| `portfolio.json` | Projection of repos, missions, hosting identifiers, and credential *names*. | `node` JSON.parse succeeded. It is a projection, not authoritative (its own `truth_model` says so). | `portfolio.json` | keep | Workers row still says GitHub create failed. Checked read-only this session: `gh repo view Roberto-Madrid/dexter-workers` returned `visibility: PRIVATE`. The projection is stale. Not corrected here (file not owned by G0 lanes). Barber hosting ids are recorded and must stay unchanged. |
| `README.md` | Human intro to HQ. | Readable. The "Bootstrap status" section still says the dispatch client has not been installed. That sentence is false: `tools/dispatch` exists and its tests passed. Not rewritten (G7 owns `README.md`). | `README.md` (G7) | keep until G7 | A new reader will believe the client is missing. |
| `reference/` | `Dexter_HQ_Plan_v2.1.md`, reference-only. | Readable. Not part of the V5 startup read. Not copied into `docs/MASTER_PLAN_V5.md` (that file is Appendix A of the V5 action plan). | `reference/Dexter_HQ_Plan_v2.1.md` | keep | Do not auto-load it into workers. Do not duplicate it. |
| `roles/` | v2 role briefs and assignment/result templates. Nine files. | Readable contracts. No runner. Not executed. | `personas/` and `crews/` in later stories. These briefs stay until those exist. | keep | Deleting them now would drop the only written worker contracts. Proposed quarantine only after OA-1 and after V5 personas land. |
| `tools/` | `tools/dispatch`, a zero-dependency Node ESM CLI for the Cursor Cloud Agents API. | Install: none required. `npm ls --depth=0` shows an empty tree (`.agent-work/evidence/G0/npm-ls.txt`). Build: no build script; `package.json` scripts are only `test` (`.agent-work/evidence/G0/no-build.txt`). Test: `npm test` → 72 pass, 0 fail, exit 0 (`.agent-work/evidence/G0/dispatch-test.txt`). `dispatch help` exit 0 (`.agent-work/evidence/G0/dispatch-help.txt`). Node v22.14.0 (`.agent-work/evidence/G0/node-version.txt`). | `tools/dispatch/` until `adapters/cursor-cloud.ts` (G3) replaces the runtime. Additive; do not rewrite it in G0. | keep | The client is the working control plane. Breaking it to "make room" for V5 would fail the preserve rule. |

There is no root `package.json`, no `supabase/`, no `vercel.json`, no `.github/workflows/`, and there was no `.gitignore` before this story. G0 adds `.gitignore` and `.github/pull_request_template.md`. Those are new files, not replacements.

## Commands run

| Command | Result | Evidence |
| --- | --- | --- |
| `node --version` / `npm --version` | v22.14.0 / 10.9.7 | `.agent-work/evidence/G0/node-version.txt` |
| `npm test` in `tools/dispatch` | 72 pass, 0 fail, exit 0 | `.agent-work/evidence/G0/dispatch-test.txt` |
| `npm ls --depth=0` | empty dependency tree | `.agent-work/evidence/G0/npm-ls.txt` |
| `node tools/dispatch/bin/dispatch.js help` | exit 0 | `.agent-work/evidence/G0/dispatch-help.txt` |
| `node tools/dispatch/bin/dispatch.js recover` | exit 0, offline, 1 record | `.agent-work/evidence/G0/dispatch-recover.txt` |
| `node` JSON.parse of `portfolio.json`, `config/dispatch-policy.json`, `missions/BARBER-RECOVERY/state.json` | ok | recorded in this audit; no separate file because stdout was the token `json_ok` |
| Secret scan of the working tree | no live secret values | `.agent-work/evidence/G0/secret-scan.txt` |

No repo-root install, build, lint, or typecheck command exists. Absence is recorded above, not treated as a pass of a suite that is not there.

## Env var names

Current code and policy read one name: `DEXTER_CURSOR_API_KEY` (`config/dispatch-policy.json`, `tools/dispatch`). No `.env` file is in the tree. `.env.example` added in G0 lists V5 names with empty values (Appendix C.6). The existing key name is not in that example; it remains the dispatch client's variable. Values were not read or printed.

## External services

| Service | Where named | Live data in this repo? |
| --- | --- | --- |
| Cursor Cloud Agents API `https://api.cursor.com` v1 | `config/dispatch-policy.json` | Dispatch record ids only. No key value. |
| GitHub `Roberto-Madrid/dexter-hq`, `dexter-barber`, `dexter-workers` | `portfolio.json`, policy allowlist | `dexter-workers` is a private repo (observed this session). |
| Vercel project `prj_yFeb9XnErOYVXO3SSu4IfYBTu7JZ` | `portfolio.json` hosting block for barber | No deploy config in this repo. Leave unchanged. |
| Supabase ref `uzmvhoejpqhgsffpqdnf` | `portfolio.json` for the barber app | No schema, migration, or SQL in this repo. Leave unchanged. |

## DB schema and deploy config

None in `dexter-hq`. No migrations, no RLS policies, no `supabase/` directory, no Vercel project file. V5 schema starts in G2 on a new Supabase project (OA-2), not on the barber project.

## Live data references

- `.dexter/dispatch/records/hq-preflight-001.json`: one finished preflight against `dexter-barber` at `9ddad27bc056e1715118dda8b04962108659d31b`.
- `portfolio.json` hosting identifiers above. Not credentials.
- `handoff.md` says barber PR 6 is open on `cursor/barber-integration`. Not modified.

## Secret scan

Pattern scan over the working tree (private keys, `AKIA`, GitHub PATs, Slack tokens, `sk-` tokens, JWTs, URL userinfo, Postgres URLs with passwords). No live secret value. Classified non-matches: redaction-test fixtures, a placeholder in a `redact.js` comment, a false positive where `sk-` is the end of the word `task` inside a branch name, and the action-plan workflow template that interpolates `${TOKEN}` rather than a literal secret. Detail: `.agent-work/evidence/G0/secret-scan.txt`.
