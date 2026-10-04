-- Connector bots and hashed tokens. No seed rows. No plaintext secrets.

create table public.bots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null,
  kind text not null check (kind in ('ceo', 'lead', 'scout', 'other')),
  repos text[] not null default '{}',
  tools text[] not null default '{}',
  current_task text,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.bot_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  bot_id uuid not null references public.bots (id) on delete cascade,
  token_hash text not null unique,
  scopes text[] not null default '{}',
  suspended boolean not null default false,
  created_at timestamptz not null default now()
);

create index bot_tokens_bot on public.bot_tokens (bot_id);

create table public.connector_agents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  bot_id uuid not null references public.bots (id) on delete cascade,
  cursor_handle text,
  repo text,
  role text not null,
  family text not null,
  status text not null,
  idempotency_key text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  unique (bot_id, idempotency_key)
);

select public.apply_owner_policy('bots');
select public.apply_owner_policy('bot_tokens');
select public.apply_owner_policy('connector_agents');

create function public.append_event(
  p_owner_id uuid,
  p_actor text,
  p_action text,
  p_target text,
  p_result jsonb default null,
  p_usage jsonb default null,
  p_approval_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.events (owner_id, actor, action, target, result, usage, approval_id)
  values (p_owner_id, p_actor, p_action, p_target, p_result, p_usage, p_approval_id)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.append_event(uuid, text, text, text, jsonb, jsonb, uuid) from public;
grant execute on function public.append_event(uuid, text, text, text, jsonb, jsonb, uuid) to service_role;
