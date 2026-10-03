-- Claim, transition, and lease renewal. A failed transition raises before any event insert.

create function public.task_transition_allowed(p_from public.task_status, p_to public.task_status)
returns boolean
language sql
immutable
as $$
  select (p_from, p_to) in (
    ('queued', 'leased'),
    ('queued', 'blocked'),
    ('queued', 'failed'),
    ('queued', 'gave_up'),
    ('leased', 'working'),
    ('leased', 'queued'),
    ('leased', 'blocked'),
    ('leased', 'failed'),
    ('leased', 'gave_up'),
    ('working', 'in_review'),
    ('working', 'blocked'),
    ('working', 'failed'),
    ('working', 'gave_up'),
    ('in_review', 'done'),
    ('in_review', 'working'),
    ('in_review', 'failed'),
    ('in_review', 'gave_up'),
    ('blocked', 'queued'),
    ('blocked', 'failed'),
    ('blocked', 'gave_up')
  );
$$;

create function public.claim_ready_tasks(p_limit int)
returns setof public.tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_stop boolean;
  v_cap int;
  v_active int;
  v_room int;
begin
  if v_owner is null then
    raise exception 'no_owner';
  end if;
  if p_limit is null or p_limit < 1 then
    return;
  end if;

  insert into public.control (owner_id) values (v_owner) on conflict (owner_id) do nothing;
  select stop_all, slot_cap into v_stop, v_cap
  from public.control
  where owner_id = v_owner
  for update;

  if v_stop then
    return;
  end if;

  select count(*)::int into v_active
  from public.tasks
  where owner_id = v_owner and state in ('leased', 'working');

  v_room := least(p_limit, greatest(v_cap - v_active, 0));
  if v_room < 1 then
    return;
  end if;

  return query
  with picked as (
    select t.id
    from public.tasks t
    where t.owner_id = v_owner
      and t.state = 'queued'
      and not exists (
        select 1
        from unnest(t.dependencies) as dep(id)
        where not exists (
          select 1 from public.tasks d
          where d.id = dep.id and d.owner_id = t.owner_id and d.state = 'done'
        )
      )
      and (
        t.requires_design_approval = false
        or exists (
          select 1
          from public.approvals a
          join public.requests r on r.id = t.request_id and r.owner_id = t.owner_id
          where a.owner_id = t.owner_id
            and a.request_id = t.request_id
            and a.action = 'design'
            and a.plan_version = r.plan_version
            and a.sketch_hash is not null
            and r.sketch_hash is not null
            and a.sketch_hash = r.sketch_hash
        )
      )
    order by t.priority, t.created_at, t.id
    for update skip locked
    limit v_room
  ),
  updated as (
    update public.tasks t
    set state = 'leased',
        lease_generation = t.lease_generation + 1,
        leased_until = now() + interval '5 minutes'
    from picked
    where t.id = picked.id
    returning t.*
  ),
  logged as (
    insert into public.events (owner_id, actor, action, target, result)
    select u.owner_id, 'kernel', 'task.claim', u.id::text,
           jsonb_build_object('from', 'queued', 'to', 'leased', 'generation', u.lease_generation)
    from updated u
    returning id
  )
  select u.*
  from updated u
  where (select count(*) from logged) >= 0;
end;
$$;

create function public.transition_task(
  p_task_id uuid,
  p_expected_generation bigint,
  p_to text,
  p_actor text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_task public.tasks%rowtype;
  v_to public.task_status;
  v_event uuid;
  v_cap int;
  v_active int;
  v_updated int;
begin
  if v_owner is null then
    raise exception 'no_owner';
  end if;
  if p_expected_generation is null then
    raise exception 'stale_generation';
  end if;

  begin
    v_to := p_to::public.task_status;
  exception
    when invalid_text_representation then
      raise exception 'illegal_transition';
  end;

  insert into public.control (owner_id) values (v_owner) on conflict (owner_id) do nothing;
  select slot_cap into v_cap
  from public.control
  where owner_id = v_owner
  for update;

  select * into v_task
  from public.tasks
  where id = p_task_id and owner_id = v_owner
  for update;

  if not found then
    raise exception 'missing_task';
  end if;
  if v_task.lease_generation is distinct from p_expected_generation then
    raise exception 'stale_generation';
  end if;
  if not public.task_transition_allowed(v_task.state, v_to) then
    raise exception 'illegal_transition';
  end if;
  if v_to in ('leased', 'working') and v_task.state not in ('leased', 'working') then
    select count(*)::int into v_active
    from public.tasks
    where owner_id = v_owner and state in ('leased', 'working');
    if v_active >= v_cap then
      raise exception 'slot_cap';
    end if;
  end if;

  update public.tasks
  set state = v_to,
      lease_generation = lease_generation + 1,
      leased_until = case
        when v_to in ('leased', 'working') then coalesce(leased_until, now() + interval '5 minutes')
        else null
      end
  where id = p_task_id and lease_generation = p_expected_generation;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'stale_generation';
  end if;

  insert into public.events (owner_id, actor, action, target, result)
  values (
    v_owner,
    coalesce(p_actor, 'kernel'),
    'task.transition',
    p_task_id::text,
    jsonb_build_object('from', v_task.state, 'to', v_to, 'generation', p_expected_generation)
  )
  returning id into v_event;

  return v_event;
end;
$$;

create function public.renew_lease(p_task_id uuid, p_expected_generation bigint)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_until timestamptz;
begin
  if v_owner is null then
    raise exception 'no_owner';
  end if;

  update public.tasks
  set leased_until = now() + interval '5 minutes'
  where id = p_task_id
    and owner_id = v_owner
    and lease_generation = p_expected_generation
    and state in ('leased', 'working')
  returning leased_until into v_until;

  if v_until is null then
    raise exception 'stale_generation';
  end if;
  return v_until;
end;
$$;

create function public.reject_direct_task_control()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon', 'service_role')
     and (
       new.state is distinct from old.state
       or new.lease_generation is distinct from old.lease_generation
       or new.leased_until is distinct from old.leased_until
     ) then
    raise exception 'direct_task_mutation';
  end if;
  return new;
end;
$$;

create trigger tasks_control_columns
  before update on public.tasks
  for each row execute function public.reject_direct_task_control();

revoke all on function public.reject_direct_task_control() from public;

revoke all on function public.task_transition_allowed(public.task_status, public.task_status) from public;
revoke all on function public.claim_ready_tasks(int) from public;
revoke all on function public.transition_task(uuid, bigint, text, text) from public;
revoke all on function public.renew_lease(uuid, bigint) from public;

grant execute on function public.task_transition_allowed(public.task_status, public.task_status) to authenticated, service_role;
grant execute on function public.claim_ready_tasks(int) to authenticated, service_role;
grant execute on function public.transition_task(uuid, bigint, text, text) to authenticated, service_role;
grant execute on function public.renew_lease(uuid, bigint) to authenticated, service_role;
