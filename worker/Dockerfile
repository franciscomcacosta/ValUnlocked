# Playwright's official image comes with Chromium + all system deps baked in.
# Pin the version — Playwright's node package must match the image version.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Install ALL deps (incl. devDependencies, needed for TypeScript compile).
# Playwright's image is already ~2GB; a few extra MB of dev deps is nothing.
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Copy source + compile.
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
