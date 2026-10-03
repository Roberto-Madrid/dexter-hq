-- Core records. Every table carries owner_id and an owner-only policy.

create type public.request_status as enum (
  'queued', 'running', 'needs_you', 'blocked', 'paused',
  'verifying', 'ready_for_review', 'done', 'failed', 'cancelled'
);

create type public.task_status as enum (
  'queued', 'leased', 'working', 'blocked', 'in_review', 'done', 'failed', 'gave_up'
);

create table public.requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  goal text not null,
  crew text not null,
  tier text not null,
  plan_version int not null default 1,
  definition_of_done text not null,
  status public.request_status not null default 'queued',
  priority int not null default 0,
  permissions_profile text not null default 'green',
  caps jsonb not null default '{}'::jsonb,
  project_id uuid,
  sketch_hash text,
  created_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  request_id uuid not null references public.requests (id),
  persona text not null,
  role text not null,
  dependencies uuid[] not null default '{}',
  expected_artifact text,
  cap jsonb not null default '{}'::jsonb,
  state public.task_status not null default 'queued',
  retries_left int not null default 1,
  priority int not null default 0,
  last_checkpoint jsonb,
  requires_design_approval boolean not null default false,
  lease_generation bigint not null default 0,
  leased_until timestamptz,
  created_at timestamptz not null default now()
);

create index tasks_ready on public.tasks (owner_id, state, priority, created_at);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  task_id uuid not null references public.tasks (id),
  runtime text not null,
  model_row_id uuid,
  lease_generation bigint not null default 0,
  receipt jsonb,
  heartbeat timestamptz,
  status text not null,
  usage jsonb not null default '{}'::jsonb,
  checkpoint_token text,
  created_at timestamptz not null default now()
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  type text not null,
  author text not null,
  signature text,
  task_id uuid,
  confidence numeric,
  evidence jsonb not null default '[]'::jsonb,
  verified_by text,
  expires_at timestamptz,
  status text,
  created_at timestamptz not null default now()
);

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  type text not null,
  content_hash text not null,
  location text not null,
  producer text not null,
  version_or_commit text,
  created_at timestamptz not null default now()
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  request_id uuid references public.requests (id),
  action text not null,
  target text not null,
  plan_version int not null,
  sketch_hash text,
  approved_at timestamptz not null default now()
);

create table public.memory_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  scope text not null check (scope in ('owner', 'project', 'mission')),
  project_id uuid,
  request_id uuid,
  fact text not null,
  provenance text not null,
  validity text,
  supersedes uuid
);

create table public.capabilities (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null,
  operations jsonb not null default '[]'::jsonb,
  permission_class text not null,
  needs_approval boolean not null default false,
  availability text not null,
  schema_version int not null default 1
);

create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  request_id uuid,
  cron text not null,
  enabled boolean not null default true,
  next_at timestamptz
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  request_id uuid,
  role text not null,
  body text not null,
  at timestamptz not null default now()
);

create table public.control (
  owner_id uuid primary key,
  stop_all boolean not null default false,
  slot_cap int not null default 3 check (slot_cap >= 0),
  active_slots int not null default 0 check (active_slots >= 0)
);

create function public.apply_owner_policy(p_table text)
returns void
language plpgsql
as $$
begin
  execute format('alter table public.%I enable row level security', p_table);
  execute format('drop policy if exists owner_isolation on public.%I', p_table);
  execute format(
    'create policy owner_isolation on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
    p_table
  );
  execute format('revoke all on table public.%I from public, anon', p_table);
  execute format(
    'grant select, insert, update, delete on table public.%I to authenticated, service_role',
    p_table
  );
end;
$$;

revoke all on function public.apply_owner_policy(text) from public;

select public.apply_owner_policy('requests');
select public.apply_owner_policy('tasks');
select public.apply_owner_policy('runs');
select public.apply_owner_policy('posts');
select public.apply_owner_policy('artifacts');
select public.apply_owner_policy('approvals');
select public.apply_owner_policy('memory_items');
select public.apply_owner_policy('capabilities');
select public.apply_owner_policy('schedules');
select public.apply_owner_policy('messages');
select public.apply_owner_policy('control');
