# valo-shop-worker

Headless-browser extractor for Riot account emails. Lives separately from
the main Next.js app because Vercel serverless can't run Playwright
reliably.

## How it fits in

```
main app (vercel)                          worker (fly.io)
──────────────────                         ────────────────
POST /api/ipn ← nowpayments
  → fulfilOrder()
    → qvsp POST /orders
    → inventory row created
    → POST workerURL/extract { order_id, login, password } ─┐
                                                             │
                                                             ▼
                                                 chromium → riot login
                                                         → merch.riot
                                                         → apollo cache → email
                                                             │
                                  ┌──────────────────────────┘
                                  ▼
POST /api/worker/callback  { order_id, ok: true, email }
  → encrypt + store email_enc on inventory row
  → DM user: "email ready!"

(on failure → staff log channel for manual bookmarklet run)
```

## Deploy to Fly.io

Prereqs: a Fly.io account + `flyctl` installed (`brew install flyctl` on
macOS, `scoop install flyctl` on Windows, or `curl -L https://fly.io/install.sh | sh`).

From this folder:

```bash
cd worker
fly launch --no-deploy        # creates the app on fly; keep app name "valo-shop-worker"
```

During `fly launch` it'll ask:
- App name → `valo-shop-worker`
- Region → closest (cdg, fra, ams, mad)
- Set up Postgres? **no**
- Set up Redis? **no**
- Deploy now? **no** (we need to set secrets first)

Set the secrets:

```bash
fly secrets set \
  WORKER_SECRET=<generate a random 32-char string> \
  CALLBACK_SECRET=<generate another random 32-char string> \
  MAIN_APP_URL=https://val-unlocked-fmcac-8015s-projects.vercel.app
```

Generate the two random secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Deploy:

```bash
fly deploy
```

Takes ~3 minutes first time (builds Docker image, pushes to Fly's
registry). Subsequent deploys ~1 minute.

Health check:

```bash
curl https://valo-shop-worker.fly.dev/health
# → {"ok":true,"version":"1.0.0"}
```

## Wire the main app

Set these two env vars on Vercel (Project → Settings → Environment Variables):

- `EXTRACTOR_WORKER_URL=https://valo-shop-worker.fly.dev`
- `EXTRACTOR_WORKER_SECRET=<same value as WORKER_SECRET above>`
- `EXTRACTOR_CALLBACK_SECRET=<same value as CALLBACK_SECRET above>`

Redeploy Vercel so the new env vars load into running functions.

## Testing locally

```bash
cd worker
npm install
npx playwright install chromium       # downloads headless chromium
WORKER_SECRET=dev \
CALLBACK_SECRET=dev \
MAIN_APP_URL=http://localhost:3000 \
npm run dev
```

Then:

```bash
curl -X POST http://localhost:8080/extract \
  -H "Authorization: Bearer dev" \
  -H "Content-Type: application/json" \
  -d '{"order_id":"test-123","login":"<test riot login>","password":"<test pw>"}'
```

Watch the worker logs — it'll open chromium, run the extraction, POST back
to localhost:3000.

## When extraction fails

The worker POSTs back `{ ok: false, reason: "<code>" }`. The callback
handler logs to `#staff-log` in Discord with the order id. You then:

1. Run the (private) bookmarklet yourself with the credentials from
   `/orders/[id]`.
2. Paste the email into the `inventory.email_enc` column directly in
   Supabase (encrypt it first via the same `lib/crypto.encrypt` function
   the app uses, OR just use Supabase SQL `pgsodium` if you've set that up).
3. Order automatically reflects it on next page load.

Failure reasons you might see:
- `login_invalid` — qvsp handed us bad credentials. Trigger a qvsp
  replacement.
- `captcha_present` — Riot showed hCaptcha on login. The worker does NOT
  defeat captchas. Solve it manually with the bookmarklet.
- `email_not_found` — Apollo cache didn't contain an email. Riot may
  have changed their frontend; update the `page.evaluate` extractor.
- `login_timeout` — Riot auth page didn't respond. Usually transient,
  retry manually.
- `worker_error` — any unhandled error. Check `fly logs`.

## Costs

- Fly.io: free tier covers one shared-cpu-1x 1GB machine running up to
  ~160 hours/mo. Worker scales to zero when idle, so cost is effectively €0
  until you have real volume.
- Egress bandwidth: trivial (worker loads Riot pages, posts back a few KB).

## Updating

```bash
cd worker
# edit src/index.ts, bump version in package.json
fly deploy
```

Zero-downtime; Fly spins up new machines before killing old ones.

## Monitoring

```bash
fly logs        # live tail
fly status      # instance health
fly ssh console # shell into the running machine (debug only)
```
