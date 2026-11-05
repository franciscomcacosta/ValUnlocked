"use client";
import { use, useEffect, useState } from "react";

const eur = (c: number) => `€${(c / 100).toFixed(2)}`;

interface OrderData {
  id: string;
  status: string;
  price_cents: number;
  currency: string;
  created_at: string;
  products: { name: string; region: string; rank: string | null };
  account: { login: string; password: string; email: string; emailPassword: string } | null;
  error?: string;
}

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [order, setOrder] = useState<OrderData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch(`/api/orders/${id}`)
        .then((r) => (r.ok ? r.json() : { error: "not_found" }))
        .then((d) => { if (!stop) { setOrder(d); setLoading(false); } });
    load();
    // Poll while the payment is still settling.
    const t = setInterval(() => { if (order && !["fulfilled", "expired", "failed", "refunded_credit"].includes(order.status)) load(); }, 5000);
    return () => { stop = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, order?.status]);

  if (loading) return <div className="center muted">Loading…</div>;
  if (!order || order.error) return <div className="center"><p className="muted">Order not found.</p><a href="/">Back to shop</a></div>;

  return (
    <div className="wrap" style={{ maxWidth: 620 }}>
      <a href="/" className="muted">← Back to shop</a>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="row spread">
          <h3>{order.products.name} <span className="muted">({order.products.region})</span></h3>
          <span className={`pill ${order.status}`}>{order.status.replace("_", " ")}</span>
        </div>
        <p className="muted">{eur(order.price_cents)} · {new Date(order.created_at).toLocaleString()}</p>

        {order.account ? (
          <>
            <div className="notice" style={{ marginBottom: 12 }}>
              Log in, then <strong>change the account password and the email password immediately</strong>. The email is included for full access.
            </div>
            <div className="creds">
              <div><span className="muted">Riot login</span><span>{order.account.login}</span></div>
              <div><span className="muted">Riot password</span><span>{order.account.password}</span></div>
              <div><span className="muted">Email</span><span>{order.account.email}</span></div>
              <div><span className="muted">Email password</span><span>{order.account.emailPassword}</span></div>
            </div>
          </>
        ) : order.status === "partially_paid" ? (
          <div className="notice">Your payment came in short. Open a ticket in Discord and we'll sort it out.</div>
        ) : ["pending", "waiting", "confirming", "confirmed", "sending", "paid"].includes(order.status) ? (
          <div className="notice">Waiting for your payment to confirm on-chain. This page updates automatically.</div>
        ) : (
          <div className="notice">This order didn't complete. Any store credit used has been returned.</div>
        )}
      </div>
    </div>
  );
}
