# Lane V6-S3-police-a: token police part A (connector gates + usage receipts)

Plan: owner brief 2026-10-08 (token police is a connector-level role, not a bot). Spec: agent-brake `token_police/checks.py` (thresholds reused, code is HQ TypeScript, all connector-side). Migration: no. New env vars: none (reuses `GH_HQ_TOKEN` and `CURSOR_API_KEY`). New UI: none. New post types or board changes: none (part B, after unit 4).

## Owns
- new `hq/token-police.ts`: gate verdicts (2 retries, BLOCKED on the 3rd fail), PR/merge diff cap and secret-filename scan, 349-word skill/profile validator
- new `hq/usage-receipts.ts`: Cursor `GET /v1/agents/{id}/usage` client, defensive parser, one fail-soft receipt per finished run
- hooks only: `hq/connector.ts` (request_approval, update_request done, request_checks, agent_status, deps), `hq/checker.ts` (`compare` on the GH gateway), `hq/reconcile.ts` (receipt after close), `hq/ventures.ts` (brief word cap), `hq/fleet-report.ts` (usage totals)
- tests: `tests/unit/token-police.test.ts`, `tests/unit/usage-receipts.test.ts`, small additions to existing approval, ventures and fleet tests

## Thresholds (agent-brake defaults)
- gate: verdict pass = the pinned Checker run passed on the request's sha (exit 0 for every pinned check); 3 distinct failed runs since the last pass = BLOCKED
- diff: more than 20 changed paths (`diffstat(path_cap=20)`) refuses
- secret filenames: `.env`, `.env.*`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `credentials.json`, `secrets.json`, `*.pem`, `*.p12`, `*.pfx`, `*.key`
- skill/profile words: more than 349 refuses

## Out of scope
- BLOCKED board post type (part B; TODO hook in `recordGateFailure`), launch handler and model pins (unit 2), post/verify_post/get_context (unit 4), self-tests/watchdog (unit 6), migrations, live data, cloud agents.

## Done-command
`npm run typecheck && npm run lint && npm test && npm run check:vendor && npm run check:briefs && npm run check:bundle && npm run scan:secrets && npm run test:integration`, with live DB, Cursor and GH vars unset and `PGUSER=ubuntu`.
