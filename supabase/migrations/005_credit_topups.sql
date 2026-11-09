-- Credit top-ups paid through NowPayments. The invoice order_id is
-- "topup_<id>"; the IPN handler calls apply_topup() when paid.
create table if not exists topup_invoices (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id),
  tier           text not null,
  pay_cents      integer not null check (pay_cents > 0),
  bonus_cents    integer not null default 0 check (bonus_cents >= 0),
  currency       text not null default 'eur',
  np_invoice_id  text,
  np_payment_id  text,
  np_status      text,
  created_at     timestamptz not null default now(),
  credited_at    timestamptz
);
create index if not exists topup_invoices_user_idx on topup_invoices (user_id);
alter table topup_invoices enable row level security;

-- Credits a paid top-up exactly once (duplicate IPNs return 0 and do
-- nothing). Returns the cents credited (paid + bonus).
create or replace function apply_topup(p_id uuid)
returns integer language plpgsql as $$
declare
  v_user  uuid;
  v_total integer;
begin
  update topup_invoices
     set credited_at = now()
   where id = p_id and credited_at is null
  returning user_id, pay_cents + bonus_cents into v_user, v_total;
  if not found then
    return 0;
  end if;
  perform add_credit(v_user, v_total, 'topup', null);
  return v_total;
end $$;
