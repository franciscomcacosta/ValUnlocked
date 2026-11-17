-- Unpaid orders now hold their account for 5 minutes instead of 3 hours.
-- Safe to run more than once.
create or replace function expire_stale_orders(p_older_than interval default interval '5 minutes')
returns integer language plpgsql as $$
declare r record; n integer := 0;
begin
  for r in select id, user_id, credit_used_cents from orders
            where status in ('pending', 'waiting') and created_at < now() - p_older_than
            for update skip locked
  loop
    update orders set status = 'expired' where id = r.id;
    perform release_inventory(r.id);
    perform release_qvsp_stock(r.id);
    if r.credit_used_cents > 0 then
      perform add_credit(r.user_id, r.credit_used_cents, 'order_expired', r.id);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;
