# Mandatory worker preflight

Applies to every role, every task, without exception. A cloud runtime may hand you a
stale checkout. Verify before you read deeply, test, or edit.

Report the results of these steps before substantive work.

1. **Confirm identity.** Report the remote repository and your working directory. If the
   remote is not the assigned repository, stop.
2. **Inspect dirty state.** Report any uncommitted local changes and preserve them.
   Never discard another agent's work.
3. **Fetch and verify.** `git fetch origin` the required reference, then confirm the
   assigned base SHA is available. If the assigned SHA is not the current tip, report
   **both** SHAs and ask or follow the assignment's stated rule — do not silently assume.
4. **Isolate.** Create or use a task checkout or worktree based on that exact commit.
5. **Prove HEAD.** Report your actual HEAD SHA and confirm it equals the assigned base
   before editing.
6. **Confirm the runtime.** Confirm test database identity, which credentials apply (by
   variable name only), and the supported build and test commands.

## Rules

- If the runtime supplied a stale checkout, correct it safely in an isolated
  worktree or branch. **Never** use a destructive reset to conceal the mismatch.
- If the assigned commit cannot be retrieved, stop the task with a clear blocker. Do not
  substitute a nearby commit.
- Task input files must be committed or provided explicitly. A cloud worker inherits
  neither uncommitted edits nor the parent's conversation.
- Once your changes move HEAD, report **base SHA and result SHA** separately.
- Before integration, account for upstream changes and rerun affected checks after
  resolving conflicts.
