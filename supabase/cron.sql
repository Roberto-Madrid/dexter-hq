-- Schedules only. The token stays inside the database.
do $$
declare
  existing bigint;
begin
  select jobid into existing from cron.job where jobname = 'spike-tick';
  if existing is not null then
    perform cron.unschedule(existing);
  end if;
end
$$;

select cron.schedule(
  'spike-tick',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://pfzqvzuswavwutnmndvy.supabase.co/functions/v1/tick',
    body := jsonb_build_object(
      'token',
      (select decrypted_secret from vault.decrypted_secrets where name = 'tick_token' limit 1)
    ),
    params := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cron$
);

do $$
declare
  existing bigint;
begin
  select jobid into existing from cron.job where jobname = 'cron-history-purge';
  if existing is not null then
    perform cron.unschedule(existing);
  end if;
end
$$;

select cron.schedule(
  'cron-history-purge',
  '0 4 * * 0',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$
);
