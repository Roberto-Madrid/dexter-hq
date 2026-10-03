-- Spike extensions for the V5 tick. Idempotent.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;
create extension if not exists pgcrypto with schema extensions;
