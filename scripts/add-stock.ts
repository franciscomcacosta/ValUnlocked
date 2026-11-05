// Add accounts to inventory from a CSV, encrypting credentials before they hit the DB.
//
// Usage: npx tsx scripts/add-stock.ts stock.csv
// CSV header: product_slug,source,acquired_from,cost_eur,login,password,email,email_password,notes
//   source = own | bought   (bought = purchased from the original owner, full access handed over)
//
// Delete the CSV afterwards – it contains plaintext passwords.
import { readFileSync } from "fs";
import { encrypt } from "../lib/crypto";
import { db } from "../lib/supabase";

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: add-stock.ts <file.csv>");
  const [header, ...lines] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const cols = header.split(",");
  const required = ["product_slug", "source", "login", "password", "email", "email_password"];
  for (const c of required) if (!cols.includes(c)) throw new Error(`missing column: ${c}`);

  const { data: products } = await db.from("products").select("id, slug");
  const bySlug = new Map((products ?? []).map((p) => [p.slug, p.id]));

  let added = 0;
  for (const [n, line] of lines.entries()) {
    const v = Object.fromEntries(line.split(",").map((x, i) => [cols[i], x.trim()]));
    const productId = bySlug.get(v.product_slug);
    if (!productId) { console.warn(`row ${n + 2}: unknown product ${v.product_slug}, skipped`); continue; }
    if (v.source !== "own" && v.source !== "bought") { console.warn(`row ${n + 2}: bad source, skipped`); continue; }
    if (v.source === "bought" && !v.acquired_from) { console.warn(`row ${n + 2}: bought account needs acquired_from, skipped`); continue; }

    const { error } = await db.from("inventory").insert({
      product_id: productId,
      source: v.source,
      acquired_from: v.acquired_from || null,
      cost_cents: v.cost_eur ? Math.round(parseFloat(v.cost_eur) * 100) : null,
      login_enc: encrypt(v.login),
      password_enc: encrypt(v.password),
      email_enc: encrypt(v.email),
      email_password_enc: encrypt(v.email_password),
      notes: v.notes || null,
    });
    if (error) console.warn(`row ${n + 2}: ${error.message}`);
    else added++;
  }
  console.log(`Added ${added} account(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
