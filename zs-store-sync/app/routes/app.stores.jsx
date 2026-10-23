// app/routes/app.stores.jsx
// Owner dashboard: installs, uninstalls, who is actually using the app, plans,
// reviews -- and buttons to act on it. Owner-only: any non-owner request, page
// or action, gets a 404 (see lib/owner.server.js). Numbers come from
// lib/owner-dashboard.server.js.

import { useMemo, useState } from "react";
import { Link, useFetcher, useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import { requireOwnerShop } from "../lib/owner.server";
import { checkStores, loadOwnerDashboard, setStoreMeta } from "../lib/owner-dashboard.server";
import { requestReview } from "../lifecycle.server";
import { listingTraffic } from "../lib/ga4.server";
import { downloadFile } from "../lib/download";

export const loader = async ({ request }) => {
  // Cross-shop data — owner store only. See lib/owner.server.js.
  const { session } = await authenticate.admin(request);
  requireOwnerShop(session.shop);
  const period = new URL(request.url).searchParams.get("period") || "7d";
  const data = await loadOwnerDashboard(period);
  // App Store listing visits and keywords come from GA4; slow or missing GA4
  // must never hold up the rest of the page.
  const traffic = await Promise.race([
    listingTraffic(data.start.slice(0, 10)),
    new Promise((r) => setTimeout(() => r({ connected: true, error: "Google Analytics took too long; reload to try again." }), 8000)),
  ]);
  return { ...data, traffic };
};

export const action = async ({ request }) => {
  // Same gate as the loader: these actions mail merchants and edit records.
  const { session } = await authenticate.admin(request);
  requireOwnerShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const shop = String(form.get("shop") || "");
  if (intent === "check") {
    const r = await checkStores();
    const parts = Object.entries(r.tally).map(([k, n]) => `${n} ${k}`).join(", ");
    return { ok: true, message: `Checked ${r.checked} stores: ${parts || "none"}.` };
  }
  if (!shop) return { ok: false, message: "No store given." };

  if (intent === "review") {
    const r = await requestReview(shop);
    return r.ok
      ? { ok: true, shop, message: `Review request sent to ${shop}.` }
      : { ok: false, shop, message: `Not sent: ${r.reason}.` };
  }
  if (intent === "reviewed") {
    const on = form.get("value") === "1";
    await setStoreMeta(shop, { reviewedAt: on ? new Date() : null });
    return { ok: true, shop, message: on ? `${shop} marked as reviewed.` : `${shop} marked as not reviewed.` };
  }
  if (intent === "test") {
    const on = form.get("value") === "1";
    await setStoreMeta(shop, { isTest: on });
    return { ok: true, shop, message: on ? `${shop} hidden as a test store.` : `${shop} counted as a real store.` };
  }
  return { ok: false, message: "Unknown action." };
};

const styles = `
  :root{--zs-red:#DD3B2A;--zs-crimson:#C0271A;--zs-bg:#f1f1f1;--zs-surface:#fff;--zs-soft:#FFF8F6;--zs-bd:rgba(192,39,26,0.12);--zs-bd-s:rgba(192,39,26,0.26);--zs-tx:#4A1C16;--zs-tx-s:#2E0804;--zs-tx-m:#8A4E44;--zs-tx-f:#B98E84;--zs-ok:#1F9E6A;--zs-ok-bg:rgba(31,158,106,0.12);--zs-warn:#B7791F;--zs-warn-bg:rgba(183,121,31,0.12);--zs-bad:#C0271A;--zs-bad-bg:rgba(192,39,26,0.1);--zs-line:#0F9D94}
  .od{background:var(--zs-bg);min-height:100vh;color:var(--zs-tx);font-family:'Inter',system-ui,sans-serif;padding:24px}
  .od-in{max-width:1240px;margin:0 auto}
  .od-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin:8px 0 22px}
  .od-title{font-size:30px;font-weight:700;letter-spacing:-0.02em;margin:0;color:var(--zs-tx-s)}
  .od-sub{color:var(--zs-tx-m);font-size:14px;margin:4px 0 0}
  .od-seg{display:inline-flex;background:var(--zs-surface);border:1px solid var(--zs-bd-s);border-radius:10px;padding:3px;gap:2px}
  .od-seg a{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;color:var(--zs-tx-m);text-decoration:none}
  .od-seg a.on{background:var(--zs-red);color:#fff}
  .od-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
  @media(max-width:900px){.od-grid{grid-template-columns:repeat(2,1fr)}}
  .od-stat{background:var(--zs-surface);border:1px solid var(--zs-bd);border-radius:12px;padding:16px 18px}
  .od-stat-l{font-size:11.5px;font-weight:600;color:var(--zs-tx-m);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px}
  .od-stat-v{font-size:28px;font-weight:700;color:var(--zs-tx-s);line-height:1.1}
  .od-stat-h{font-size:12px;color:var(--zs-tx-f);margin-top:4px}
  .od-card{background:var(--zs-surface);border:1px solid var(--zs-bd);border-radius:14px;padding:20px 22px;margin-bottom:16px}
  .od-card-t{font-size:15px;font-weight:700;color:var(--zs-tx-s);margin:0}
  .od-card-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:6px}
  .od-big{font-size:30px;font-weight:700;color:var(--zs-tx-s)}
  .od-up{color:var(--zs-ok);font-weight:700;font-size:16px;margin-left:8px}
  .od-down{color:var(--zs-bad);font-weight:700;font-size:16px;margin-left:8px}
  .od-two{display:grid;grid-template-columns:1.1fr 1fr;gap:16px}
  @media(max-width:980px){.od-two{grid-template-columns:1fr}}
  .od-fun{display:grid;gap:8px;margin-top:10px}
  .od-fun-row{display:grid;grid-template-columns:130px 1fr 40px;align-items:center;gap:10px;font-size:13px}
  .od-fun-bar{height:22px;background:var(--zs-soft);border-radius:6px;overflow:hidden}
  .od-fun-bar i{display:block;height:100%;background:linear-gradient(90deg,#F26451,var(--zs-crimson));border-radius:6px}
  .od-feed{list-style:none;margin:10px 0 0;padding:0;max-height:250px;overflow:auto;font-size:13px}
  .od-feed li{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--zs-bd)}
  .od-feed time{color:var(--zs-tx-f);white-space:nowrap;min-width:92px}
  .od-chip{display:inline-block;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:700;white-space:nowrap}
  .ok{background:var(--zs-ok-bg);color:var(--zs-ok)} .warn{background:var(--zs-warn-bg);color:var(--zs-warn)} .bad{background:var(--zs-bad-bg);color:var(--zs-bad)} .mut{background:#f3ecea;color:var(--zs-tx-m)}
  .od-tabs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
  .od-tab{border:1px solid var(--zs-bd-s);background:#fff;border-radius:999px;padding:6px 12px;font-size:12.5px;font-weight:600;color:var(--zs-tx-m);cursor:pointer;font-family:inherit}
  .od-tab.on{background:var(--zs-tx-s);border-color:var(--zs-tx-s);color:#fff}
  .od-search{margin-left:auto;border:1px solid var(--zs-bd-s);border-radius:8px;padding:7px 10px;font-size:13px;min-width:200px;font-family:inherit}
  .od-table{width:100%;border-collapse:collapse;font-size:13px}
  .od-table th{padding:9px 10px;text-align:left;color:var(--zs-tx-f);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap;border-bottom:1px solid var(--zs-bd)}
  .od-table td{padding:10px;border-bottom:1px solid var(--zs-bd);vertical-align:top}
  .od-table tr.test td{opacity:.55}
  .od-shop{font-weight:600;color:var(--zs-tx-s)} .od-small{font-size:12px;color:var(--zs-tx-f)}
  .od-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:7px;font-size:12px;font-weight:600;border:1px solid var(--zs-bd-s);cursor:pointer;background:#fff;color:var(--zs-tx);font-family:inherit;text-decoration:none;white-space:nowrap}
  .od-btn:hover{border-color:var(--zs-red)}
  .od-btn.p{background:var(--zs-red);border-color:var(--zs-red);color:#fff}
  .od-btn:disabled{opacity:.45;cursor:not-allowed}
  .od-acts{display:flex;gap:6px;flex-wrap:wrap}
  .od-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--zs-tx-m);cursor:pointer;white-space:nowrap}
  .od-toast{position:fixed;bottom:20px;right:20px;background:var(--zs-tx-s);color:#fff;padding:12px 16px;border-radius:10px;font-size:13px;z-index:10;max-width:360px}
  .od-toast.err{background:var(--zs-bad)}
  .od-note{font-size:12px;color:var(--zs-tx-f);margin-top:8px}
`;

const fmtDate = (s) => (s ? new Date(s).toISOString().slice(0, 10) : "—");
const fmtTime = (s, hourly) => {
  const d = new Date(s);
  return hourly ? d.toISOString().slice(11, 16) : d.toISOString().slice(5, 10);
};
const ago = (s) => {
  if (!s) return "never";
  const h = (Date.now() - new Date(s).getTime()) / 3600000;
  if (h < 1) return "within the hour";
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};
const STAGE_CLASS = { Dormant: "mut", Frozen: "bad", Closed: "bad", Unreachable: "bad", Left: "bad", "Auto-syncing": "ok", "Migrated data": "ok", "Connected a store": "warn", "Source store": "mut", Installed: "mut" };
const EVENT_TEXT = {
  install: (e) => (e.detail === "reinstall" ? "reinstalled" : "installed"),
  uninstall: () => "uninstalled",
  plan: (e) => `plan → ${e.detail}`,
  review_request: () => "review requested",
};

// Merchants over time (line) with installs / uninstalls (bars) underneath.
// Hovering anywhere over a day (not just on its dot) shows that day's numbers:
// one invisible column per bucket catches the pointer.
function Chart({ series }) {
  const { buckets, hourly } = series;
  const [hover, setHover] = useState(null);
  const W = 760, H = 230, L = 34, R = 10, T = 12, B = 54;
  const iw = W - L - R, ih = H - T - B;
  const vals = buckets.map((b) => b.merchants);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  lo = Math.max(0, Math.floor(lo - 2)); hi = Math.ceil(hi + 2);
  const n = Math.max(buckets.length - 1, 1);
  const x = (i) => L + (i / n) * iw;
  const y = (v) => T + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  const barMax = Math.max(1, ...buckets.map((b) => Math.max(b.installs, b.uninstalls)));
  const every = Math.ceil(buckets.length / 8);
  const bw = Math.max(2, Math.min(14, iw / buckets.length / 3));
  const colW = iw / Math.max(buckets.length, 1);
  const h = hover != null ? buckets[hover] : null;
  const when = (b) => (hourly ? new Date(b.at).toISOString().slice(11, 16) + " UTC" : new Date(b.at).toISOString().slice(0, 10));
  return (
    <div style={{ position: "relative" }} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Merchants over time">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#eee" />
            <text x={L - 6} y={y(t) + 4} fontSize="11" textAnchor="end" fill="#8A4E44">{t}</text>
          </g>
        ))}
        {h && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - 22} stroke="#C9B3AE" strokeDasharray="3 3" />}
        <polyline fill="none" stroke="var(--zs-line)" strokeWidth="2.5" points={buckets.map((b, i) => `${x(i)},${y(b.merchants)}`).join(" ")} />
        {buckets.map((b, i) => (
          <g key={b.at}>
            <circle cx={x(i)} cy={y(b.merchants)} r={hover === i ? 5 : 2.5} fill="var(--zs-line)" stroke="#fff" strokeWidth={hover === i ? 2 : 0} />
            {b.installs > 0 && <rect x={x(i) - bw - 1} y={H - 22 - (b.installs / barMax) * 18} width={bw} height={(b.installs / barMax) * 18} fill="#1F9E6A" rx="2" />}
            {b.uninstalls > 0 && <rect x={x(i) + 1} y={H - 22 - (b.uninstalls / barMax) * 18} width={bw} height={(b.uninstalls / barMax) * 18} fill="#C0271A" rx="2" />}
            {i % every === 0 && <text x={x(i)} y={H - 6} fontSize="11" textAnchor="middle" fill="#8A4E44">{fmtTime(b.at, hourly)}</text>}
            <rect x={x(i) - colW / 2} y={T} width={colW} height={H - T - 16} fill="transparent" onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />
          </g>
        ))}
        <line x1={L} x2={W - R} y1={H - 22} y2={H - 22} stroke="#e4d6d3" />
      </svg>
      {h && (
        <div style={{
          position: "absolute", top: 6, pointerEvents: "none",
          left: `${(x(hover) / W) * 100}%`, transform: `translateX(${x(hover) > W * 0.7 ? "-105%" : "8px"})`,
          background: "#2E0804", color: "#fff", borderRadius: 8, padding: "8px 11px", fontSize: 12, lineHeight: 1.5, whiteSpace: "nowrap", boxShadow: "0 8px 20px rgba(0,0,0,.18)",
        }}>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{when(h)}</div>
          <div>{h.merchants} active merchants</div>
          <div><span style={{ color: "#6EE7B7" }}>+{h.installs}</span> installed · <span style={{ color: "#FCA5A5" }}>-{h.uninstalls}</span> uninstalled</div>
        </div>
      )}
    </div>
  );
}

