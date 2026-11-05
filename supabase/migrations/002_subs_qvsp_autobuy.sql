-- 002: Subscriptions, QVSP live stock, Ultra auto-buy.
-- Non-breaking: extends existing schema. Run in Supabase SQL editor.

-- QVSP as a third source alongside own/bought ----------------------------
alter type inventory_source add value if not exists 'qvsp';

-- Subscription tiers -----------------------------------------------------
create type sub_tier as enum ('standard', 'premium', 'ultra');
create type sub_status as enum ('active', 'grace', 'expired', 'cancelled');

create table subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  tier                sub_tier not null,
  status              sub_status not null default 'active',
  period_start        timestamptz not null default now(),
  period_end          timestamptz not null,       -- strict cutoff
  grace_until         timestamptz,                -- period_end + 48h
  current_invoice_id  text,                        -- active renewal invoice (nowpayments)
  reminded_7d         boolean not null default false,
  reminded_3d         boolean not null default false,
  reminded_1d         boolean not null default false,
  created_at          timestamptz not null default now(),
  cancelled_at        timestamptz
);
create unique index subscriptions_active_per_user on subscriptions (user_id)
  where status in ('active', 'grace');
create index subscriptions_period_end_idx on subscriptions (period_end)
  where status in ('active', 'grace');

-- Subscription invoices (initial + each renewal) --------------------------
create table sub_invoices (
  id               uuid primary key default gen_random_uuid(),
  subscription_id  uuid references subscriptions(id) on delete set null,
  user_id          uuid not null references users(id),
  tier             sub_tier not null,
  amount_cents     integer not null,
  currency         text not null default 'eur',
  np_invoice_id    text,
  np_payment_id    text unique,
  np_status        text,
  purpose          text not null,        -- 'initial' | 'renewal'
  created_at       timestamptz not null default now(),
  paid_at          timestamptz
);
create index sub_invoices_user_idx on sub_invoices (user_id);

-- QVSP live stock mirror --------------------------------------------------
-- Synced from qvsp /stock every ~2 min. We don't pre-buy: a row here is
-- an *offer* we can resell. On customer checkout we reserve (15 min lock),
-- then post-payment we call qvsp POST /orders and materialize an inventory row.
create table qvsp_stock (
  qvsp_id             text primary key,         -- their stock id
  kind                text not null,            -- 'skinned' | 'ranked'
  region              text not null,            -- EU | AP | KR | LATAM | BR
  level               integer,
  peak                text,
  rank                text,
  rank_normalized     text,                     -- normalized lowercase e.g. "platinum 2"
  qvsp_price_cents    integer not null,         -- what they charge us
  public_price_cents  integer not null,         -- what we charge (pricing.ts bracket)
  skin_count          integer not null default 0,
  skins               text[] not null default '{}',
  buddies             text[] not null default '{}',
  vp                  integer,
  vp_value_cents      integer,
  last_played         text,
  added_epoch         bigint,
  reserved_order_id   uuid,
  reserved_at         timestamptz,
  claimed             boolean not null default false,  -- true once qvsp /orders succeeded
  claimed_order_id    uuid,
  first_seen_at       timestamptz not null default now(),
  public_at           timestamptz not null default (now() + interval '2 hours'),
  last_synced_at      timestamptz not null default now(),
  removed_at          timestamptz                       -- set when qvsp no longer lists it
);
create index qvsp_stock_available_idx on qvsp_stock (region, kind, public_price_cents)
  where reserved_order_id is null and claimed = false and removed_at is null;
create index qvsp_stock_public_idx on qvsp_stock (public_at)
  where reserved_order_id is null and claimed = false and removed_at is null;

-- Snipe filters (Premium + Ultra) -----------------------------------------
create table snipe_filters (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  name           text,
  regions        text[] not null default '{}',   -- empty = any
  kinds          text[] not null default '{}',
  min_skins      integer,
  max_price_cents integer,
  min_level      integer,
  min_peak       text,
  required_skins text[] not null default '{}',
  active         boolean not null default true,
  last_fired_at  timestamptz,
  created_at     timestamptz not null default now()
);
create index snipe_filters_user_idx on snipe_filters (user_id) where active;

-- Ultra auto-buy configs --------------------------------------------------
create table autobuy_configs (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users(id) on delete cascade,
  name                 text,
  active               boolean not null default true,
  regions              text[] not null default '{}',
  kinds                text[] not null default '{}',
  min_skins            integer,
  max_price_cents      integer not null,         -- max we'll spend per account (after discount)
  min_level            integer,
  min_peak             text,
  required_skins       text[] not null default '{}',
  max_buys_per_day     integer not null default 5 check (max_buys_per_day between 1 and 20),
  min_credit_cents     integer not null default 5000,  -- pause when credit < this
  bought_today         integer not null default 0,
  bought_today_date    date not null default current_date,
  last_fired_at        timestamptz,
  created_at           timestamptz not null default now()
);
create index autobuy_configs_active_idx on autobuy_configs (user_id) where active;

