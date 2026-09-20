---
name: dexter-draft-pr
description: Pull request and release boundaries for Dexter workers. Use whenever a worker is about to push, open a PR, merge, deploy, or touch production data.
---

# PR handoff

Shippers open **ready (non-draft)** PRs. The owner asked for this on 2026-09-20.
Do not open drafts unless the owner says so for a specific task.

## Always

- Push your own branch. Never push to `main`.
- Open the PR as **ready for review** (`gh pr create`, not `--draft`).
- Never merge it. Never approve your own work. HQ or the owner merges.
- English commit messages and PR bodies. Say what changed and what is still
  incomplete.

## Never, without explicit owner authorization

- Merge to a default or protected branch.
- Deploy, change hosting, or alter a production setting.
- Run a migration, seed, reset, or any mutating SQL against a live database.
  Write the migration file, explain why, and stop.
- Buy a service, provision paid infrastructure, or enable paid overage.
- Contact a real client.

## Independent verification

A builder may not verify its own work. Verification is a separate agent with a
fresh look at behaviour, authorization, persistence, and visuals against the
accepted scope. Visual checks of the actual screens are required when the
change is user-visible.

Record these separately and let them disagree: deployed, verified, and
accepted. A live URL is not completion. A screenshot is not proof of
persistence. A queued notification is not a delivered one.
