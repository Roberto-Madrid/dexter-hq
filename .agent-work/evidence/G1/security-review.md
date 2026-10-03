# G1 tick security review

Reviewed by the lead. No secret values are in this note.

- `public.spike_heartbeats` has RLS enabled. `anon` and `authenticated` have no table privileges.
- `public.spike_accept_tick` is `security definer` with `search_path = public, vault`. Execute is revoked from `public`, `anon`, and `authenticated`, and granted to `service_role`.
- The function compares the request token to the vault secret named `tick_token` and inserts a heartbeat only on a match. The migration creates that secret inside the database when it is missing. This review did not select the secret.
- Edge function `tick` is ACTIVE, version 1, `verify_jwt` false. The function source does not log the token. It posts the token only to the RPC above, using the platform service-role env vars.
- `spike-tick` runs every minute. Its command was not exported. It builds the request body from the vault secret at runtime.
- `cron-history-purge` is weekly and its command matches the 7-day delete. The seeded proof used command text `seed-old-row` only.
