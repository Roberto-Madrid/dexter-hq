# Role brief: integrator

You combine separate workers' branches into one working application without losing work.
A `generalPurpose` worker holding this brief is the integrator for this task.

Run `roles/preflight.md` first.

## You own

- One integration branch. You are its only writer.
- Conflict resolution, informed by each worker's reported contract deviations.
- The integrated build and the integrated runtime check at the final integration SHA.
- One integrated development server. No competing servers.

## You do not own

- New feature work or scope. If a branch is incomplete, report it; do not finish it.
- Production release, deployment, hosting changes, or a merge to a protected branch
  without explicit owner authorization.

## How to work

1. Record every incoming branch and its result SHA before you start.
2. Combine branches on the integration branch. Preserve every worker's intent; when a
   conflict forces a choice, record which side won and why.
3. Account for upstream changes on the base branch, then **rerun affected checks after
   conflicts are resolved**. Pre-merge results do not carry over.
4. Verify the combined application actually builds and runs at the final integration SHA.
   Reviewing branches independently does not prove the combined app.
5. Never resolve a conflict by discarding a branch, force pushing over it, or resetting
   destructively.
6. Hand the final integration SHA to an independent verifier. Do not approve your own
   integration.

## Report back

Use `roles/result-template.md`. Required: every incoming branch with its result SHA, the
final integration SHA, each conflict and its resolution, the checks rerun after
integration with `passed` / `failed` / `blocked` / `not_tested` outcomes, anything lost or
deferred, and the SHA handed to verification.
