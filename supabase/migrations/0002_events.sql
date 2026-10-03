-- Append-only audit log. Updates and deletes are revoked and rejected by trigger.

create table public.events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  actor text not null,
  action text not null,
  target text not null,
  result jsonb,
  usage jsonb,
  approval_id uuid,
  at timestamptz not null default now()
);

create index events_owner_at on public.events (owner_id, at);

select public.apply_owner_policy('events');

revoke insert, update, delete, truncate on table public.events from authenticated, service_role, anon, public;

create function public.reject_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'events_append_only';
end;
$$;

create trigger events_append_only
  before update or delete on public.events
  for each row execute function public.reject_event_mutation();

revoke all on function public.reject_event_mutation() from public;
