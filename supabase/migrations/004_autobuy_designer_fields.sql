-- Auto-buy rule fields from the designer's rule editor:
--   max_peak     upper bound of the peak-rank range (min_peak already exists)
--   min_vp       minimum Valorant Points balance on the account
--   budget_cents total spend cap for the rule (null = no cap)
--   spent_cents  running total, maintained by the auto-buy worker
alter table autobuy_configs
  add column if not exists max_peak text,
  add column if not exists min_vp integer,
  add column if not exists budget_cents integer,
  add column if not exists spent_cents integer not null default 0;
