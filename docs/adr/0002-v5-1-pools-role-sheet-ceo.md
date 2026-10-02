# ADR-0002: V5.1 — Cursor-first pools, OpenCode harness, role sheet, fixed CEO model

- **Decision:** spend Cursor Cloud Agents first (Grok, Composer, Claude Opus), then free GitHub Models rows through OpenCode in GitHub Actions, then a capped Codex share of the ChatGPT plan; assign every model through an owner-approved role sheet of model families (the latest GPT Sol at medium reasoning for the CEO on the ChatGPT plan, the latest Grok for building, the latest Composer for quick edits, Claude Opus for judgment), track each family's latest stable, standard version behind a price guard and an upgrade check, escalate only on failed checks, and add new families only through proposals the owner approves; enforce plan rules in code; borrow proven practices as text; buy nothing new unless a trigger in §5 fires.
- **Drivers:** the owner prefers spending Cursor usage over ChatGPT usage; no new spend; CEO decisions carry the most leverage per token; the model landscape changes monthly.
- **Alternatives considered:** Codex-first workers (drains ChatGPT); buying OpenCode Go now (unneeded while Cursor includes Grok 4.7); a learned per-request router or a hosted one such as Cursor's router, OpenRouter's Auto Router, or RouteLLM (unpredictable, breaks prompt caching, per-token billing or a team plan); a free-tier CEO (weak decisions); a separate Grok API key (duplicate access).
- **Why chosen:** it uses what is already paid in the preferred order, keeps every runtime stoppable, and follows the role-per-model practice of oh-my-claudecode and pstack: predictable, visible, and changed only with approval.
- **Consequences:** Cursor quota becomes the main constraint; the CEO draws a small share of ChatGPT usage; the CEO path is fixed only after G1 proves it.
- **Follow-ups:** review D-5 monthly from pool usage; review bake-off proposals monthly; add the Claude pool if Claude Pro is bought.

Source: DEXTER_V5_ACTION_PLAN.md §11. Adopted in G0.
