-- Stand-ins for what a Supabase project provides, so the migrations and
-- supabase/tests/referee.sql can run against a plain PostgreSQL 16 database.
-- Used only by src/referee-sql.test.ts.

-- Roles belong to the whole cluster, so an earlier test database may have made them.
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant anon, authenticated, service_role to current_user;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
-- Supabase reads the caller from the request's JWT claims; tests set them with set_config.
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), current_user)
$$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create publication supabase_realtime;

grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants API roles everything on new public objects; RLS and the
-- migrations' own revokes narrow it down.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
