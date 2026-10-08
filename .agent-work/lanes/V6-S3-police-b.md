# Lane V6-S3-police-b: token police part B (board verdicts, BLOCKED post, usage card, artifacts, reuse scan)

Plan: owner brief 2026-10-08 (token police part B, after PR #34 part A and PR #32 board rules). Spec: agent-brake `token_police` (`controls.run_bounded` preview + artifact, `reuse.scan` 3 successes across 2+ agents, recommendation only) and `STAGE3_PLAN.md`. Migration: no. New env vars: none. New UI: none (the Tower design stays locked; owner reads are JSON and chat only).

## Owns
- `kernel/board.ts`, `kernel/types.ts`, `kernel/schemas.ts`: post type `verdict` (verifiable), regenerated `supabase/functions/_shared/kernel.js`
- `hq/board-notes.ts`: verdict rules (pass|fail + sha + run/request, no verdict on own work, verify by a different bot or a matching Checker run), `output` spill, artifact reads, BLOCKED and skill-suggestion notes in `get_context`
- new `hq/tool-artifacts.ts`: tool output over 200 chars stored in full as a `tool_output` event (existing `events` table), pointer + first 200 chars in replies
- new `hq/usage-card.ts`: owner usage-receipt card (`GET /api/board?view=usage`, chat "usage")
- new `hq/reuse-scan.ts`: one idempotent CEO-only skill suggestion when an approach succeeds 3 times across 2+ distinct agents; never writes a skill
- `hq/token-police.ts`: one BLOCKED board post per block (fixed template), idempotent
- hooks only: `hq/connector.ts`, `hq/connector-store.ts` + `hq/connector-pg.ts` (`listEventsByAction`, post evidence keys), `hq/classify.ts`, `hq/chat.ts`, `hq/server.ts`, `app/api/board/route.ts`, `app/generated/hq.d.ts`
- tests: `tests/unit/police-b.test.ts`, `tests/integration/police-b.test.ts`

## Out of scope
- any screen or CSS under `app/(hq)/**`, migrations, live data, cloud agents, new connector tools (scopes on live tokens stay valid), writing skill files.

## Done-command
`npm run typecheck && npm run lint && npm test && npm run check:vendor && npm run check:briefs && npm run check:bundle && npm run scan:secrets && npm run test:integration`, with live DB, Cursor and GH vars unset and `PGUSER=ubuntu`.
