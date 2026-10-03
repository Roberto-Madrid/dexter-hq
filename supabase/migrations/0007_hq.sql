-- Isolated HQ snapshot. Does not alter the existing public tables.
create schema if not exists dexter_hq;

create table if not exists dexter_hq.snapshot (
  id int primary key,
  body jsonb not null,
  updated_at timestamptz not null default now()
);

alter table dexter_hq.snapshot enable row level security;
revoke all on table dexter_hq.snapshot from public, anon, authenticated;
grant select, insert, update, delete on table dexter_hq.snapshot to service_role;
