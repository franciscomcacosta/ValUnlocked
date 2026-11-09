-- Replacement / refund claims ("Report a problem").
--
-- Flow: buyer reports within 10 minutes of delivery with a video →
-- a qvsp replacement ticket is opened with the video as proof → qvsp
-- approves or denies (webhook + cron poll). If qvsp supplies a
-- replacement account the buyer gets that; otherwise an approved claim
-- refunds what the BUYER paid (credit + crypto) + a 5% apology bonus.

-- qvsp's own order id, needed to open a replacement ticket.
alter table orders add column if not exists qvsp_order_id text;

create table if not exists replacement_claims (
  id                     uuid primary key default gen_random_uuid(),
  order_id               uuid not null references orders(id),
  user_id                uuid not null references users(id),
  reason                 text not null,          -- login | count | locked | other
  details                text,
  video_path             text,                   -- storage: claim-videos/<path>
  status                 text not null default 'submitted',
                                                 -- submitted | under_review | replaced | refunded | denied
  qvsp_ticket_id         text,
  qvsp_status            text,
  qvsp_last              jsonb,
  forward_error          text,                   -- why forwarding to qvsp failed (staff follow-up)
  outcome_note           text,
  refund_cents           integer not null,       -- what the buyer paid: credit_used + charge
  bonus_cents            integer not null,       -- 5% apology on top
  old_inventory_id       uuid references inventory(id),
  replaced_inventory_id  uuid references inventory(id),
  customer_seen_at       timestamptz,
  created_at             timestamptz not null default now(),
  resolved_at            timestamptz
);
create index if not exists replacement_claims_user_idx on replacement_claims (user_id);
create index if not exists replacement_claims_ticket_idx on replacement_claims (qvsp_ticket_id);
-- One open claim per order.
create unique index if not exists replacement_claims_open_uidx
  on replacement_claims (order_id) where status in ('submitted', 'under_review');
alter table replacement_claims enable row level security;

-- Refund an approved claim exactly once: buyer's price + apology bonus to credit.
create or replace function apply_claim_refund(p_claim uuid, p_note text)
returns integer language plpgsql as $$
declare
  v_user  uuid;
  v_order uuid;
  v_total integer;
begin
  update replacement_claims
     set status = 'refunded', resolved_at = now(), outcome_note = p_note
   where id = p_claim and status in ('submitted', 'under_review')
  returning user_id, order_id, refund_cents + bonus_cents into v_user, v_order, v_total;
  if not found then
    return 0;
  end if;
  perform add_credit(v_user, v_total, 'claim_refund', v_order);
  return v_total;
end $$;

-- Swap in a replacement account exactly once.
create or replace function apply_claim_replacement(p_claim uuid, p_inventory uuid, p_note text)
returns boolean language plpgsql as $$
declare
  v_order uuid;
  v_old   uuid;
begin
  update replacement_claims c
     set status = 'replaced', resolved_at = now(), outcome_note = p_note,
         replaced_inventory_id = p_inventory,
         old_inventory_id = (select inventory_id from orders where id = c.order_id)
   where c.id = p_claim and c.status in ('submitted', 'under_review')
  returning c.order_id into v_order;
  if not found then
    return false;
  end if;
  update orders set inventory_id = p_inventory where id = v_order;
  return true;
end $$;
