Owner step missing: give this worker the existing path B ChatGPT login, or run this script where path B already works.

Path B loads the Codex ChatGPT login from Supabase Vault (name `codex_chatgpt_auth`) and decrypts it with `DEXTER_AGE_PRIVATE_KEY`.
Those names already exist on the Vercel preview and in `.env.example`. Do not create a new secret.

This environment is missing: .env.local, SUPABASE_DB_URL, DEXTER_AGE_PRIVATE_KEY.

Re-run `node --experimental-strip-types scripts/prove-council-seat.ts` on the Vercel preview host or a local checkout that already has `.env.local` for path B.
