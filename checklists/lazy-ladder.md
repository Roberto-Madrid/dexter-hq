# Lazy ladder

Use this before writing code. Stop at the first rung that already does the job.

1. Does this need to exist at all?
2. Does this repository already have it?
3. Does the language standard library or the host platform already do it?
4. Does a dependency this repo already installs do it?
5. Can it be one line?
6. Only then write the smallest change that solves it.

When a rung is a shortcut with a known limit, leave a comment:

`dexter-shortcut: <the limit>; upgrade path: <what should replace it>`

A later pass collects those comments into a debt list on the demo card. Do not widen the shortcut in the same change.

This ladder is restated for Dexter. It is not upstream source. Idea from ponytail (MIT, © 2026 DietrichGebert), pin `e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156`. See `docs/THIRD_PARTY.md`.
