# Add a build check script

Add `check.js` that exits 1 unless `dist/ok.txt` exists and contains exactly `ok` followed by a newline, and prints `check ok` when it passes. Do not change `build.js`.

Work only in this repository. Create a new branch named `{{branch}}`, commit there, and push the branch. Do not open a pull request and do not change the default branch. Keep the change small and touch only the files named here.

Done-command: `node build.js && node check.js`
