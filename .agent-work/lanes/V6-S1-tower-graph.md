# V6 Stage 1 follow-up — live desktop tower graph

- **Owns**: `app/(hq)/tower-model.ts`, `app/(hq)/command-center.tsx` count tile, `app/(hq)/control-tower.css` count detail, `tests/unit/tower.test.ts`
- **Out of scope**: Graph light fixture coordinates, auth/login, Vercel/env, STOP ALL resume control, Stage 2 Dexter bot creation
- **Done-command**: `npm run typecheck && npm run lint && npm test`
- **Cause**: live swarm used the first bot as the hub; labels always offset right; Agents counted every Cursor run as `n/cap`; Cursor fell back to the Example `18%` whenever usage was missing.
