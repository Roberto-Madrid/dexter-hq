# Document the sample

Add `README.md` with a title, one sentence saying what this sample is for (a small site the checks build, lint, and screenshot), and a "Commands" list naming `node build.js` and `node lint.js` with one line each on what they do.

Work only in this repository. Create a new branch named `{{branch}}`, commit there, and push the branch. Do not open a pull request and do not change the default branch. Keep the change small and touch only the files named here.

Done-command: `node lint.js && node build.js && grep -q 'node build.js' README.md && grep -q 'node lint.js' README.md`
