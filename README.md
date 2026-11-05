# Valo Shop – backend core

Next.js (App Router) + Supabase + NOWPayments. Sells full-access accounts from your own stock:
self-leveled smurfs (`own`) and accounts bought from their original owners (`bought`).

## What's here

| Path | What it does |
|---|---|
| `supabase/schema.sql` | Tables, stock reservation, store credit, idempotent fulfilment, stale-order expiry |
| `lib/crypto.ts` | AES-256-GCM encryption for stored logins |
| `lib/nowpayments.ts` | Invoice creation + IPN signature check |
| `lib/checkout.ts` | Checkout logic shared by site and bot (reserve → credit → invoice) |
| `lib/fulfil.ts` | Marks account sold, DMs buyer a link to their order |
| `lib/discord.ts` | Discord REST helpers (DMs, staff log channel) |
| `app/api/checkout` | `POST {product, useCredit}` → invoice URL |
| `app/api/ipn` | NOWPayments webhook |
| `app/api/orders/[id]` | Order status + credentials (buyer only, once fulfilled) |
| `app/api/products` | Product list with stock counts |
| `app/api/cron/expire` | Hourly: frees stock held by unpaid orders |
| `scripts/add-stock.ts` | Bulk-add accounts from CSV, encrypted |

## Order flow

1. Checkout reserves an account (`SKIP LOCKED`, so no double-selling), spends credit if chosen, creates a NOWPayments invoice.
2. Buyer pays on NOWPayments' hosted page.
3. IPN arrives → signature verified → logged in `ipn_events`.
   - `finished` → fulfil (once, even if the IPN repeats) → buyer gets a Discord DM with the order link.
   - `partially_paid` → stock stays reserved, staff channel pinged.
   - `expired` / `failed` → stock released, credit returned.
4. Unpaid orders older than 3 h are expired by the cron job.

Credentials are never sent in Discord. The DM links to the order page, which only the buyer can open.

## Setup

1. Create a Supabase project, run `supabase/schema.sql` in the SQL editor.
2. Copy `.env.example` → `.env.local` and fill it in. Back up `CREDENTIALS_KEY` somewhere safe.
3. In NOWPayments, set the IPN secret and note your API key. The callback URL is set per invoice.
4. `npm install`, then `npm run dev`.
5. Add products in the Supabase table editor, then stock: `npm run add-stock stock.csv` (delete the CSV after).
6. Deploy to Vercel; `vercel.json` registers the hourly cron.

Local IPN testing: expose your dev server with a tunnel (e.g. cloudflared) and set `PUBLIC_BASE_URL` to it.
Double-check NOWPayments' current docs for field names and the signature format before going live.

## Not done yet (next steps)

- **Discord OAuth login.** `lib/session.ts` is a dev stub that refuses to run in production.
- **Discord bot:** `/shop`, buy buttons (calling `createCheckout`), buyer role, tickets, `/credit` admin command.
- **Frontend pages:** shop, product, order page.
- **Admin:** refund-as-credit and replacement actions (the SQL functions `add_credit` / `reserve_inventory` are already there).

## Notes

- Riot's terms prohibit account trading, so accounts can be banned. Show your warranty/replacement policy at checkout.
- Crypto has no chargebacks; refunds are replacement first, store credit second, manual crypto refund last.
