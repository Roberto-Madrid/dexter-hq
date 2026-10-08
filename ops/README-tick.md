# Production tick

pg_cron job `spike-tick` (`supabase/cron.sql`) posts the vault `tick_token` to the `tick` Edge Function every minute.
The function records a heartbeat (`public.spike_heartbeats`) and forwards the token to `POST /api/tick-now`, which runs
reconcile -> fleet -> pins -> selftest -> job scan -> upgrade. Nothing else calls the tick (no Vercel cron, no Actions schedule).

Owner setup (once, and again whenever `supabase/functions/tick/**` changes):

1. Deploy the function from this repo: `supabase functions deploy tick --no-verify-jwt --project-ref <ref>`.
2. Edge Function secret `DEXTER_HQ_URL` = the production HQ origin (no trailing slash):
   `supabase secrets set DEXTER_HQ_URL=https://<hq-host> --project-ref <ref>`.
3. Vercel Production env `DEXTER_TICK_SECRET` must equal the vault secret `tick_token`; redeploy after changing it.
4. Optional: re-run `supabase/cron.sql` so pg_net waits 30 s and keeps HQ's answer for slow ticks.

Check (read-only): `select status_code, timed_out, content, created from net._http_response order by created desc limit 5;`
Each row's JSON carries `hq`: `200` means HQ ran; `401` means the secrets differ; `"not_configured"` means step 2 is
missing; no `hq` field at all means an old function is deployed (step 1).
