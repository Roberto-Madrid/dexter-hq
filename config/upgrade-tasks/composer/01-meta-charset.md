# Add a charset declaration

In `index.html`, add `<meta charset="utf-8">` as the first element inside `<head>`. Leave the title and body unchanged.

Work only in this repository. Create a new branch named `{{branch}}`, commit there, and push the branch. Do not open a pull request and do not change the default branch. Keep the change small and touch only the files named here.

Done-command: `node lint.js && node build.js && grep -q 'charset="utf-8"' index.html`
