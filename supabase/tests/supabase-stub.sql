-- Stand-ins for what a Supabase project provides, so the migrations and
-- supabase/tests/referee.sql can run against a plain PostgreSQL 16 database.
-- Loaded into each test database by tests/pg.ts.

-- Roles belong to the whole cluster, so an earlier test database may have made
-- them, or a test file running in parallel may be making them right now: both
-- can pass the exists check, and the loser then fails with a unique violation.
do $$
declare
  r record;
begin
  for r in select * from (values ('anon', 'nologin'), ('authenticated', 'nologin'), ('service_role', 'nologin bypassrls')) as t(name, options) loop
    begin
      if not exists (select from pg_roles where rolname = r.name) then
        execute format('create role %I %s', r.name, r.options);
      end if;
    exception when duplicate_object or unique_violation then null;
    end;
    begin
      execute format('grant %I to current_user', r.name);
    exception when unique_violation then null;
    end;
  end loop;
end $$;

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
