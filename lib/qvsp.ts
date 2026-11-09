import { createHash } from "node:crypto";
// Typed client for the qvsp.net partner API.
// Docs are not public; this is reverse-engineered from live probes.
// Base URL and auth header come from env so we can swap sandbox/prod.

const QVSP_BASE = process.env.QVSP_API_BASE ?? "https://nfa.qvsp.net/partner/v1";
const QVSP_KEY = process.env.QVSP_API_KEY;

if (!QVSP_KEY && process.env.NODE_ENV === "production") {
  // Soft-fail in dev (routes that need it will still throw at call time).
  console.warn("[qvsp] QVSP_API_KEY not set — qvsp features will fail");
}

export type QvspKind = "skinned" | "ranked";
export type QvspRegion = "eu" | "ap" | "kr" | "latam" | "br"; // NA has no stock

export interface QvspStockItem {
  id: string;
  kind: QvspKind;
  region: Uppercase<QvspRegion>;
  level: number;
  peak: string;
  rank: string;
  price: number;              // EUR, fractional (qvsp charges us this)
  // Skinned-only fields (ranked items omit these):
  skin_count?: number;
  skins?: string[];
  buddies?: string[];
  vp?: number;
  vp_value?: number;
  last_played?: string;
  added_epoch?: number;
  updated_epoch?: number;
}

interface QvspListResponse {
  items: QvspStockItem[];
  ok?: boolean;
}

interface QvspBalanceResponse {
  balance: number;
  currency: string;
  ok: boolean;
}

interface QvspWebhookConfig {
  configured: boolean;
  webhook_url: string;
  events: string[];
  deliveries: { delivered: number; failed: number; last: unknown; pending: number };
  ok: boolean;
}

interface QvspOrdersListResponse {
  ok: boolean;
  orders: QvspOrder[];
}

export interface QvspOrder {
  id: string;
  status: string;
  stock_id?: string;
  kind?: QvspKind;
  region?: string;
  credentials?: QvspCredentials;
  created_at?: string;
  [key: string]: unknown;
}

export interface QvspCredentials {
  login: string;
  password: string;
  email: string;
  email_password: string;
  [key: string]: unknown;      // qvsp may add fields (recovery codes etc.)
}

interface QvspError {
  ok: false;
  error: string;
  message: string;
}

class QvspApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "QvspApiError";
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!QVSP_KEY) throw new QvspApiError(500, "no_key", "QVSP_API_KEY not configured");
  const res = await fetch(`${QVSP_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${QVSP_KEY}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  // qvsp returns HTML 404 pages for unknown paths — don't try to JSON.parse those
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new QvspApiError(res.status, "non_json", text.slice(0, 200));
  }
  if (!res.ok || (body as QvspError)?.ok === false) {
    const err = body as QvspError;
    throw new QvspApiError(res.status, err?.error ?? "http_error", err?.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

// ─── Read-only ─────────────────────────────────────────────────────────

export async function getStock(kind: QvspKind, region: QvspRegion): Promise<QvspStockItem[]> {
  const res = await call<QvspListResponse>(`/stock?kind=${kind}&region=${region}`);
  return res.items ?? [];
}

export async function getAllStock(): Promise<QvspStockItem[]> {
  const kinds: QvspKind[] = ["skinned", "ranked"];
  const regions: QvspRegion[] = ["eu", "ap", "kr", "latam", "br"];
  const results = await Promise.all(
    kinds.flatMap((k) => regions.map((r) => getStock(k, r).catch((e) => {
      console.error(`[qvsp] stock fetch ${k}/${r} failed`, e);
      return [] as QvspStockItem[];
    })))
  );
  return results.flat();
}

export async function getBalance(): Promise<{ cents: number; currency: string }> {
  const res = await call<QvspBalanceResponse>("/balance");
  return { cents: Math.round(res.balance * 100), currency: res.currency };
}

export async function getOrders(): Promise<QvspOrder[]> {
  const res = await call<QvspOrdersListResponse>("/orders");
  return res.orders ?? [];
}

export async function getWebhookConfig(): Promise<QvspWebhookConfig> {
  return call<QvspWebhookConfig>("/webhook");
}

// ─── Write (DANGER: these spend money / change state) ────────────────

/**
 * Buy a specific stock item from qvsp. Spends from our balance.
 * Called only from fulfilOrder() (post-payment) or the autobuy worker.
 * Never from a user-facing route without an order gate.
 */
export async function buyAccount(opts: { kind: QvspKind; id: string; orderRef?: string }): Promise<QvspOrder> {
  // qvsp requires an idempotency_key (8–64 chars). Derived from OUR order +
  // the listing, so a retry of the same purchase can never charge twice,
  // while swapping to a different listing gets a fresh key.
  const idempotencyKey =
    "vu_" + createHash("sha256").update(`${opts.orderRef ?? "manual"}:${opts.kind}:${opts.id}`).digest("hex").slice(0, 40);
  const raw = await call<unknown>("/orders", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({ kind: opts.kind, id: opts.id, idempotency_key: idempotencyKey }),
  });
  let order = normalizeOrder(raw);
  // Some responses only confirm the order; credentials come from GET /orders/:id
  // (possibly a moment later). Poll briefly.
  for (let i = 0; i < 4 && order.id && !order.credentials; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500));
    try {
      order = { ...order, ...normalizeOrder(await call<unknown>(`/orders/${encodeURIComponent(order.id)}`)), id: order.id };
    } catch {
      /* keep what we have */
    }
  }
  return order;
}

// ─── Response normalising (qvsp has changed shapes before) ─────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null);

/** Finds a {login/username, password, ...} object anywhere in the body. */
function findCreds(o: unknown, depth = 0): QvspCredentials | null {
  if (!isObj(o) || depth > 5) return null;
  const login = str(o.login) ?? str(o.username) ?? str(o.user) ?? str(o.riot_username) ?? str(o.account_login);
  const password = str(o.password) ?? str(o.pass) ?? str(o.account_password);
  if (login && password) {
    return {
      ...o,
      login,
      password,
      email: str(o.email) ?? str(o.mail) ?? str(o.email_address) ?? "",
      email_password: str(o.email_password) ?? str(o.emailPassword) ?? str(o.mail_password) ?? str(o.email_pass) ?? "",
    };
  }
  for (const v of Object.values(o)) {
    const c = findCreds(v, depth + 1);
    if (c) return c;
  }
  return null;
}

/** Accepts {id, credentials}, {ok, order:{…}}, {data:{…}}, {order_id, account:{…}} … */
export function normalizeOrder(raw: unknown): QvspOrder {
  const r = isObj(raw) ? raw : {};
  const inner = [r.order, r.data, isObj(r.data) ? (r.data as Record<string, unknown>).order : null, r.result].find(isObj) as
    | Record<string, unknown>
    | undefined;
  const o = inner ?? r;
  const id = str(o.id) ?? str(o.order_id) ?? str(r.order_id) ?? str(r.id) ?? "";
  return {
    ...o,
    id,
    status: str(o.status) ?? str(r.status) ?? "",
    credentials: findCreds(raw) ?? undefined,
    _shape: describeShape(raw),
  } as QvspOrder;
}

/** Key structure with every value redacted — safe to log. */
export function describeShape(v: unknown, depth = 0): string {
  if (Array.isArray(v)) return `[${v.length ? describeShape(v[0], depth + 1) : ""}]`;
  if (!isObj(v)) return typeof v;
  if (depth > 3) return "{…}";
  return `{${Object.entries(v).map(([k, x]) => `${k}:${describeShape(x, depth + 1)}`).join(", ")}}`;
}

/** Fetch one qvsp order (credentials included once completed). */
export async function getOrder(orderId: string): Promise<QvspOrder> {
  const res = await call<QvspOrder & { order?: QvspOrder }>(`/orders/${encodeURIComponent(orderId)}`);
  return (res.order ?? res) as QvspOrder;
}

/**
 * Low-level request for endpoints whose shapes aren't pinned down yet
 * (replacement tickets). Never throws on HTTP errors — returns status +
 * parsed body so callers can log exactly what qvsp said.
 * Pass a FormData body for uploads (content-type is then left to fetch).
 */
export async function qvspRaw(
  path: string,
  init: { method?: string; json?: unknown; form?: FormData } = {}
): Promise<{ ok: boolean; status: number; body: unknown }> {
  if (!QVSP_KEY) return { ok: false, status: 500, body: { error: "no_key" } };
  const headers: Record<string, string> = { authorization: `Bearer ${QVSP_KEY}` };
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${QVSP_BASE}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
  const text = await res.text();
  let parsed: unknown = text.slice(0, 2000);
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* html / text */ }
  const okFlag = (parsed as { ok?: boolean })?.ok;
  return { ok: res.ok && okFlag !== false, status: res.status, body: parsed };
}

/**
 * Configure the webhook qvsp should hit for order.*, replacement.*, payout.* events.
 */
export async function setWebhookUrl(url: string): Promise<unknown> {
  return call("/webhook", {
    method: "POST",
    body: JSON.stringify({ webhook_url: url }),
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * qvsp returns rank values with mixed case and formats:
 *   "UNRANKED", "unranked", "PLATINUM", "platinum 2", "N/A"
 * Normalize to lowercase with a consistent form for sorting / filtering.
 */
export function normalizeRank(raw: string | null | undefined): string {
  if (!raw) return "unranked";
  const s = raw.trim().toLowerCase();
  if (s === "n/a" || s === "") return "unranked";
  // Collapse "PLATINUM" → "platinum" (division unknown)
  return s;
}

/**
 * Ordered rank tiers for comparison. Higher index = higher rank.
 * Use this with a normalized rank to compare, filter min_peak, etc.
 */
const RANK_ORDER = [
  "unranked",
  "iron", "iron 1", "iron 2", "iron 3",
  "bronze", "bronze 1", "bronze 2", "bronze 3",
  "silver", "silver 1", "silver 2", "silver 3",
  "gold", "gold 1", "gold 2", "gold 3",
  "platinum", "platinum 1", "platinum 2", "platinum 3",
  "diamond", "diamond 1", "diamond 2", "diamond 3",
  "ascendant", "ascendant 1", "ascendant 2", "ascendant 3",
  "immortal", "immortal 1", "immortal 2", "immortal 3",
  "radiant",
];

export function rankIndex(rank: string): number {
  const idx = RANK_ORDER.indexOf(normalizeRank(rank));
  return idx === -1 ? 0 : idx;
}

export function rankAtLeast(have: string, floor: string): boolean {
  return rankIndex(have) >= rankIndex(floor);
}

/**
 * qvsp price is a float EUR like 14.0 or 1.5. Convert to our cents model.
 */
export function qvspPriceToCents(price: number): number {
  return Math.round(price * 100);
}

export { QvspApiError };
