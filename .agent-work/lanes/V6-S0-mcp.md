# V6 Stage 0 — MCP connector stub

- **Owns**: `app/api/mcp/route.ts`, `hq/mcp.ts`, `tests/unit/mcp.test.ts`, `tsconfig.app.json`
- **Out of scope**: UI, path B, tick, kernel, Cursor/GitHub/Vercel keys, HTTPS fallback
- **Route**: `POST /api/mcp` (Streamable HTTP JSON). `GET` and `DELETE` return 405 (no SSE session).
- **Tool**: `whoami` returns `CONNECTOR_IDENTITY`. No action, no secrets.
- **Done-command**: `npx vitest run tests/unit/mcp.test.ts`
