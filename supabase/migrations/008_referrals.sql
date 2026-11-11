-- Referrals ("Invite friends").
--
-- Every user gets a short code → link valunlock.online/r/<code>.
-- A friend who signs up through it (and hasn't ordered before) is linked
-- to the inviter via users.referred_by. When the friend's FIRST paid order
-- is delivered, both get store credit — exactly once per friend.

alter table users add column if not exists referral_code        text unique;
alter table users add column if not exists referred_by          uuid references users(id);
alter table users add column if not exists referred_at          timestamptz;
alter table users add column if not exists referral_rewarded_at timestamptz;
create index if not exists users_referred_by_idx on users (referred_by);

-- Pays the referral reward for an order, once per referred user.
-- Returns the inviter's user id when a reward was paid, null otherwise.
create or replace function apply_referral_reward(
  p_order_id        uuid,
  p_referrer_cents  integer,
  p_referee_cents   integer,
  p_min_paid_cents  integer
) returns uuid language plpgsql as $$
declare
  v_referee  uuid;
  v_referrer uuid;
  v_paid     integer;
begin
  select o.user_id, u.referred_by, coalesce(o.credit_used_cents, 0) + coalesce(o.charge_cents, 0)
    into v_referee, v_referrer, v_paid
    from orders o
    join users u on u.id = o.user_id
   where o.id = p_order_id
     and o.status = 'fulfilled';
  if v_referrer is null or v_paid < p_min_paid_cents then
    return null;
  end if;

  -- The flag makes this a one-time reward even if called twice.
  update users set referral_rewarded_at = now()
   where id = v_referee and referral_rewarded_at is null;
  if not found then
    return null;
  end if;

  if p_referrer_cents > 0 then
    perform add_credit(v_referrer, p_referrer_cents, 'referral', p_order_id);
  end if;
  if p_referee_cents > 0 then
    perform add_credit(v_referee, p_referee_cents, 'referral_welcome', p_order_id);
  end if;
  return v_referrer;
end $$;

-- Same lock-down as migration 007: only the server (service role) may call it.
revoke execute on function apply_referral_reward(uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function apply_referral_reward(uuid, integer, integer, integer) to service_role;
