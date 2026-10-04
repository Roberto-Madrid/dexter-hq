# V6 Stage 1 last unit — STOP ALL

- **Owns**: `hq/stop.ts`, `hq/deps.ts`, `hq/server.ts`, `hq/connector-store.ts`, `hq/connector-pg.ts`, `app/api/resume/route.ts`, `app/api/stop/route.ts` (unchanged auth), `app/(hq)/command-center.tsx` (existing STOP ALL click only), `tests/unit/stop.test.ts`, `tests/unit/mcp.test.ts`
- **Out of scope**: visual redesign, owner login/session/auth routes, applying `0008`, Vercel settings, key rotation, branch `v5`, `dexter-barber`, invented dashboard numbers
- **Done-command**: `npx vitest run tests/unit/stop.test.ts tests/unit/mcp.test.ts` plus `npm run typecheck`, `npm run lint`, `npm test`
