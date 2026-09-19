---
name: dexter-worker-preflight
description: The mandatory checkout verification every dispatched worker runs before substantive work, and the contract fields every assignment must carry. Use when writing a worker brief or when starting work as a worker.
---

# Worker preflight

Workers have started on an obsolete commit before. This exists so it is caught
in the first thirty seconds rather than after an hour of work against the wrong
code.

## Every assignment must carry

Repository, scope revision, expected base SHA, target branch policy, owned
paths and contracts, excluded work, acceptance checks, data and environment
boundaries, and where the result goes.

## Every worker must, before reading or editing anything substantive

1. Report the working directory and any dirty changes. Preserve them. Never
   use a destructive reset to hide a mismatch.
2. `git fetch origin` and verify the assigned base SHA is the tip of the
   assigned branch. If it differs, report **both** SHAs and stop for
   instructions rather than assuming.
3. Create an isolated branch or worktree from that exact commit.
4. Report the actual `git rev-parse HEAD` and confirm it equals the assigned
   base before editing.
5. Confirm the test database identity, applicable credentials, and the
   supported commands from `AGENTS.md` and `package.json`. Do not invent a
   toolchain.

If the intended commit cannot be retrieved, stop with a clear blocker.

## Runtime facts that override intuition

- `git remote -v` is **empty** inside the cloud runtime and `pwd` is
  `/workspace`. Confirming remote identity that way is impossible. Confirm the
  repository from the task contract plus HEAD instead.
- A cloud worker does not inherit uncommitted edits or the parent's
  conversation. Task inputs must be committed or stated in the brief.
- A non-empty `git.branches` entry on a finished run is not evidence of a push.

## Every result must report

Actual agent and run ID, verified source base, branch, result SHA, what
changed, what remains incomplete, the commands actually run and their real
outcomes, contract deviations needing integration attention, known
limitations, and the next action.

Once work changes HEAD, report both the base SHA and the result SHA. A worker
claiming success is a proposal for acceptance, not proof.
