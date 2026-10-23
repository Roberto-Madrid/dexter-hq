# Dexter HQ

Dexter HQ is a personal, model-agnostic headquarters for an AI agent fleet. You talk to one coordinator; it turns work into plan cards, dispatches isolated workers, and tracks results on a Command Center. Outbound changes go through PR gates. Token usage and spend are recorded so cost stays visible.

This repository is the headquarters: kernel, HQ APIs, Command Center UI, dispatch client, and operating files. Product applications live in their own repositories.

## What is here

| Path | Role |
| --- | --- |
| `kernel/` | Vendor-neutral orchestration: leases, plan cards, preflight, redaction, token police |
| `hq/` | HQ server: connector, board, usage receipts, ventures, safety controls |
| `app/` | Next.js Command Center (owner login, request board, swarm, STOP ALL) |
| `adapters/` | Runtimes that actually run work (cloud agents, GitHub runners, inline/fake) |
| `gateway/role-sheet.yaml` | The only place model names live |
| `tools/dispatch/` | Small CLI for launching and recovering cloud agents |
| `personas/` · `crews/` | Role contracts and task-graph recipes |
| `supabase/migrations/` | HQ persistence |
| `tests/` | Unit, security, integration, and Playwright checks |

Workers are disposable. Requests, artifacts, decisions, and spend records persist. A live URL is not completion; deployment, verification, and owner acceptance are tracked separately.

## Checks

Use the repo's package manager. Commands run without live secrets; integration tests expect a local database (see `scripts/ensure-integration-db.mjs` and CI).

```
npm run typecheck
npm run lint
npm run test
npm run test:integration
npm run test:e2e
npm run check:vendor
npm run check:briefs
npm run check:bundle
npm run scan:secrets
```

`npm run test:live` is opt-in (`LIVE=1`) and talks to real services.

Local agent ledgers and command transcripts go under `.agent-work/` and are gitignored.

## Boundaries

- Keep credentials out of Git, prompts, logs, and worker result files.
- Do not silently enable paid overage or unauthorized model fallbacks.
- Production changes, paid provisioning, releases, and client communications need explicit owner authorization.
- Kernel code stays vendor-neutral; do not put model product names there.
