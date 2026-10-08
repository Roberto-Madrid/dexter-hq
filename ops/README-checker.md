# Checker workflow

`workers/.github/workflows/checker.yml` is HQ's copy of `checker.yml` in the workers repo (`GH_WORKERS_REPO`). HQ
(`hq/checker.ts`) dispatches it from the workers `main` ref with `target_repo`, `target_sha`, and `nonce`, finds the run by
its run-name `dexter-checker <repo> <sha> <nonce>`, and treats only a completed `success` as "build, lint, playwright
passed". Changes land here first, then get copied to the workers repo. Pushing a workflow file there needs a token with
the `workflow` scope.

What a run does with the target, checked out at `target_sha` into `subject/`:

- Root `package.json`: `npm ci` (or `npm install` when there is no lockfile). Then `build`, `lint`, and `test` run when
  each script exists, after installing Playwright's Chromium when the target depends on `@playwright/test`.
- No `package.json`, but `build.js` / `lint.js` / `playwright.config.*` (the checker-sample layout): run those, installing
  `@playwright/test@1.55.0` and Chromium for the test.
- A check with nothing to run reports `n/a`. The final Verdict step writes a build/lint/playwright table to the job
  summary and fails the run unless all three passed, so `n/a`, `fail`, and `not run` never count as a pass. A target with
  none of the files above fails with "Checker not applicable".
- Screenshots under `shots/` or `test-results/` are uploaded as artifact `dexter-checker-<nonce>` (7 days).

Owner setup (once, in the workers repo, Settings -> Secrets and variables -> Actions):

1. Repository secret `CHECKER_READ_TOKEN`: a fine-grained token with read-only **Contents** on the venture repos the
   Checker should read (for example `dexter-hq`). Without it the checkout falls back to the run's own `github.token`,
   which can read only the workers repo and public repos. The token is used by the checkout step alone and is not
   persisted, so the target's own scripts never see it.
