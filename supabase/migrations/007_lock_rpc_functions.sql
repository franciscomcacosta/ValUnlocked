-- Defence in depth for live updates: the browser now uses the public
-- (publishable) key to listen to the "stock" broadcast channel. All tables
-- already have RLS with no public policies, and these functions run as the
-- caller, so the public key can't change anything — this removes the
-- public roles' ability to even call them. The site's server uses the
-- service role, which keeps full access.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- Functions created later also default to no public execute.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
