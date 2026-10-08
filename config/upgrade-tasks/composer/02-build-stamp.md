# Write a build stamp

Change `build.js` so that, besides `dist/ok.txt`, it also writes `dist/build.json` containing a JSON object with one key, `"files"`, whose value is the number of files the build wrote (2). Keep the `build ok` log line.

Work only in this repository. Create a new branch named `{{branch}}`, commit there, and push the branch. Do not open a pull request and do not change the default branch. Keep the change small and touch only the files named here.

Done-command: `node build.js && node -e "const b=require('./dist/build.json'); if (b.files !== 2) process.exit(1)"`
