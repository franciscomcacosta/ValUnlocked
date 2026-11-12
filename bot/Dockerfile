# Val Unlocked Discord bot — always-on, tiny.
# Built from the REPO ROOT (it needs lib/), via: fly deploy --config fly.bot.toml
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# Only what the bot needs — not the whole Next.js app.
RUN echo '{"name":"vu-bot","private":true,"type":"module"}' > package.json \
 && npm install --omit=dev --no-audit --no-fund discord.js@14 @supabase/supabase-js@2 tsx@4

COPY bot ./bot
# Every lib/ file the bot imports (directly or indirectly) must be listed here.
COPY lib/discord.ts lib/discord-messages.ts lib/pricing.ts lib/referrals.ts lib/supabase.ts ./lib/

CMD ["node", "--max-old-space-size=180", "--import", "tsx", "bot/index.ts"]
