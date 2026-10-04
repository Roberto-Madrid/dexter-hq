# V6 Stage 1 — Needs you approval tap

- **Owns**: `app/(hq)/command-center.tsx` (Approve/Deny buttons only), `app/api/approval/route.ts`, `hq/approval.ts`, `hq/server.ts` (`postApproval`), `hq/connector-store.ts` / `hq/connector-pg.ts` (`claimApproval`), `app/generated/hq.d.ts`, `tests/unit/approval.test.ts`, `tests/e2e/command-center.spec.ts` (button role only)
- **Out of scope**: owner login, Vercel project settings, env vars, new migration, button CSS/animation/tower redesign, Stage 2 (Dexter, Scout, barber lead, Checker on every PR), STOP ALL behavior
- **Done-command**: `npm run typecheck && npm run lint && npm test`
- **Result**: 70 unit/security tests passed, including 5 in `tests/unit/approval.test.ts`
- **Notes**: Decision is stored on existing `public.approvals.action` as `pending|approved|denied:` plus `public.events`. No migration. Missing `VERCEL_TOKEN` returns `not_configured` / `missing_credential` with `ran: false`.