function BarList({ items, empty }) {
  if (!items?.length) return <p className="od-note">{empty}</p>;
  const max = Math.max(...items.map((i) => i.n), 1);
  return (
    <div className="od-fun">
      {items.map((i) => (
        <div className="od-fun-row" key={i.k} style={{ gridTemplateColumns: "minmax(110px,170px) 1fr 40px" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={i.k}>{i.k}</span>
          <div className="od-fun-bar"><i style={{ width: `${(i.n / max) * 100}%` }} /></div>
          <b style={{ textAlign: "right" }}>{i.n}</b>
        </div>
      ))}
    </div>
  );
}

function Traffic({ t, label }) {
  if (!t?.connected) {
    return (
      <div className="od-card">
        <p className="od-card-t">App Store listing: visits &amp; search keywords</p>
        <p className="od-note" style={{ fontSize: 13 }}>
          Not connected yet. The numbers are in Google Analytics (the listing already sends them there); the
          dashboard needs read-only access: a Google Cloud service account added as a Viewer on the GA4
          property, with its JSON key saved as the Fly secret <b>GA4_SERVICE_ACCOUNT</b>.
        </p>
      </div>
    );
  }
  if (t.error) {
    return (
      <div className="od-card">
        <p className="od-card-t">App Store listing: visits &amp; search keywords</p>
        <p className="od-note" style={{ color: "var(--zs-bad)" }}>{t.error}</p>
      </div>
    );
  }
  const fromSearch = t.sources.find((x) => x.k === "App Store search")?.n || 0;
  return (
    <div className="od-card">
      <div className="od-card-h"><p className="od-card-t">App Store listing · {label}</p><span className="od-small">from Google Analytics, refreshed every 15 min</span></div>
      <div className="od-grid" style={{ marginTop: 10, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        <div className="od-stat"><div className="od-stat-l">Listing views</div><div className="od-stat-v">{t.views}</div></div>
        <div className="od-stat"><div className="od-stat-l">Visitors</div><div className="od-stat-v">{t.visitors}</div></div>
        <div className="od-stat"><div className="od-stat-l">From search</div><div className="od-stat-v">{t.views ? Math.round((fromSearch / t.views) * 100) : 0}%</div><div className="od-stat-h">{fromSearch} views</div></div>
        <div className="od-stat"><div className="od-stat-l">Install clicks</div><div className="od-stat-v">{t.installClicks}</div><div className="od-stat-h">&ldquo;Install&rdquo; pressed on the listing{t.visitors ? ` · ${Math.round((t.installClicks / t.visitors) * 100)}% of visitors` : ""}</div></div>
        <div className="od-stat"><div className="od-stat-l">Website visits</div><div className="od-stat-v">{t.siteViews}</div><div className="od-stat-h">zs-storesync.zilancer.com · {t.siteVisitors} visitors</div></div>
      </div>
      <div className="od-two" style={{ marginTop: 4 }}>
        <div><p className="od-card-t" style={{ fontSize: 13 }}>Search keywords that led to the listing</p><BarList items={t.keywords} empty="No search visits in this period." /></div>
        <div><p className="od-card-t" style={{ fontSize: 13 }}>Where visitors came from</p><BarList items={t.sources} empty="No visits in this period." /></div>
      </div>
      {t.events?.length > 0 && <p className="od-note">Listing events: {t.events.map((e) => `${e.k} ${e.n}`).join(" · ")}</p>}
    </div>
  );
}

const TABS = [
  ["all", "All", () => true],
  ["active", "Active", (r) => r.active],
  ["stuck", "Stuck", (r) => r.stuck],
  ["live", "Using the widget", (r) => r.active && r.live],
  ["paid", "Paid", (r) => r.active && r.paid],
  ["free", "Free", (r) => r.active && !r.paid],
  ["noreview", "Not reviewed", (r) => r.active && !r.reviewedAt],
  ["shut", "Closed / frozen / dormant", (r) => r.shut],
  ["left", "Left", (r) => !r.active && !r.shut],
];

function mailtoFor(r) {
  const setup = r.stage === "Installed" || r.stage === "Connected a store";
  const subject = setup ? "Want a hand with your first store migration?" : "How is ZS StoreSync working for you?";
  const body = setup
    ? "Hi,\n\nThanks for installing ZS StoreSync. I noticed you haven't copied any data yet. Tell me which store you're moving from and what you need (products, collections, pages, customers…) and we'll run the first migration with you, free.\n\nBest,\nZilancer LLC · ZS StoreSync"
    : "Hi,\n\nThanks for using ZS StoreSync. Is everything working the way you want? If anything could be better, just reply.\n\nBest,\nZilancer LLC · ZS StoreSync";
  return `mailto:${r.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default function OwnerDashboard() {
  const d = useLoaderData();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const [tab, setTab] = useState("all");
  const [q, setQ] = useState("");
  const [showTest, setShowTest] = useState(false);
  const [dl, setDl] = useState(false);
  const [arm, setArm] = useState(null); // shop whose review request awaits a second click
  const s = d.stats;

  const rows = useMemo(() => {
    const f = TABS.find((t) => t[0] === tab)[2];
    const needle = q.trim().toLowerCase();
    return d.rows.filter((r) => (showTest || (!r.isTest && !r.isDev)) && f(r) &&
      (!needle || r.shop.includes(needle) || r.email.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle) || r.storeName.toLowerCase().includes(needle)));
  }, [d.rows, tab, q, showTest]);
  const counts = useMemo(() => Object.fromEntries(TABS.map(([k, , f]) => [k, d.rows.filter((r) => (showTest || (!r.isTest && !r.isDev)) && f(r)).length])), [d.rows, showTest]);

  const busy = (shop, intent) => fetcher.state !== "idle" && fetcher.formData?.get("shop") === shop && fetcher.formData?.get("intent") === intent;
  const post = (intent, shop, value) => fetcher.submit({ intent, shop, ...(value != null ? { value } : {}) }, { method: "post" });
  const funnelMax = Math.max(1, d.funnel[0]?.n || 1);
  const label = d.periods.find((p) => p.key === d.period)?.label;

  return (
    <>
      <style>{styles}</style>
      <div className="od"><div className="od-in">
        <div className="od-head">
          <div>
            <h1 className="od-title">Owner dashboard</h1>
            <p className="od-sub">Only the owner store can open this page. The numbers leave out test, development, closed, frozen and dormant stores (dormant: nobody opened the app there for 90+ days).</p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div className="od-seg">
              {d.periods.map((p) => (
                <Link key={p.key} to={`?period=${p.key}`} className={p.key === d.period ? "on" : ""} preventScrollReset>{p.label}</Link>
              ))}
            </div>
            <button className="od-btn" disabled={fetcher.state !== "idle" && fetcher.formData?.get("intent") === "check"}
              title="Ask Shopify which stores are open, development, closed or frozen"
              onClick={() => post("check", "")}>
              {fetcher.state !== "idle" && fetcher.formData?.get("intent") === "check" ? "Checking…" : "Check stores"}
            </button>
            <button className="od-btn" onClick={() => navigate("/app")}>← App home</button>
          </div>
        </div>

        <div className="od-grid">
          <div className="od-stat"><div className="od-stat-l">Installed</div><div className="od-stat-v" style={{ color: s.installs ? "var(--zs-ok)" : undefined }}>{s.installs ? `+${s.installs}` : 0}</div><div className="od-stat-h">{label}</div></div>
          <div className="od-stat"><div className="od-stat-l">Uninstalled</div><div className="od-stat-v" style={{ color: s.uninstalls ? "var(--zs-bad)" : undefined }}>{s.uninstalls ? `-${s.uninstalls}` : 0}</div><div className="od-stat-h">{label}</div></div>
          <div className="od-stat"><div className="od-stat-l">Active stores</div><div className="od-stat-v">{s.active}</div><div className="od-stat-h">{s.paid} paid · {s.free} free{s.shut ? ` · ${s.shut} closed, frozen or dormant` : ""}</div></div>
          <div className="od-stat"><div className="od-stat-l">Migrated data</div><div className="od-stat-v">{s.live}</div><div className="od-stat-h">stores with a finished migration or an auto-sync</div></div>
          <div className="od-stat"><div className="od-stat-l">Stuck</div><div className="od-stat-v" style={{ color: s.stuck ? "var(--zs-warn)" : undefined }}>{s.stuck}</div><div className="od-stat-h">installed 2+ days, nothing live</div></div>
          <div className="od-stat"><div className="od-stat-l">Migration runs</div><div className="od-stat-v">{s.runs}</div><div className="od-stat-h">{label} · {s.items} items created</div></div>
          <div className="od-stat"><div className="od-stat-l">Reviewed</div><div className="od-stat-v">{s.reviewed}</div><div className="od-stat-h">{s.notReviewed} active stores not yet</div></div>
          <div className="od-stat"><div className="od-stat-l">Review requests</div><div className="od-stat-v">{s.reviewRequests}</div><div className="od-stat-h">sent, {label?.toLowerCase()}</div></div>
        </div>

        <div className="od-card">
          <div className="od-card-h">
            <div>
              <p className="od-card-t">Merchant growth</p>
              <div>
                <span className="od-big">{s.change > 0 ? "+" : ""}{s.change}</span>
                {s.changePct != null && s.change !== 0 && <span className={s.change > 0 ? "od-up" : "od-down"}>{s.change > 0 ? "↑" : "↓"}{Math.abs(s.changePct)}%</span>}
              </div>
            </div>
            <span className="od-small">{label} · UTC · <span style={{ color: "#1F9E6A" }}>■</span> installs <span style={{ color: "#C0271A" }}>■</span> uninstalls</span>
          </div>
          <Chart series={d.series} />
          <p className="od-note">Exact from 17 Oct 2026, when the event log started. Earlier uninstalls were erased by Shopify&apos;s 48-hour data deletion, so Partners shows more history than this chart.</p>
        </div>

        <Traffic t={d.traffic} label={label} />

        <div className="od-two">
          <div className="od-card">
            <p className="od-card-t">Where active stores stop</p>
            <div className="od-fun">
              {d.funnel.map((f) => (
                <div className="od-fun-row" key={f.label}>
                  <span>{f.label}</span>
                  <div className="od-fun-bar"><i style={{ width: `${(f.n / funnelMax) * 100}%` }} /></div>
                  <b style={{ textAlign: "right" }}>{f.n}</b>
                </div>
              ))}
            </div>
          </div>
          <div className="od-card">
            <p className="od-card-t">Activity · {label}</p>
            {d.activity.length ? (
              <ul className="od-feed">
                {d.activity.map((e, i) => (
                  <li key={i}><time>{new Date(e.at).toISOString().slice(5, 16).replace("T", " ")}</time><span><b>{e.shop.replace(".myshopify.com", "")}</b> {(EVENT_TEXT[e.type] || (() => e.type))(e)}</span></li>
                ))}
              </ul>
            ) : <p className="od-note">Nothing happened in this period.</p>}
          </div>
        </div>

        <div className="od-card" style={{ paddingBottom: 6 }}>
          <div className="od-tabs">
            {TABS.map(([k, l]) => (
              <button key={k} className={`od-tab${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>{l} {counts[k]}</button>
            ))}
            <label className="od-check" style={{ marginLeft: 8 }}><input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} /> show test &amp; dev stores</label>
            <input className="od-search" placeholder="Search store or email" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="od-table">
              <thead><tr>{["Store", "Installed", "Stage", "Plan", "Connected", "Last run", "Runs", "Review", ""].map((h) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.shop} className={r.isTest ? "test" : ""}>
                    <td>
                      <div className="od-shop">{r.storeName || r.shop.replace(".myshopify.com", "")}{r.isTest && <span className="od-chip mut" style={{ marginLeft: 6 }}>test</span>}{r.isDev && <span className="od-chip mut" style={{ marginLeft: 6 }}>dev</span>}</div>
                      <div className="od-small">{r.storeName ? r.shop.replace(".myshopify.com", "") + " · " : ""}{r.email || "no email"}{r.name ? ` · ${r.name}` : ""}</div>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDate(r.installedAt)}{r.uninstalledAt && <div className="od-small">left {fmtDate(r.uninstalledAt)}</div>}</td>
                    <td><span className={`od-chip ${STAGE_CLASS[r.stage]}`}>{r.stage}</span>{r.stuck && <div className="od-small" style={{ color: "var(--zs-warn)" }}>stuck</div>}{r.storeState === "unknown" && <div className="od-small" style={{ maxWidth: 220, whiteSpace: "normal" }}>store check failed{r.storePlan ? `: ${r.storePlan.replace(/^error: /, "")}` : ""}</div>}</td>
                    <td>{r.paid ? <span className="od-chip ok">{r.plan}</span> : <span className="od-chip mut">free</span>}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{r.connections}{r.schedules ? <div className="od-small">{r.schedules} auto-sync</div> : null}{r.isSource ? <div className="od-small">source store</div> : null}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{r.widgetShownAt ? ago(r.widgetShownAt) : <span className="od-small">never</span>}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{r.jobsDone} / {r.jobsTotal}{r.periodRuns ? <div className="od-small">{r.periodRuns} runs, {r.periodItems} items this period</div> : null}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {r.reviewedAt ? <span className="od-chip ok">Reviewed</span> : r.reviewAskedAt ? <span className="od-small">asked {fmtDate(r.reviewAskedAt)}</span> : <span className="od-small">—</span>}
                    </td>
                    <td>
                      <div className="od-acts">
                        {r.active && !r.reviewedAt && (
                          <button className="od-btn p" disabled={!r.canEmail || busy(r.shop, "review")}
                            title={r.canEmail ? "Email this store a review request" : "No email, or the store unsubscribed"}
                            onClick={() => { if (arm === r.shop) { setArm(null); post("review", r.shop); } else setArm(r.shop); }}
                            onBlur={() => setArm((a) => (a === r.shop ? null : a))}>
                            {busy(r.shop, "review") ? "Sending…" : arm === r.shop ? "Click again to send" : r.reviewAskedAt ? "Ask again" : "Ask for review"}
                          </button>
                        )}
                        {r.email && r.active && <a className="od-btn" href={mailtoFor(r)} target="_blank" rel="noreferrer">Email</a>}
                        <label className="od-check"><input type="checkbox" checked={!!r.reviewedAt} onChange={(e) => post("reviewed", r.shop, e.target.checked ? "1" : "0")} /> reviewed</label>
                        <label className="od-check"><input type="checkbox" checked={r.isTest} onChange={(e) => post("test", r.shop, e.target.checked ? "1" : "0")} /> test</label>
                      </div>
                    </td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={9} style={{ textAlign: "center", padding: 30, color: "var(--zs-tx-f)" }}>No stores here.</td></tr>}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", gap: 12, flexWrap: "wrap" }}>
            <span className="od-note" style={{ margin: 0 }}>{d.lastChecked ? `Stores last checked ${ago(d.lastChecked)}. ` : "Press Check stores once to match Partners. "}&ldquo;Reviewed&rdquo; is your own mark: the App Store doesn&apos;t tell apps who reviewed. <a href="https://apps.shopify.com/zs-storesync/reviews" target="_blank" rel="noreferrer">Check the reviews</a>.</span>
            <button className="od-btn" disabled={dl} onClick={async () => { setDl(true); try { await downloadFile("/app/stores-export.csv", "installed-stores.csv"); } finally { setDl(false); } }}>{dl ? "Preparing…" : "Download CSV"}</button>
          </div>
        </div>
      </div></div>
      {fetcher.data?.message && fetcher.state === "idle" && (
        <div className={`od-toast${fetcher.data.ok ? "" : " err"}`}>{fetcher.data.message}</div>
      )}
    </>
  );
}
