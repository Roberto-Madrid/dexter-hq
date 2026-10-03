-- Sandbox slot reservation. The counter moves only when the row is under the cap.

create function public.reserve_slot()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_slots int;
begin
  if v_owner is null then
    raise exception 'no_owner';
  end if;

  insert into public.control (owner_id) values (v_owner) on conflict (owner_id) do nothing;

  update public.control
  set active_slots = active_slots + 1
  where owner_id = v_owner
    and stop_all = false
    and active_slots < slot_cap
  returning active_slots into v_slots;

  return v_slots is not null;
end;
$$;

create function public.release_slot()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_slots int;
begin
  if v_owner is null then
    raise exception 'no_owner';
  end if;

  update public.control
  set active_slots = active_slots - 1
  where owner_id = v_owner and active_slots > 0
  returning active_slots into v_slots;

  return coalesce(v_slots, 0);
end;
$$;

revoke all on function public.reserve_slot() from public;
revoke all on function public.release_slot() from public;
grant execute on function public.reserve_slot() to authenticated, service_role;
grant execute on function public.release_slot() to authenticated, service_role;
