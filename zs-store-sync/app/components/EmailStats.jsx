// app/components/EmailStats.jsx
// Owner dashboard card: what happened to the email this app sent in the last
// 30 days -- per email type sent / delivered / opened / clicked / bounced,
// and the recent emails of each store with their status. The same file in
// every Zilancer app. Numbers come from Resend webhooks recorded by ZS
// Bundles (lib/email-log.server.js there); other apps fetch them with
// lib/email-stats.server.js. No email addresses are shown or stored.
// `names` (optional): { "x.myshopify.com": "Store name" } from names the app
// already stores; By store shows the name with the handle under it, and the
// search matches either. A store with no stored name shows its handle.
import { useMemo, useState } from "react";
import { EMAIL_TYPE_LABELS } from "../lib/email-track";

const css = `
  .em-tbl{width:100%;border-collapse:collapse;font-size:13px}
  .em-tbl th{padding:8px 10px;text-align:left;color:#B98E84;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid rgba(192,39,26,.12);white-space:nowrap}
  .em-tbl td{padding:7px 10px;border-bottom:1px solid rgba(192,39,26,.12);vertical-align:top}
  .em-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .em-mut{color:#B98E84;font-size:12px}
  .em-st{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;white-space:nowrap}
  .em-st.sent,.em-st.delayed{background:#F1ECE8;color:#6B5A50}
  .em-st.delivered{background:#E6F0FA;color:#1D5A8E}
  .em-st.opened{background:#E3F4EC;color:#16764F}
  .em-st.clicked{background:#16764F;color:#fff}
  .em-st.bounced,.em-st.failed,.em-st.complained{background:#FBE4E1;color:#A3211A}
  .em-row{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;padding:2px 0}
  .em-subj{max-width:420px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px}
  .em-search{border:1px solid rgba(192,39,26,.26);border-radius:8px;padding:7px 10px;font-size:13px;min-width:220px;font-family:inherit}
  /* Apps whose owner page has no od-* styles wrap the card in .em-plain. */
  .em-plain .od-card{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:16px 18px;margin:16px 0}
  .em-plain .od-card-t{font-weight:700;font-size:15px;margin:0 0 4px}
  .em-plain .od-small,.em-plain .od-note{color:#6b6b6b;font-size:12px}
  .em-plain .od-grid{display:grid;gap:10px}
  .em-plain .od-stat{border:1px solid rgba(0,0,0,.08);border-radius:10px;padding:10px 12px}
  .em-plain .od-stat-l{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b6b6b}
  .em-plain .od-stat-v{font-size:22px;font-weight:700}
  .em-plain .od-stat-h{font-size:12px;color:#6b6b6b}
  .em-plain .od-btn{border:1px solid rgba(0,0,0,.15);background:#fff;border-radius:8px;padding:6px 12px;cursor:pointer}
`;

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "—");
const label = (t) => EMAIL_TYPE_LABELS[t] || t;
const day = (iso) => new Date(iso).toISOString().slice(5, 10).replace("-", "/");

