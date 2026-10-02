# G0 verify

Verdict: PASS

| Criterion | Mark | Evidence |
| --- | --- | --- |
| Listed scaffold files exist | verified | `.agent-work/evidence/G0/file-check.txt` |
| `docs/MASTER_PLAN_V5.md` is Appendix A verbatim | verified | byte compare equal (34258 bytes) |
| `AGENTS.md` is Appendix C.1 | verified | byte compare equal |
| `CLAUDE.md` contains only `@AGENTS.md` | verified | file is that line |
| Cursor rule always applied and points at `AGENTS.md` | verified | `.cursor/rules/dexter.mdc` has `alwaysApply: true` |
| `git diff --name-status` against `main` shows no deletions | verified | staged diff in `.agent-work/evidence/G0/git-diff-name-status-staged.txt` has zero `D` lines. Post-commit `main...HEAD` is re-run and saved as `git-diff-name-status.txt`. |
| `AUDIT.md` works-today cells | verified | table parse found 0 empty cells |
| Checklists contain no copied third-party code | verified | original prose, zero fenced code blocks, pins only in `docs/THIRD_PARTY.md` |
| Secret scan clean | verified | `.agent-work/evidence/G0/secret-scan.txt` verdict `clean`, unclassified 0. No values printed. |
| Existing install / build / test | verified | No install and no build script (recorded). `npm test` 72 pass, 0 fail. |
| §10 scripts (`typecheck`, `lint`, `check:vendor`, …) | not in repo until G2 | Plan §10 says G0 runs the repo's existing tests plus a secret scan. Those scripts are not invented here. |

Lanes: L1 verified, L2 verified. No fix round.
