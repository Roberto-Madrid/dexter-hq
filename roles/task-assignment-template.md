# Task assignment

Assignment contract. Fields follow master plan sections 7 and 8. Every field is required;
write `none` or `n/a` rather than deleting a field. Attach the role brief and
`roles/preflight.md` with this assignment. Do **not** attach the master plan.

## Identity

- **Project ID:**
- **Mission ID:**
- **Task ID:**
- **Role:** project-lead | designer | builder | integrator | verifier
- **Invocation type:** the actually supported agent type used (e.g. `generalPurpose`). A
  worker carrying the role brief IS that role; a custom named type is optional.
- **Scope revision:**

## Source

- **Repository URL:** (canonical name; note any historical alias)
- **Expected base SHA:** (exact commit, not a branch name)
- **If the base SHA is no longer the tip:** stop and report both SHAs | rebase onto the
  tip and report both | proceed on the assigned SHA
- **Target branch policy:** branch name pattern, and whether pushing is authorized
- **Protected branches / merge policy:** (default: no merge to a protected branch)
- **Brief snapshot:** path or inline. This snapshot is immutable — it is not a second
  editable brief.

## Work

- **Outcome:** what must be true when this is done
- **Excluded work:** explicitly out of scope
- **Acceptance criteria:** checkable statements, each one verifiable

## Ownership

- **Owned paths:** the only paths this worker may write
- **Owned interfaces / contracts:**
- **Dependency contracts:** what this task consumes that another worker owns
- **Concurrent workers and their owned paths:** so overlap is visible
- **Migration owner for this mission:** (exactly one across the mission)

## Design

- **Design references:**
- **Approved visual version and scope revision:**
- **Design approval needed?** yes | no — no for backend fixes and small corrections inside
  already-approved visuals

## Environment and data boundaries

- **Build / test / lint commands:**
- **Development database identity:**
- **Data rules:** isolated development data; no seeds, resets, or migrations against a
  shared or live database unless this worker is the migration owner
- **Credentials:** environment **variable names only**. Never a value. Never request a
  value in chat.
- **Hosting boundary:** (e.g. leave unchanged; no deployment side effects)

## Retry and budget policy

- **Launch attempts:** 1. A timeout is AMBIGUOUS — reconcile by lookup before any retry.
- **Repair cycles:** 1, then reassess the approach
- **Follow-ups while the agent is busy:** 0
- **Requested model ID:** must be a discovered ID, or `null` meaning unknown/undiscovered.
  Never an alias from memory.
- **Paid overage:** disabled. Exhausting the included allowance is a stop condition.
- **Output limits:** compact summary, a few hundred words plus references; large logs to
  artifacts

## Result requirements

- **Result location:** path where the result record must be written
- **Result format:** `roles/result-template.md`, fully populated
- **Required evidence:** commands run, outcomes, artifact paths, screenshots where
  behavior is visual
- **Status vocabulary:** every check reports `passed`, `failed`, `blocked`, or
  `not_tested`. Absence of a result is `not_tested`, never `passed`.
- **Required SHAs:** base SHA and result SHA, reported separately
