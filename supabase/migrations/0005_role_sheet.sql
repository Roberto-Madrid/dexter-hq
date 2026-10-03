-- Catalog, resolutions, outcomes, and the weekly pool reservation counter.

create table public.model_catalog (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  family text not null,
  version text not null,
  variant text not null,
  price_per_token numeric not null,
  trains_on_prompts boolean not null default false,
  pool text not null,
  available boolean not null default true,
  released_at timestamptz not null default now()
);

create table public.model_resolutions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  family text not null,
  version text not null,
  price_per_token numeric,
  held boolean not null default false,
  reason text,
  resolved_at timestamptz not null default now()
);

create table public.model_outcomes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  run_id uuid,
  model_row_id uuid,
  passed boolean not null,
  checks_failed int not null default 0,
  escalated boolean not null default false,
  at timestamptz not null default now()
);

create table public.pool_usage (
  owner_id uuid not null,
  pool text not null,
  week_start timestamptz not null,
  runs_reserved int not null default 0,
  weekly_cap int not null check (weekly_cap >= 0),
  primary key (owner_id, pool, week_start)
);

select public.apply_owner_policy('model_catalog');
select public.apply_owner_policy('model_resolutions');
select public.apply_owner_policy('model_outcomes');
select public.apply_owner_policy('pool_usage');

create function public.reserve_pool_run(p_pool text, p_cap int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_week timestamptz := date_trunc('week', now());
  v_next int;
begin
  if v_owner is null then
    raise exception 'no_owner';
  end if;
  if p_cap is null or p_cap < 1 then
    return false;
  end if;

  insert into public.pool_usage (owner_id, pool, week_start, runs_reserved, weekly_cap)
  values (v_owner, p_pool, v_week, 0, p_cap)
  on conflict (owner_id, pool, week_start) do nothing;

  update public.pool_usage
  set runs_reserved = runs_reserved + 1
  where owner_id = v_owner
    and pool = p_pool
    and week_start = v_week
    and runs_reserved < weekly_cap
  returning runs_reserved into v_next;

  return v_next is not null;
end;
$$;

revoke all on function public.reserve_pool_run(text, int) from public;
grant execute on function public.reserve_pool_run(text, int) to authenticated, service_role;
