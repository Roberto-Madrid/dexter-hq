# Saved upgrade-check tasks

Five small tasks per role-sheet model family, one Markdown file each, in `config/upgrade-tasks/<family>/`.
When a new version is held and the owner taps "Run upgrade check", HQ launches every task on the incoming
version (and on the current pin when that task has no result yet) as the internal `hq-upgrade` bot, in the
sandbox repo named by `DEXTER_UPGRADE_SANDBOX_REPO` (seeded from `workers/checker-sample`).

Rules:
- A brief never names a model or vendor (`npm run check:briefs` scans this folder).
- The file name (without `.md`) is the task id; it is part of the run's idempotency key, so renaming a task
  makes it run again on the next check.
- `{{branch}}` is replaced per run with a branch name unique to the task and version, so runs never share a branch.
- Each task ends with a done-command that runs in the sandbox repo. Today a run passes when it finishes
  (weaker grading); the Checker on the pushed branch is the upgrade path, and it will run that command.
