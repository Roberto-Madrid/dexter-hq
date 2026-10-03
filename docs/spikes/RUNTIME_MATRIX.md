# G1 runtime matrix

Path B. GitHub Models was not called. `config/dispatch-policy.json` was not changed.

| Adapter | Start | Status | Cancel | Collect | Usage | Auth persistence | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tick | cron `* * * * *` calls the edge function with the vault token | pg_net 200 | n/a | eight heartbeats about 60s apart | n/a | token stays in vault | `.agent-work/evidence/G1/tick-heartbeats.json`, `cron-purge.json` |
| cursor-cloud | client `agentId`, HTTP 201 | run read | `CANCELLED` | `artifacts/spike.txt` downloaded, 2 bytes `ok` | HTTP 200, one run | API key, not printed | `.agent-work/evidence/G1/cursor-lifecycle.json` |
| gh-runner Codex | workflow `dexter-<id>` | `success` | a script run reached `cancelled` | dossier downloaded and schema-valid | ChatGPT login, not an API key | refreshed login decrypts with the age key; log secret hits 0 | `.agent-work/evidence/G1/runner.log`, `runner/dossier.json` |
| Checker | workflow `checker-<id>` | round 2 `success` | n/a | `checker.png` | no model | none | `.agent-work/evidence/G1/runner/checker-r2.json` |
| CEO path B | local test route streams Codex | medium reply `pong` | n/a | low-reasoning JSON `kind=question` | first token 3727 ms; login status ChatGPT | ciphertext in vault secret `codex_chatgpt_auth` | `.agent-work/evidence/G1/ceo-path.json` |
| Sketch | no-repo Cursor agent | `FINISHED` | n/a | `wireframe.html` | n/a | n/a | `.agent-work/evidence/G1/sketch/` |

Cursor families, standard variants only: grok-4.7, composer-2.5, claude-opus-5-5, gpt-5.6-sol. The ChatGPT plan's latest GPT Sol, used by the CEO path, is gpt-6.1-sol. Fast, Max, and preview were excluded.

Install commands recorded from the tested workflow: `npm i -g @openai/codex`, `sudo apt-get install -y age`, `npm install @playwright/test@1.55.0` then `npx playwright install --with-deps chromium`. Key variable names: `CODEX_AUTH_JSON_B64` (secret, attested, not read), `DEXTER_HQ_AGE_PUBLIC_KEY` (public; the workflow falls back to committed `age.pub` because the token cannot set Actions variables), `DEXTER_CALLBACK_SECRET`, `TARGET_READ_TOKEN`, `TARGET_WRITE_TOKEN`, `DEXTER_HQ_URL`.

The sketch fallback is `sketch/screenshot.sh` on `dexter-workers`. It was not needed: Cursor rendered, and local Chrome wrote 390×844 and 1440×900.

A failing adapter was not left enabled. The retired GitHub Models row is gone from v1.4 and was not retried.
