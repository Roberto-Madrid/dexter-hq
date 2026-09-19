# Boot a local Dexter HQ

Use this when you want Dexter running on your machine, dispatching local
agents against your local checkouts, instead of cloud VMs.

This file is a one-time launch prompt plus the facts a local session will
not inherit from the cloud conversation. After it starts, it follows the
normal HQ startup read order in `AGENTS.md`. Do not paste the master plan.

---

## One-time setup

1. Clone both repos next to each other. Names matter because this file
   assumes them:

   ```
   mkdir -p ~/src && cd ~/src
   git clone git@github.com:Roberto-Madrid/dexter-hq.git
   git clone git@github.com:Roberto-Madrid/dexter-barber.git
   ```

2. Open **`~/src/dexter-hq`** as the Cursor workspace. That is the HQ
   identity. Do not open `dexter-barber` as the workspace — you will
   become the product implementer by accident.

3. Add the barber checkout as a second folder in the same window if you
   want both visible (`File → Add Folder to Workspace`). Local agents
   should still be given an explicit path, not asked to guess.

4. Export the existing API key into this local environment so the
   dispatch client can talk to Cursor when you want a cloud worker, and
   so `dispatch recover` / `usage` keep working:

   ```
   export DEXTER_CURSOR_API_KEY="…"   # the existing key, never a new one
   ```

   Put it in your shell profile or a local-only `.env` that is gitignored.
   Never commit it. The variable name is required; the dispatch client
   reads it from `config/dispatch-policy.json`.

5. Open a new Cursor Agent chat in that HQ workspace. Paste the prompt
   in the next section. Attach nothing else.

---

## Paste this to start the local session

```
You are Dexter HQ, running locally on my machine.

You are my permanent business and product coordinator. You discuss ideas
with me, keep project context, dispatch work, and verify results. You do
not implement the application. Application work is always delegated.

This is a local session. Orchestrate local agents against my local
checkouts, not cloud VMs, unless I explicitly ask for a cloud worker.

Local paths (do not invent others):
- HQ:     ~/src/dexter-hq
- Barber: ~/src/dexter-barber

Startup, in this order, and nothing else by default:
1. AGENTS.md
2. portfolio.json
3. the active mission's state.json
4. handoff.md
5. config/dispatch-policy.json
6. .cursor/skills/dexter-cost/SKILL.md
7. node tools/dispatch/bin/dispatch.js recover

Trust `dispatch recover` over any prose that disagrees. If handoff.md is
stale, fix it before doing anything else.

Local dispatch rules:
- Launch local / same-machine workers, each in its own git worktree
  under the target repo, branched from an exact SHA you just resolved.
  Shared checkouts collide; worktrees do not.
- Give every worker the absolute local path, the expected base SHA, the
  owned paths, and the out-of-scope list. A local worker does not inherit
  this conversation.
- Load .cursor/skills/dexter-worker-preflight and dexter-draft-pr into
  every worker brief rather than retyping them.
- Model ladder, pick at launch, one rung at a time:
  composer-2.5 → grok-4.6 → claude-sonnet-5 → claude-opus-5 (nuclear).
  Opus monthly allowance is exhausted until 2026-10-11. Do not request it.
- Never boot a worker for a change smaller than the boot. Never redo a
  local edit inside a worker.
- Draft PRs only. Never self-ready, never merge, never deploy, never
  mutate the live Supabase project uzmvhoejpqhgsffpqdnf.

Do not activate a new product mission on your own. Tell me the current
state in five lines and wait.
```

---

## How local agents should be launched

Prefer Cursor's local / same-machine worker against a worktree, not a
cloud VM.

```
cd ~/src/dexter-barber
git fetch origin
git worktree add ../dexter-barber-wt-<task> <exact-sha>
```

Then point the worker at `~/src/dexter-barber-wt-<task>`. When it
finishes, you integrate; you do not let two local agents write the same
working tree.

The dispatch client (`tools/dispatch/`) still talks to the Cursor Cloud
Agents API. Use it when you want a cloud worker, or to `recover` /
`usage` / `followup` an existing cloud agent. It is not how you spawn a
local agent — there is no local-agent API. Local spawn is the Cursor
desktop agent / Task against a worktree, with a role brief.

---

## Facts a local session will not have unless you tell it

These postdate the files on `main` and override them.

**Opus is exhausted** until the monthly cycle resets on 2026-10-11.
Do not request `claude-opus-5`. Builders start at `composer-2.5`.

**BARBER-RECOVERY is in flight**, not prepared. Combined work is draft
PR #6 on `Roberto-Madrid/dexter-barber` (`cursor/barber-integration` @
`7e516a5`). Sibling drafts: PR #4 (`cursor/barber-defects` @ `de43c8d`),
PR #5 (`cursor/barber-shell` @ `0ed3897`). Independent verification is
on `cursor/barber-verification` @ `a9d8e50`. Nothing is merged to
`dexter-barber` `main` (`9ddad27`) and nothing is deployed.

**Migration `supabase/migrations/20260919094500_cancel_notification.sql`
is committed and not applied.** Needed because live `outbox_write` RLS
blocks a customer from writing a notice addressed to the barber.
Applying it is an owner decision. Until then, customer cancellations
succeed and notify nobody.

**Portrait is not locked** in a Safari tab. What shipped is a CSS
rotate-back overlay plus `manifest.orientation`. Real lock only applies
to an installed PWA.

**The live app, hosting, and database stay untouched** unless the owner
authorizes a change: Vercel `prj_yFeb9XnErOYVXO3SSu4IfYBTu7JZ`,
Supabase `uzmvhoejpqhgsffpqdnf`, production
https://dexter-mu-mauve.vercel.app.

**Cloud environment** (for when you do want a cloud worker) already
exists, covers both repos, and has `DEXTER_CURSOR_API_KEY` attached:
https://cursor.com/dashboard/cloud-agents/environments/e/16a2c703-b3e1-11f1-bb68-864e54d14197

---

## After it boots

The local Dexter should report current state, then wait. The open
owner decisions as of 2026-09-19 are:

1. Authorize the held cancellation migration — yes or no.
2. Mark PR #6 ready, merge it, or leave it draft.
3. Whether the slightly-lighter "Later visits" hint in light mode is fine.

Do not start a new mission, do not merge, and do not apply the
migration unless the owner says so in that session.
