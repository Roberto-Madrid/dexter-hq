# V6 Stage 1 — STOP ALL connector cancel

- **Owns**: `hq/stop.ts`, `adapters/cursor-cloud.ts`, `tests/unit/stop.test.ts`
- **Out of scope**: UI copy, auth, env, visual redesign
- **Done-command**: `npx vitest run tests/unit/stop.test.ts tests/unit/mcp.test.ts tests/unit/g3.test.ts`
- **Change**: `listInProgress` matches Cursor statuses case-insensitively (`running`, `creating`, `queued`, `starting`). `stopAll` also cancels `connector.listAgents()` rows in ACTIVE_AGENT when `cursorHandle` is present, even if `listInProgress` is empty, then marks those rows `cancelled` after a **confirmed** cancel.
- **After confirmed cancel**: Cloud Agents list items use lifecycle `ACTIVE`/`IDLE`/`ARCHIVED` plus `latestRunId` (still accept run-level creating/running). Cancel confirms only on HTTP 2xx; a stale run id refreshes `latestRunId` once. The `stop_all` event result stores `{status,tokens,reports,asOf}`.
