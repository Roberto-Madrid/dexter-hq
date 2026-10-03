# Cross-family review — gpt-6.1-sol

Tool: Codex 0.160.0, read-only sandbox, model reported as gpt-6.1-sol. Cursor's Claude and GPT seats were over quota, so this is the §4.0 last-resort review. The reviewer did not edit the tree.

Verdict before fixes: FAIL. Four concrete defects:

1. Authenticated owners could update `tasks.state` and `lease_generation` directly, skipping the generation check and the event.
2. `transition_task` treated a null expected generation as a match and still wrote an event.
3. `in_review` → `working` could exceed `slot_cap` after claim had reused the slot.
4. Council routing fell back to an exhausted pool and returned resolved.

Fix round 1, in this story, without weakening a criterion:

- Trigger `tasks_control_columns` rejects those column changes from `authenticated`, `anon`, and `service_role`. Security-definer functions still write them.
- Null generations use `IS DISTINCT FROM`, and a zero-row update raises before the event insert.
- Entering `leased` or `working` from an inactive state takes the control-row lock and refuses when the cap is full.
- Council resolution holds with `pools_exhausted` when every pool is exhausted.

Tests that fail if any of those regress: `tests/integration/claim.test.ts`, `tests/unit/kernel.test.ts`.
