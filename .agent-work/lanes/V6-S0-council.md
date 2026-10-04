# V6 Stage 0 — Critic seat through path B

- **Owns**: `hq/council-seat.ts`, `scripts/prove-council-seat.ts`, `tests/unit/council-seat.test.ts`
- **Out of scope**: MCP whoami, Graph light UI, login page, Stage 1 connector tools, bots tables, Council HTTP endpoint
- **Seat**: Critic. Structured output is the existing `Verdict` schema (`result`, `actions`) on the same Codex path B command as plan cards.
- **Done-command**: `node --experimental-strip-types scripts/prove-council-seat.ts`
- **Owner step**: done. Live Critic verdict is in `.agent-work/evidence/V6/council-seat.json` (`result: changes`, two actions). Schema-valid against `Verdict`.
