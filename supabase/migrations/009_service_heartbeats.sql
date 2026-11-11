-- Liveness pings from background services (the stock watcher touches its
-- row once a minute). The admin panel uses it for "Watcher live / down".
create table if not exists service_heartbeats (
  name     text primary key,
  beat_at  timestamptz not null default now(),
  info     jsonb
);
alter table service_heartbeats enable row level security;

notify pgrst, 'reload schema';
