-- Spike table and the vault check the tick calls.
-- The bearer token is created inside the database and is never selected by a client.

create table if not exists public.spike_heartbeats (
  id bigint generated always as identity primary key,
  beat_at timestamptz not null default now()
);

alter table public.spike_heartbeats enable row level security;

revoke all on table public.spike_heartbeats from anon, authenticated;

create or replace function public.spike_accept_tick(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  expected text;
  new_id bigint;
begin
  select decrypted_secret into expected
  from vault.decrypted_secrets
  where name = 'tick_token'
  limit 1;

  if expected is null or p_token is null or p_token <> expected then
    return jsonb_build_object('ok', false);
  end if;

  insert into public.spike_heartbeats default values
  returning id into new_id;

  return jsonb_build_object('ok', true, 'id', new_id);
end;
$$;

revoke all on function public.spike_accept_tick(text) from public, anon, authenticated;
grant execute on function public.spike_accept_tick(text) to service_role;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'tick_token') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'tick_token',
      'spike tick bearer'
    );
  end if;
end
$$;