-- Round-robin counter: tracks which Ultra user gets the next match per
-- (region, kind) bucket so no one user hoovers everything.
create table autobuy_rr_cursor (
  bucket    text primary key,       -- e.g. 'eu:skinned'
  last_user uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Auto-buy audit log ------------------------------------------------------
create table autobuy_log (
  id            bigserial primary key,
  config_id     uuid references autobuy_configs(id) on delete set null,
  user_id       uuid references users(id) on delete set null,
  qvsp_id       text,
  order_id      uuid references orders(id) on delete set null,
  outcome       text not null,       -- 'bought' | 'skipped_cap' | 'skipped_credit' | 'qvsp_failed' | 'lost_race'
  detail        text,
  created_at    timestamptz not null default now()
);
create index autobuy_log_user_idx on autobuy_log (user_id, created_at desc);

-- RLS on new tables (service-role only, no public policies) --------------
alter table subscriptions    enable row level security;
alter table sub_invoices     enable row level security;
alter table qvsp_stock       enable row level security;
alter table snipe_filters    enable row level security;
alter table autobuy_configs  enable row level security;
alter table autobuy_rr_cursor enable row level security;
alter table autobuy_log      enable row level security;

-- Functions --------------------------------------------------------------

-- Reserve a qvsp stock row for an order. Same SKIP LOCKED pattern as
-- reserve_inventory, but hits qvsp_stock. Called by checkout when the
-- user picked a specific qvsp listing. Returns the qvsp_id or null.
create or replace function reserve_qvsp_stock(p_order_id uuid, p_qvsp_id text)
returns text language plpgsql as $$
declare v_id text;
begin
  select qvsp_id into v_id from qvsp_stock
   where qvsp_id = p_qvsp_id
     and reserved_order_id is null
     and claimed = false
     and removed_at is null
   for update skip locked;
  if v_id is null then return null; end if;
  update qvsp_stock
     set reserved_order_id = p_order_id, reserved_at = now()
   where qvsp_id = v_id;
  return v_id;
end $$;

-- Release a qvsp reservation (order expired/failed/cancelled).
create or replace function release_qvsp_stock(p_order_id uuid)
returns void language sql as $$
  update qvsp_stock set reserved_order_id = null, reserved_at = null
   where reserved_order_id = p_order_id and claimed = false;
$$;

-- Mark a qvsp row claimed once we've successfully bought from qvsp and
-- created an inventory row for it.
create or replace function claim_qvsp_stock(p_qvsp_id text, p_order_id uuid)
returns void language sql as $$
  update qvsp_stock
     set claimed = true, claimed_order_id = p_order_id,
         reserved_order_id = null, reserved_at = null
   where qvsp_id = p_qvsp_id;
$$;

-- Daily reset for autobuy counters. Called by autobuy worker when
-- it notices bought_today_date is stale. Idempotent.
create or replace function reset_autobuy_daily(p_config_id uuid)
returns void language sql as $$
  update autobuy_configs
     set bought_today = 0, bought_today_date = current_date
   where id = p_config_id and bought_today_date < current_date;
$$;

-- Atomically increment a config's daily counter and check against cap.
-- Returns true if we're allowed to buy (and counter was incremented).
create or replace function try_consume_autobuy_slot(p_config_id uuid)
returns boolean language plpgsql as $$
declare v_ok integer;
begin
  perform reset_autobuy_daily(p_config_id);
  update autobuy_configs
     set bought_today = bought_today + 1,
         last_fired_at = now()
   where id = p_config_id
     and bought_today < max_buys_per_day
     and active = true;
  get diagnostics v_ok = row_count;
  return v_ok > 0;
end $$;

-- Round-robin pick: given a bucket and a candidate set of Ultra user ids,
-- return the one whose turn it is. Updates the cursor.
create or replace function autobuy_rr_pick(p_bucket text, p_candidates uuid[])
returns uuid language plpgsql as $$
declare
  v_last uuid;
  v_pick uuid;
  v_idx int;
begin
  if array_length(p_candidates, 1) is null then return null; end if;
  select last_user into v_last from autobuy_rr_cursor where bucket = p_bucket;
  if v_last is null then
    v_pick := p_candidates[1];
  else
    v_idx := array_position(p_candidates, v_last);
    if v_idx is null or v_idx = array_length(p_candidates, 1) then
      v_pick := p_candidates[1];
    else
      v_pick := p_candidates[v_idx + 1];
    end if;
  end if;
  insert into autobuy_rr_cursor (bucket, last_user, updated_at)
    values (p_bucket, v_pick, now())
    on conflict (bucket) do update set last_user = excluded.last_user, updated_at = now();
  return v_pick;
end $$;

-- Extend checkout expiry for qvsp rows too. Replace existing expire fn.
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
    perform release_qvsp_stock(r.id);        -- NEW
    if r.credit_used_cents > 0 then
      perform add_credit(r.user_id, r.credit_used_cents, 'order_expired', r.id);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Public view: qvsp stock the public shop can see (past 2h embargo,
-- no credentials, no qvsp_id exposed — use a sales_id surrogate instead
-- in the API layer if you want to hide qvsp coupling entirely).
create or replace view qvsp_stock_public as
  select qvsp_id, kind, region, level, peak, rank_normalized as rank,
         public_price_cents, skin_count, skins, buddies, vp, vp_value_cents,
         last_played, first_seen_at
    from qvsp_stock
   where reserved_order_id is null
     and claimed = false
     and removed_at is null
     and public_at <= now();

-- Subscriber view (what Premium/Ultra see — includes embargoed stock).
create or replace view qvsp_stock_subs as
  select qvsp_id, kind, region, level, peak, rank_normalized as rank,
         public_price_cents, skin_count, skins, buddies, vp, vp_value_cents,
         last_played, first_seen_at, public_at
    from qvsp_stock
   where reserved_order_id is null
     and claimed = false
     and removed_at is null;
