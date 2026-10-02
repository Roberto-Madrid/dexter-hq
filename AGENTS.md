# AGENTS.md — dexter-hq

Dexter HQ V5.1: a personal, model-agnostic headquarters (CEO chat, Command Center, elastic swarm).
Spec: docs/MASTER_PLAN_V5.md. Build plan: DEXTER_V5_ACTION_PLAN.md. Constitution: docs/CONSTITUTION.md.

## Before you work
Read .agent-work/ledger.jsonl (last 30 lines), the newest .agent-work/handoffs/*.md, and your task in .agent-work/tasks/.

## Commands (use the repo's package manager)
typecheck · lint · test · test:integration · test:e2e · test:live (LIVE=1 only) · check:vendor · check:briefs · check:bundle · scan:secrets

## Rules
- Edit only files your task owns. Report in .agent-work/lanes/. Never commit; the lead owns git.
- Lazy ladder before any code: needed at all, already in this repo, standard library or platform, installed dependency, one line; only then the minimum.
- No model vendor or product names in kernel/; model names live only in gateway/role-sheet.yaml.
- Never print or commit secrets; .env.example lists names only.
- Branches: v5/G<n>-<slug>; never touch main; no force-push to shared branches.
- No new paid services, servers, Redis, Kafka, Kubernetes, queue services, second databases, or frameworks.
- Superseded code goes to legacy/; deletion needs owner approval.
- Evidence or it did not happen: paste the done-command's real output; save outputs under .agent-work/evidence/.
