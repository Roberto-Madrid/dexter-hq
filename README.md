# Dexter. HQ

Dexter is the business and product headquarters for turning ideas into working applications through delegated agent work.

This repository holds Dexter's operating instructions, project records, and orchestration tools. Each application lives in its own repository.

## Operating model

- **Dexter HQ** works with the owner on ideas, priorities, scope, and acceptance. It dispatches project work and tracks results.
- **Project leads** coordinate one application's mission, dependencies, workers, and integration.
- **Workers** handle design, bounded implementation, and independent verification. Independent tasks can run in parallel with isolated checkouts.

Roles are reusable instructions, not permanently running agents. Creating an agent definition file does not prove that a worker was invoked.

## Bootstrap status

This README initializes the HQ repository. The dispatch client and operating files have not yet been installed or verified here.

To begin:

1. Start a fresh Cursor Cloud Agent on `Roberto-Madrid/dexter-hq`.
2. Attach `Dexter_HQ_Plan_v2.md` (master plan revision 2.1) and use its section 19 bootstrap prompt.
3. Extract short operating instructions from the plan and establish durable project/task records.
4. Verify access to the existing configured Cursor API secret without displaying its value. Availability in this environment and successful authentication still need confirmation.
5. Prove cross-repository dispatch, result retrieval, follow-up, fresh-session recovery, correct starting commits, and safe integration before assigning application work.

The master plan is supplied separately; it is not included in this initial commit. Read it once for setup and keep it as a reference rather than loading the entire document into every task.

## Planned repository layout

The following paths are planned, not a claim that these files already exist:

| Path | Responsibility |
| --- | --- |
| `AGENTS.md` | Short HQ identity, startup instructions, and boundaries |
| `portfolio.json` | Project repositories, active missions, and status references |
| `missions/` | Approved briefs, scope changes, dispatch records, and result references |
| `roles/` | Project lead, designer, builder, integrator, and verifier contracts |
| `config/dispatch-policy.json` | Allowed repositories, models, concurrency, and retry limits |
| `tools/dispatch/` | Small authenticated client for launching and managing project agents |
| `bootstrap/` | Capability evidence, setup status, and remaining blockers |
| `handoff.md` | Concise entry point for a fresh HQ session |

Application code, technical task details, design assets, and application tests belong in the corresponding product repository. HQ retains authoritative business scope and references to execution evidence.

## Delivery workflow

Discovery → approved brief → visual mockups and owner approval → delegated implementation → integration → independent verification → owner acceptance → authorized release.

For fixes within an approved design, skip unnecessary design work. Record explicit scope changes before dispatching affected tasks.

Every worker must verify the assigned repository and exact base commit before substantive work. Every result must identify its actual execution, resulting revision, checks performed, and remaining limitations.

Track deployment, verification, and owner acceptance separately. A live URL does not mean the application is complete.

## Boundaries

- Keep application implementation delegated; HQ remains the coordinator.
- Begin with at most two concurrent implementation workers and parallelize only independent tasks.
- Keep credentials out of Git, prompts, logs, and worker result files.
- Verify billing and spending controls; do not silently enable paid overage or unauthorized model fallbacks.
- Keep production changes, paid provisioning, releases, and client communications within explicit owner authorization.
- Preserve the existing barber application during HQ setup. Its recovery is a separate mission activated after bootstrap.
- Store decisions and execution references durably so work can resume without the original conversation.

The target workflow runs in Cursor-hosted environments without requiring the owner's laptop to stay on. Continuous unattended HQ operation is a separate capability that must be demonstrated, not assumed.
