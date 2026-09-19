# Task result

Result contract. Fields follow master plan section 8. Every field is required; write
`unknown`, `none`, or `not_tested` rather than deleting a field or guessing.

Keep this compact: a few hundred words plus references. Large logs stay in artifacts.

> A success claim here is a **proposal for acceptance**, not final proof.

## Identity

- **Project ID / Mission ID / Task ID:**
- **Role:**
- **Actual agent ID:** from runtime metadata — not invented, not an echoed string
- **Actual run ID:** from runtime metadata
- **If runtime metadata did not expose an ID:** state `unknown` and say why

## Revisions

- **Assigned base SHA:**
- **Verified base SHA (actual HEAD before work):**
- **Base matched assignment?** yes | no — if no, explain and give both SHAs
- **Branch or worktree actually used:**
- **Result SHA (HEAD after work):**
- **Pushed?** yes | no — and to which remote branch

## Preflight

- **Remote repository confirmed:**
- **Working directory:**
- **Pre-existing dirty changes found and how they were preserved:**
- **Test database identity confirmed:**

## Outcome

- **What changed:**
- **What remains incomplete:**
- **Deliberately left out and why:**

## Checks actually run

| Command or check | Result | Evidence path |
| --- | --- | --- |
|  | passed / failed / blocked / not_tested |  |

Absence of a result is `not_tested`, never `passed`. Do not mark `passed` because a file
was written or a configuration exists.

- **Delivery state, where applicable:** not_started | in_progress | blocked |
  deployed-but-unaccepted | accepted | released
- **Deployment, verification, and acceptance are separate facts.** A reachable URL is not
  completion.

## Integration attention

- **Contract or interface changes:**
- **Deviations from the assignment:**
- **Paths touched outside owned paths:** (should be none — explain any)
- **Conflicts the integrator should expect:**

## Limitations and next action

- **Known limitations:**
- **Blockers, including missing permissions or credentials (names only):**
- **Recommended next action:**

## Model and usage

- **Requested model ID:**
- **Effective model ID:** `null` means **unknown** — never assume the requested model took
  effect
- **Source of effective-model evidence:** or `unavailable` if telemetry does not expose it
- **Usage or cost observed:** report only if genuinely observed; otherwise `unknown`

## Credential attestation

- **No secret, key, token, or credential value appears in this result, in any commit made,
  or in any log referenced:** confirm
