// Server-only client using the service-role key.
// Never import this from client components.
//
// Lazy-initialized via Proxy so `createClient` isn't called at MODULE LOAD
// time. This matters because Next.js runs a build-time "Collecting page
// data" pass that imports every route file; if env vars aren't present at
// that instant, createClient throws "supabaseUrl is required" and the build
// fails. With a Proxy the real client is constructed only on first property
// access (which only happens at runtime, when env vars are guaranteed).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase env vars missing — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

// Preserves the existing `import { db } from "@/lib/supabase"` pattern.
// Every property read defers to a real client that's created on first use.
export const db = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const real = getClient() as unknown as Record<string | symbol, unknown>;
    const value = real[prop as string];
    // Bind methods so `db.from(...)` doesn't lose `this`.
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(real) : value;
  },
});
