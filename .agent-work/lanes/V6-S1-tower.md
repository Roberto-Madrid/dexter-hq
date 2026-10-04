# V6 Stage 1 unit — control tower panels

- **Owns**: `app/(hq)/command-center.tsx`, `app/(hq)/page.tsx`, `app/(hq)/tower-model.ts`, `app/(hq)/control-tower.css`, `hq/tower-load.ts`, `hq/connector-store.ts` list methods, `hq/connector-pg.ts` list methods, `tests/unit/tower.test.ts`
- **Out of scope**: owner login, STOP ALL cancel/suspend, approval executor, applying `0008`, Vercel settings, key rotation, `dexter-barber`, creating Dexter/Scout/venture leads
- **Done-command**: `npm run typecheck && npm run lint && npm test`
- **Design**: each panel is live only when connector or Cursor returned that kind of row. Missing or failed reads keep the Graph light Example fixtures and the Example label. Counts never invent usage.
