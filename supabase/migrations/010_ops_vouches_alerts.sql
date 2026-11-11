-- Ops upgrades: sales pause flags, unpaid-order reminders, vouches,
-- restock alerts. Safe to run more than once.

-- Small key/value store for shop-wide switches and alert state
-- (sales_paused, qvsp_balance, watcher_alert, balance_alert …).
create table if not exists shop_flags (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table shop_flags enable row level security;

-- One-time markers so each order gets each DM at most once.
alter table orders add column if not exists unpaid_reminded_at timestamptz;
alter table orders add column if not exists vouch_asked_at     timestamptz;

-- Buyer ratings ("vouches"), one per order.
create table if not exists vouches (
  id          bigserial primary key,
  order_id    uuid not null unique references orders(id),
  user_id     uuid not null references users(id),
  stars       integer not null check (stars between 1 and 5),
  comment     text,
  posted      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists vouches_created_idx on vouches (created_at);
alter table vouches enable row level security;

-- "DM me when a <bracket> account drops in <region>".
create table if not exists restock_alerts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  region            text not null,
  bracket           text not null,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  last_notified_at  timestamptz,
  unique (user_id, region, bracket)
);
create index if not exists restock_alerts_match_idx on restock_alerts (region, bracket) where active;
alter table restock_alerts enable row level security;

notify pgrst, 'reload schema';
