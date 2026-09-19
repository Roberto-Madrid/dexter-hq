---
name: dexter-draft-pr
description: Draft-only pull request and release boundaries for Dexter workers. Use whenever a worker is about to push, open a PR, merge, deploy, or touch production data.
---

# Draft-only handoff

Shippers open drafts. Nothing else.

## Always

- Push your own branch. Never push to `main`.
- Open the PR as a **draft**. Never mark it ready for review, never merge it,
  never approve your own work.
- English commit messages and PR bodies. Say what changed and what is still
  incomplete.
- Hand off to the reviewer only once the draft exists. Do not wake a reviewer
  or QA before there is something to look at.

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
accepted scope.

Record these separately and let them disagree: deployed, verified, and
accepted. A live URL is not completion. A screenshot is not proof of
persistence. A queued notification is not a delivered one.
