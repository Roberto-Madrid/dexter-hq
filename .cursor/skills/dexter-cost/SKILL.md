---
name: dexter-cost
description: Source of truth for Dexter's spend discipline — model routing, dispatch bounds, worker brief shape, and roster limits. Load before launching any worker or deciding how to run a piece of work.
---

# Dexter cost policy

Lead with the cut. Short reports. Never invent a dollar figure — if it was not
measured, call it a pattern. Real numbers come from `dispatch usage`
(`rawCostCents`, `chargedCents`), which is retrospective and per agent.

Scale check: these are small business apps with tens to low hundreds of users.
Prefer the smallest working fix. No enterprise ceremony.

## Model routing

Escalate exactly one tier at a time, and only after the cheaper tier actually
failed. Pick the tier yourself at launch; do not ask the owner each time.

| Tier | When | Model |
| --- | --- | --- |
| Default ship | Clear work, few files, styling, copy, layout | `composer-2.5` |
| Tricky logic | State, auth, concurrency, data ownership, migrations | `grok-4.6` |
| Hard gate | The cheaper tier failed, or security-sensitive | `claude-sonnet-5` |
| Nuclear | Sonnet failed, or the owner asks | `claude-opus-5` |

Opus is not a normal rung. Reaching for it by default is the single most
expensive habit available. Coordination and judgment work (HQ, project lead)
may sit higher than implementation work; that is the exception, not licence.

The API never reports the effective model. A requested model is not a verified
one, and null always means unknown.

## Where work runs

| Work | Where |
| --- | --- |
| One or two files of CSS, layout, copy, config | Do it in the existing checkout |
| Multi-file, logic, API, schema-adjacent | A dispatched worker |
| Strategy debate, status theatre, re-deciding settled things | Nowhere |

Never dispatch a worker for a one-line change: a cold VM boot plus context load
costs more than the edit. Never edit in the checkout and then re-do the same
patch in a worker.

Idle agents cost nothing. **Wakes** cost. Kill habits before killing roster.

## Worker brief shape — required

1. Goal and acceptance in five lines or fewer.
2. Touch only `<paths>`. Out of scope: `<list>`.
3. Load product context once. Never read `node_modules`. No unbounded greps.
   Cap command output.
4. Targeted checks while working; the full gate once, at the end.
5. Open the PR ready for review, not as a draft. Stop when done. Never merge.
6. One implementer owns a surface until its PR exists.

## Roster limits

At most one implementer, one reviewer or gate, one QA, and one database owner
per product. Add another only if it genuinely does not overlap and gets used.
If a role would overlap an existing one, widen that role instead of spawning a
new agent. Do not wake the reviewer or QA before a PR exists.

Retiring an agent is the owner's call. Propose candidates; never delete.

## Parallelism

Prefer two isolated workers on different briefs and branches over two topics in
one conversation. Parallelism buys elapsed time and costs tokens — measure
accepted outcomes, not agents created.

## Context hygiene

Summarize and re-anchor when a conversation grows large rather than dragging
the whole history forward. Durable state belongs in `notes.md`, `handoff.md`,
and `.dexter/dispatch/` — not in chat scrollback. When the same briefing or
checklist is written a second time, make it a skill instead.