function Totals({ t }) {
  return (
    <div className="od-grid" style={{ marginTop: 10, gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
      <div className="od-stat"><div className="od-stat-l">Sent</div><div className="od-stat-v">{t.sent}</div><div className="od-stat-h">last 30 days</div></div>
      <div className="od-stat"><div className="od-stat-l">Delivered</div><div className="od-stat-v">{pct(t.delivered, t.sent)}</div><div className="od-stat-h">{t.delivered} of {t.sent}</div></div>
      <div className="od-stat"><div className="od-stat-l">Opened</div><div className="od-stat-v">{pct(t.opened, t.delivered)}</div><div className="od-stat-h">{t.opened} of delivered</div></div>
      <div className="od-stat"><div className="od-stat-l">Clicked</div><div className="od-stat-v">{pct(t.clicked, t.delivered)}</div><div className="od-stat-h">{t.clicked} of delivered</div></div>
      <div className="od-stat"><div className="od-stat-l">Bounced / spam</div><div className="od-stat-v" style={{ color: t.bounced + t.complained ? "var(--zs-bad, #C0271A)" : undefined }}>{t.bounced + t.complained}</div><div className="od-stat-h">{t.bounced} bounced · {t.complained} spam · {t.failed} failed</div></div>
    </div>
  );
}

const handleOf = (shop) => shop.replace(/\.myshopify\.com$/, "");

export default function EmailStats({ e, names }) {
  const [q, setQ] = useState("");
  const [shownStores, setShownStores] = useState(15);
  const stores = useMemo(() => {
    if (!e?.recent) return [];
    const m = new Map();
    for (const r of e.recent) {
      const k = r.shop || "";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    const needle = q.trim().toLowerCase();
    return [...m.entries()]
      .filter(([shop]) => !needle || shop.includes(needle) || String(names?.[shop] || "").toLowerCase().includes(needle))
      .sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1));
  }, [e, q, names]);

  if (!e) return null;
  return (
    <div className="od-card">
      <style>{css}</style>
      <div className="od-card-h">
        <div>
          <p className="od-card-t">Emails</p>
          <span className="od-small">
            What happened to the email this app sent in the last {e.days || 30} days, from Resend's delivery, open and click events.
            {e.lastEventAt ? ` Last event ${e.lastEventAt.slice(0, 16).replace("T", " ")} UTC.` : ""}
          </span>
        </div>
      </div>

      {e.error ? (
        <p className="od-note">Email numbers are not available right now: {e.error}</p>
      ) : (
        <>
          <Totals t={e.total} />
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table className="em-tbl">
              <thead><tr><th>Email</th><th className="em-num">Sent</th><th className="em-num">Delivered</th><th className="em-num">Opened</th><th className="em-num">Clicked</th><th className="em-num">Bounced</th><th className="em-num">Spam</th></tr></thead>
              <tbody>
                {e.types.map((t) => (
                  <tr key={t.type}>
                    <td>{label(t.type)}</td>
                    <td className="em-num">{t.sent}</td>
                    <td className="em-num">{t.delivered} <span className="em-mut">{pct(t.delivered, t.sent)}</span></td>
                    <td className="em-num">{t.opened} <span className="em-mut">{pct(t.opened, t.delivered)}</span></td>
                    <td className="em-num">{t.clicked} <span className="em-mut">{pct(t.clicked, t.delivered)}</span></td>
                    <td className="em-num">{t.bounced || <span className="em-mut">0</span>}</td>
                    <td className="em-num">{t.complained || <span className="em-mut">0</span>}</td>
                  </tr>
                ))}
                {!e.types.length && <tr><td colSpan={7} className="em-mut" style={{ textAlign: "center", padding: 18 }}>No email sent in this period.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="od-note">
            Opened = the email's tracking image loaded. Apple Mail loads it for the reader (counts as opened) and Gmail or Outlook may block it (not counted), so treat opens as a rough signal; clicks and replies are the reliable ones.
            Email sent before 15 Nov 2026 was imported from Resend, which kept only each email's latest event and not the store.
          </p>

          {e.recent?.length > 0 && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 6px", gap: 10, flexWrap: "wrap" }}>
                <p className="od-card-t" style={{ margin: 0 }}>By store</p>
                <input className="em-search" placeholder="Find a store (name or handle)" value={q} onChange={(ev) => setQ(ev.target.value)} />
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="em-tbl">
                  <thead><tr><th>Store</th><th>Recent emails (newest first)</th></tr></thead>
                  <tbody>
                    {stores.slice(0, shownStores).map(([shop, list]) => (
                      <tr key={shop || "-"}>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {!shop ? <span className="em-mut">store not known</span> : names?.[shop] ? (
                            <>
                              <div style={{ fontWeight: 600 }}>{names[shop]}</div>
                              <div className="em-mut">{handleOf(shop)}</div>
                            </>
                          ) : handleOf(shop)}
                        </td>
                        <td>
                          {list.slice(0, shop ? 8 : 12).map((r) => (
                            <div className="em-row" key={r.id}>
                              <span className="em-mut">{day(r.sentAt)}</span>
                              <span className={`em-st ${r.status}`}>{r.status}</span>
                              <span className="em-mut">{label(r.type)}</span>
                              <span className="em-subj" title={r.subject || ""}>{r.subject}</span>
                            </div>
                          ))}
                          {list.length > (shop ? 8 : 12) && <span className="em-mut">+{list.length - (shop ? 8 : 12)} more</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {stores.length > shownStores && (
                <div style={{ textAlign: "center", padding: "10px 0" }}>
                  <button className="od-btn" onClick={() => setShownStores((n) => n + 15)}>Show more stores ({stores.length - shownStores} more)</button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
