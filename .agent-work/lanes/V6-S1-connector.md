# V6 Stage 1 unit 1 — Dexter connector

- **Owns**: `app/api/mcp/route.ts`, `hq/mcp.ts`, `hq/connector.ts`, `hq/connector-store.ts`, `hq/connector-pg.ts`, `supabase/migrations/0008_bots.sql`, `tests/unit/mcp.test.ts`, `adapters/cursor-cloud.ts` (follow-up on the existing key path), `tsconfig.app.json`
- **Out of scope**: owner login, Graph light UI, Example fixtures, path B live seats, STOP ALL token suspension UI, bot seeding, Dexter/Scout/venture leads, `dexter-barber`
- **Done-command**: `npx vitest run tests/unit/mcp.test.ts` plus `npm run typecheck`, `npm run lint`, `npm test`
- **Left for later units**: live Council seats through path B, Checker/GitHub Actions, dashboard Bots/Needs-you/CEO feed, STOP ALL cancel+suspend, applying `0008` to the live database, rotating HQ Dev off its Cursor key
