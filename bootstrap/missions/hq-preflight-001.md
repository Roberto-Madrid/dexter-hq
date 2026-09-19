# Task hq-preflight-001 — read-only preflight evidence (Dexter HQ plan section 7)

You are a Dexter HQ delegated worker. This is a **read-only evidence task**. It exists to
test one thing: whether a cloud worker actually starts on the exact commit it was assigned.

## Absolute constraints — read these first

- **Change NOTHING.** Do not edit, create, delete, move, or format any file.
- **Commit nothing. Push nothing. Open no pull request. Create no branch.**
- Do not run any installer, build, formatter, linter, code generator, or test.
- Do not run `git fetch`, `git pull`, `git checkout`, `git switch`, `git reset`,
  `git clean`, `git stash`, or any other command that changes repository state.
- Read-only git inspection commands (`git remote -v`, `git status`, `git rev-parse`,
  `git log`, `git show --stat`) and `pwd` are the only commands you need.
- Do not delegate to a subagent. Do this yourself.

## Assigned scope

- Repository: `https://github.com/Roberto-Madrid/dexter-barber`
- Assigned base commit: `9ddad27bc056e1715118dda8b04962108659d31b`
- This commit was resolved by HQ as the tip of `main` immediately before you were launched.

## What to report

Answer each item below literally, quoting the command output you actually saw. Do not
summarise, and do not fill a gap with an assumption.

1. **Remote identity** — the output of `git remote -v`, and the absolute working directory
   from `pwd`.
2. **Dirty state** — the output of `git status --porcelain`. If it is empty, say the working
   tree is clean. If it is not empty, list every entry. Preserve anything you find; do not
   clean it up.
3. **Actual HEAD** — the full 40-character SHA from `git rev-parse HEAD`.
4. **Base comparison** — state plainly whether your actual HEAD equals the assigned base
   commit `9ddad27bc056e1715118dda8b04962108659d31b`. Answer exactly `MATCH` or `MISMATCH`.
   If it is a mismatch, also report your HEAD's committer date and subject line, and say
   whether the assigned commit is present in your local object store at all
   (`git cat-file -e 9ddad27bc056e1715118dda8b04962108659d31b^{commit}` succeeding or failing).

## On a mismatch

**A mismatch is a valid, wanted result — report it honestly.** This task is deliberately
designed to detect a stale runtime checkout. Do **not** correct it, do **not** fetch or
check out the assigned commit, and do **not** create a worktree. Just report what is
actually there. Silently correcting a mismatch would destroy the only evidence this task
exists to collect.

## Output format

Reply with a short plain-text report using the four headings above. No code changes, no
diffs, no files written.
