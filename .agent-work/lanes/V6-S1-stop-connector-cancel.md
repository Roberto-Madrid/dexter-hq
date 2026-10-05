# V6 Stage 1 — STOP ALL connector cancel

- **Owns**: `hq/stop.ts`, `adapters/cursor-cloud.ts`, `tests/unit/stop.test.ts`
- **Out of scope**: UI copy, auth, env, visual redesign
- **Done-command**: `npx vitest run tests/unit/stop.test.ts tests/unit/mcp.test.ts tests/unit/g3.test.ts`
- **Change**: `listInProgress` matches Cursor statuses case-insensitively (`running`, `creating`, `queued`, `starting`). `stopAll` also cancels `connector.listAgents()` rows in ACTIVE_AGENT when `cursorHandle` is present, even if `listInProgress` is empty, then marks those rows `cancelled`.
