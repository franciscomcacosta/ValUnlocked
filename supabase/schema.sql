-- Valorant shop schema (Supabase / Postgres)
-- Run in the Supabase SQL editor. All access goes through the service-role key
-- on the server; RLS is enabled with no public policies so the anon key can read nothing.

create extension if not exists pgcrypto;

-- Users (identified by Discord) -------------------------------------------
create table users (
  id               uuid primary key default gen_random_uuid(),
  discord_id       text unique not null,
  discord_username text,
  credit_cents     integer not null default 0 check (credit_cents >= 0),
  created_at       timestamptz not null default now()
);

-- Products (a listing type, e.g. "EU Plat smurf") --------------------------
create table products (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null,
  name         text not null,
  region       text not null,            -- EU, NA, AP...
  rank         text,                     -- Unranked, Iron, Plat...
  description  text,
  price_cents  integer not null check (price_cents > 0),
  currency     text not null default 'eur',
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Inventory (one row per physical account; all full access) ----------------
create type inventory_source as enum ('own', 'bought');
create type inventory_status as enum ('available', 'reserved', 'sold', 'removed');

create table inventory (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references products(id),
  source              inventory_source not null,
  acquired_from       text,              -- for 'bought': who sold it to you (original owner)
  cost_cents          integer,           -- what you paid, for margin tracking
  -- credentials, AES-256-GCM encrypted by lib/crypto.ts (never store plaintext)
  login_enc           text not null,
  password_enc        text not null,
  email_enc           text not null,
  email_password_enc  text not null,
  notes               text,
  status              inventory_status not null default 'available',
  reserved_order_id   uuid,
  reserved_at         timestamptz,
  created_at          timestamptz not null default now()
);
create index inventory_available_idx on inventory (product_id) where status = 'available';

-- Orders --------------------------------------------------------------------
create type order_status as enum (
  'pending',          -- created, invoice not yet paid
  'waiting', 'confirming', 'confirmed', 'sending',
  'partially_paid',   -- needs manual handling in a ticket
  'paid',             -- payment final, fulfilment in progress
  'fulfilled',        -- credentials delivered
  'expired', 'failed',
  'refunded_credit',  -- refunded as store credit
  'cancelled'
);

create table orders (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id),
  product_id         uuid not null references products(id),
  inventory_id       uuid references inventory(id),
  price_cents        integer not null,
  credit_used_cents  integer not null default 0,
  charge_cents       integer not null,          -- price - credit (what crypto must cover)
  currency           text not null,
  status             order_status not null default 'pending',
  np_invoice_id      text,
  np_payment_id      text unique,
  np_status          text,
  pay_currency       text,
  actually_paid      numeric,
  created_at         timestamptz not null default now(),
  paid_at            timestamptz,
  fulfilled_at       timestamptz
);
create index orders_user_idx on orders (user_id);

-- Store credit ledger (every balance change is recorded) --------------------
create table credit_ledger (
  id          bigserial primary key,
  user_id     uuid not null references users(id),
  delta_cents integer not null,
  reason      text not null,       -- 'checkout', 'order_expired', 'refund', 'manual'
  order_id    uuid references orders(id),
  created_at  timestamptz not null default now()
);

-- Raw IPN log for audits / disputes -----------------------------------------
create table ipn_events (
  id             bigserial primary key,
  payment_id     text,
  payment_status text,
  payload        jsonb not null,
  received_at    timestamptz not null default now()
);

alter table users         enable row level security;
alter table products      enable row level security;
alter table inventory     enable row level security;
alter table orders        enable row level security;
alter table credit_ledger enable row level security;
alter table ipn_events    enable row level security;

-- Functions -----------------------------------------------------------------

-- Atomically reserve one available account for an order.
-- SKIP LOCKED means two simultaneous checkouts never get the same account.
create or replace function reserve_inventory(p_order_id uuid, p_product_id uuid)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from inventory
   where product_id = p_product_id and status = 'available'
   order by created_at
   limit 1
   for update skip locked;
  if v_id is null then return null; end if;
  update inventory set status = 'reserved', reserved_order_id = p_order_id, reserved_at = now()
   where id = v_id;
  update orders set inventory_id = v_id where id = p_order_id;
  return v_id;
end $$;

-- Put a reserved account back on sale (order expired / failed / cancelled).
create or replace function release_inventory(p_order_id uuid)
returns void language sql as $$
  update inventory set status = 'available', reserved_order_id = null, reserved_at = null
   where reserved_order_id = p_order_id and status = 'reserved';
$$;

-- Spend credit at checkout. Fails (returns false) if the balance is too low.
create or replace function spend_credit(p_user_id uuid, p_cents integer, p_order_id uuid)
returns boolean language plpgsql as $$
begin
  if p_cents <= 0 then return true; end if;
  update users set credit_cents = credit_cents - p_cents
   where id = p_user_id and credit_cents >= p_cents;
  if not found then return false; end if;
  insert into credit_ledger (user_id, delta_cents, reason, order_id)
    values (p_user_id, -p_cents, 'checkout', p_order_id);
  return true;
end $$;

-- Add credit (refunds, expired orders that used credit, manual grants).
create or replace function add_credit(p_user_id uuid, p_cents integer, p_reason text, p_order_id uuid)
returns void language plpgsql as $$
begin
  update users set credit_cents = credit_cents + p_cents where id = p_user_id;
  insert into credit_ledger (user_id, delta_cents, reason, order_id)
    values (p_user_id, p_cents, p_reason, p_order_id);
end $$;

-- Claim an order for fulfilment exactly once. Returns the order id only to the
-- first caller; duplicate IPNs get nothing back and do nothing.
create or replace function claim_order_for_fulfilment(p_order_id uuid)
returns uuid language sql as $$
  update orders set status = 'paid', paid_at = coalesce(paid_at, now())
   where id = p_order_id
     and status not in ('paid', 'fulfilled', 'refunded_credit', 'cancelled')
  returning id;
$$;

-- Release reservations on orders that were never paid (run hourly via pg_cron
-- or a scheduled function). Refunds any credit those orders used.
create or replace function expire_stale_orders(p_older_than interval default interval '3 hours')
returns integer language plpgsql as $$
declare r record; n integer := 0;
begin
  for r in select id, user_id, credit_used_cents from orders
            where status in ('pending', 'waiting') and created_at < now() - p_older_than
            for update skip locked
  loop
    update orders set status = 'expired' where id = r.id;
    perform release_inventory(r.id);
    if r.credit_used_cents > 0 then
      perform add_credit(r.user_id, r.credit_used_cents, 'order_expired', r.id);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Public stock counts for the shop page (no credentials exposed).
create or replace view product_stock as
  select p.id, p.slug, p.name, p.region, p.rank, p.description, p.price_cents, p.currency,
         count(i.id) filter (where i.status = 'available') as in_stock
    from products p left join inventory i on i.product_id = p.id
   where p.active
   group by p.id;
