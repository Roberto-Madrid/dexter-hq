# Roles

Role briefs are reusable instructions with short-lived execution. They are not a
permanently running employee fleet, and a file in this directory is not a running agent.

## A role brief makes the worker that role

A `generalPurpose` worker that receives a role brief **is** that role for that task.
Custom named agent types are optional ergonomics, not a prerequisite. Never invent an
invocable agent type: use an actually supported invocation type and pass the brief.

If a role name is missing from the available agent-type list, that is not a blocker.
Dispatch `generalPurpose` and attach the brief.

## How to use these

1. Pick the role brief for the task.
2. Fill `task-assignment-template.md` with every field.
3. Attach the role brief plus the mission brief snapshot — not the master plan, and not
   the whole conversation.
4. Require `result-template.md` back, fully populated.

Every role brief assumes `preflight.md`. It is mandatory and not optional for any role.

## Files

| File | Purpose |
| --- | --- |
| `preflight.md` | Mandatory checkout and base-SHA verification for every worker |
| `project-lead.md` | Coordinates one mission end to end |
| `designer.md` | Journeys, mockups, interaction specification |
| `builder.md` | Bounded implementation |
| `integrator.md` | Combines branches, verifies the combined app |
| `verifier.md` | Independent review against accepted scope |
| `task-assignment-template.md` | Assignment contract (plan section 8) |
| `result-template.md` | Result contract (plan section 8) |

## Role boundaries

| Role | Owns | Does not own |
| --- | --- | --- |
| HQ | Owner relationship, portfolio, business decisions, approved missions, dispatch, acceptance summaries | Application implementation |
| Project lead | One mission, implementation plan, contracts, assignments, integration coordination, project state | Other clients, business-wide identity |
| Designer | Journeys, mockups, visual references, interaction specification | Unapproved implementation |
| Builder | Bounded code changes and relevant checks | Unilateral scope or shared-contract changes |
| Integrator | Combining branches, conflict resolution, integrated runtime and build | Production release without authorization |
| Verifier | Independent functional, permission, visual, and completion review | Approving its own implementation |

One project lead may also act as integrator to avoid a redundant agent, but must keep
implementation delegated and must preserve an independent final verification.

## Shared rules for every role

- Report base SHA and result SHA. Never conceal a checkout mismatch with a destructive
  reset.
- Status values are `passed`, `failed`, `blocked`, `not_tested`. Absence of a result is
  `not_tested`. Never claim `passed` because a file was written.
- A worker claiming success is a proposal for acceptance, not final proof.
- Never write a secret, key, or token into any file, commit, log, or result.
- Keep summaries compact: a few hundred words plus references. Large logs go to artifacts.
- Stay inside owned paths. If the work needs a path you do not own, stop and report it.
- Do not merge to a protected branch.
