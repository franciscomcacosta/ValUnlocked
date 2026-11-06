# Playwright's official image comes with Chromium + all system deps baked in.
# Pin the version — Playwright's node package must match the image version.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Install deps first so Docker caches this layer when src changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source + compile.
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
