# Setup — filling in `.env.local`

Your `.env.local` already has the random local secrets filled in (`CREDENTIALS_KEY`, `SESSION_SECRET`, `CRON_SECRET`). You need to fill in the rest. Open each link, follow the steps, paste the value into `.env.local`, save.

Takes about 15 minutes end-to-end.

---

## 1. Supabase

**→ https://supabase.com/dashboard/projects**

1. Click **New Project** (or open your existing valo-shop project).
2. Give it a name, pick a region close to you (EU West for Lisbon).
3. Wait ~1 min for provisioning.
4. Go to **Settings → API** in the left sidebar.
5. Copy:
   - **Project URL** → paste into `SUPABASE_URL`
   - **service_role** key (NOT `anon`) → paste into `SUPABASE_SERVICE_ROLE_KEY`
6. Go to **SQL Editor** in the left sidebar, click **+ New query**, paste the contents of `supabase/schema.sql`, click **Run**.
7. Repeat for `supabase/migrations/002_subs_qvsp_autobuy.sql`.
8. Repeat for `supabase/migrations/003_tools.sql`.

> ⚠️ `service_role` bypasses Row-Level Security. Keep it server-only — never ship it to a client component or git.

---

## 2. Discord — Application + Bot

**→ https://discord.com/developers/applications**

1. Click **New Application**, name it `valo-shop` (or whatever you want).
2. In the left sidebar, click **General Information**.
3. Copy **APPLICATION ID** → paste into `DISCORD_CLIENT_ID`.
4. Click **OAuth2** in the sidebar.
5. Copy **CLIENT SECRET** (click "Reset Secret" if hidden) → paste into `DISCORD_CLIENT_SECRET`.
6. Scroll to **Redirects**, click **Add Redirect**, paste:
   - `http://localhost:3000/api/auth/callback` (for dev)
   - `https://valunlock.online/api/auth/callback` (for production — add later)
7. Click **Save Changes**.
8. Click **Bot** in the sidebar.
9. Click **Reset Token**, copy it → paste into `DISCORD_BOT_TOKEN`.
10. Under **Privileged Gateway Intents**, leave all OFF (we don't need them).

### Invite the bot to your server

Still on the Bot page scroll up, then:

1. Click **OAuth2 → URL Generator** in the sidebar.
2. Scopes: check **bot** and **applications.commands**.
3. Bot Permissions: check **Send Messages**, **Manage Roles**, **Embed Links**, **Use Slash Commands**.
4. Copy the generated URL at the bottom, open it in a new tab, pick your server, authorize.

---

## 3. Discord — Server-side IDs

Enable Developer Mode first:

**→ Discord → User Settings → Advanced → Developer Mode (toggle ON)**

Then in your Discord server:

### Your own user ID (admin)
Right-click your name anywhere → **Copy User ID** → paste into `ADMIN_DISCORD_IDS`.

### Server ID (guild)
Right-click your server name in the server list → **Copy Server ID** → paste into `DISCORD_GUILD_ID`.

### Role IDs — create them first
1. Server Settings → **Roles** → **Create Role**. Make three:
   - `Rookie` (color: bronze)
   - `Grinder` (color: silver)
   - `Operator` (color: gold)
2. Drag them below the bot's own role (so the bot can assign them).
3. Right-click each role in the Roles list → **Copy Role ID** → paste into `DISCORD_ROLE_ROOKIE`, `DISCORD_ROLE_GRINDER`, `DISCORD_ROLE_OPERATOR`.

### Channel IDs
Create two channels:
- `#staff-log` (private, you + bot only) → right-click → **Copy Channel ID** → `DISCORD_LOG_CHANNEL_ID`
- `#drops` (public, everyone can read) → copy ID → `DISCORD_DROPS_CHANNEL_ID`

---

## 4. NOWPayments

**→ https://account.nowpayments.io/sign-up** (skip if you have an account)

1. Sign up, verify email.
2. Go to **Store Settings** in the left menu: https://account.nowpayments.io/store-settings
3. **Generate API Key** → copy → paste into `NOWPAYMENTS_API_KEY`.
4. Scroll to **IPN Secret** (or **Instant Payment Notifications**).
5. Click **Generate** if there's no secret shown → copy → paste into `NOWPAYMENTS_IPN_SECRET`.
6. Set **IPN Callback URL** to `https://valunlock.online/api/ipn` (or your tunnel URL for local testing — see below).

### Testing NOWPayments IPNs locally

NOWPayments can't reach `localhost`. Expose your dev server with a tunnel:

```bash
# Install cloudflared once
# macOS: brew install cloudflared
# Windows: scoop install cloudflared
# then:
cloudflared tunnel --url http://localhost:3000
```

Copy the generated `https://xyz.trycloudflare.com` URL, set it as `PUBLIC_BASE_URL` in `.env.local` and as the IPN Callback in NOWPayments while testing.

---

## 5. QVSP partner API

**→ Your QVSP dashboard** (wherever you got the key from originally)

1. **Revoke the old key first** (the one in the screenshot). We've already probed with it so treat it as burned.
2. Generate a fresh key.
3. Paste into `QVSP_API_KEY` in `.env.local`.
4. Make sure `QVSP_API_BASE` is `https://nfa.qvsp.net/partner/v1`.

Later (after you have a production URL), set their webhook to:
`https://valunlock.online/api/webhooks/qvsp` — we'll build that endpoint in PR 2.

---

## 6. Verify it all works

```bash
npm install
npm run dev
```

Open http://localhost:3000. Try:

```bash
# Test the qvsp sync — should upsert ~13k rows
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/sync-qvsp
```

Check Supabase → Table Editor → `qvsp_stock` → should be full. If you see rows, **PR 1 is live**.

---

## Deploying to Vercel

1. `vercel link` (connect the repo to a Vercel project).
2. Add every env var from `.env.local` to **Vercel → Project → Settings → Environment Variables**.
3. Change `PUBLIC_BASE_URL` to your production domain (e.g. `https://valunlock.online`).
4. Add the production redirect URI to Discord OAuth (you did this in step 2 above).
5. `git push` → Vercel auto-deploys.
6. Crons start running automatically.
