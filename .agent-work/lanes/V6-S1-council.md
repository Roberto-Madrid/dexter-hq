# V6 Stage 1 unit 2 — Council endpoint on path B

- **Owns**: `hq/connector.ts` (`request_council`), `tests/unit/connector-council.test.ts`, council cases in `tests/unit/mcp.test.ts`
- **Out of scope**: owner login, sessions, auth routes, Graph light UI, Example fixtures, applying `0008` to a live database, Vercel settings, key rotation, branch `v5`, `dexter-barber`, Architect/Strategist/Security/Devil seats, weekly seat-cap settings UI
- **Design**: `request_council` runs one Critic seat through the existing `runCriticSeat` path B helper. Login is `SUPABASE_DB_URL` + `DEXTER_AGE_PRIVATE_KEY` only. No new env var. Missing login returns `not-configured` with no `result`/`actions`. Tests inject a seat function so a schema-valid `Verdict` can be proven without a live ChatGPT login.
- **Done-command**: `npx vitest run tests/unit/connector-council.test.ts tests/unit/mcp.test.ts tests/unit/council-seat.test.ts` plus `npm run typecheck`, `npm run lint`, `npm test`
- **Left**: other Council seats, Checker/GitHub Actions, dashboard Council feed, live weekly cap in settings, applying `0008` live
