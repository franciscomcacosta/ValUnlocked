// Public site URL for links the bot sends. Never a local dev address —
// copying .env.local into the bot's secrets once sent people to localhost.
const PROD = "https://valunlock.online";
const raw = (process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
export const BASE_URL = !raw || /localhost|127\.0\.0\.1|0\.0\.0\.0|\.local\b/i.test(raw) ? PROD : raw;
