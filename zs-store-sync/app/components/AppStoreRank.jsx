// app/components/AppStoreRank.jsx
// Owner dashboard card: where the app stands on the App Store -- rating and
// reviews, its position in each of its categories, its position for each
// tracked search keyword, and competitors' review counts. Data comes from
// lib/app-store-rank.server.js (loadRanks); the buttons post to the same route
// with intents rank-check / rank-add / rank-remove.
import { useState } from "react";
import { useFetcher } from "react-router";

const css = `
  .rk-tbl{width:100%;border-collapse:collapse;font-size:13px}
  .rk-tbl th{padding:8px 10px;text-align:left;color:#B98E84;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid rgba(192,39,26,.12);white-space:nowrap}
  .rk-tbl td{padding:8px 10px;border-bottom:1px solid rgba(192,39,26,.12);vertical-align:middle}
  .rk-pos{font-weight:700;font-size:15px;color:#2E0804}
  .rk-up{color:#1F9E6A;font-weight:700;font-size:12px}
  .rk-dn{color:#C0271A;font-weight:700;font-size:12px}
  .rk-mut{color:#B98E84;font-size:12px}
  .rk-x{border:0;background:none;color:#B98E84;cursor:pointer;font-size:15px;padding:0 4px}
  .rk-x:hover{color:#C0271A}
  .rk-add{display:flex;gap:6px;margin-top:10px}
  .rk-add input{border:1px solid rgba(192,39,26,.26);border-radius:8px;padding:7px 10px;font-size:13px;min-width:220px;font-family:inherit}
  .rk-top{font-size:11.5px;color:#8A4E44;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;

// Positions: a smaller number is better, so a drop in the number is a rise.
function Move({ now, then }) {
  if (now == null || then == null) return <span className="rk-mut">—</span>;
  const d = then - now;
  if (!d) return <span className="rk-mut">0</span>;
  return <span className={d > 0 ? "rk-up" : "rk-dn"}>{d > 0 ? "↑" : "↓"}{Math.abs(d)}</span>;
}

// 30 days of positions, #1 at the top; days not found leave a gap.
function Spark({ history }) {
  const pts = history.filter((h) => h.position != null);
  if (pts.length < 2) return <span className="rk-mut">{pts.length ? "1 day" : "—"}</span>;
  const W = 110, H = 26;
  const max = Math.max(...pts.map((p) => p.position)), min = Math.min(...pts.map((p) => p.position));
  const first = Date.parse(history[0].day), span = Math.max(Date.parse(history[history.length - 1].day) - first, 1);
  const x = (h) => ((Date.parse(h.day) - first) / span) * (W - 4) + 2;
  const y = (h) => 3 + ((h.position - min) / Math.max(max - min, 1)) * (H - 6);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-label="Position over 30 days">
      <polyline fill="none" stroke="#0F9D94" strokeWidth="1.8" points={pts.map((h) => `${x(h)},${y(h)}`).join(" ")} />
      <circle cx={x(pts[pts.length - 1])} cy={y(pts[pts.length - 1])} r="2.5" fill="#0F9D94" />
    </svg>
  );
}

// Our stand-in for "keyword difficulty": the average review count of the
// first 10 results. Shopify publishes no search volumes or difficulty.
function Difficulty({ n }) {
  if (n == null) return <span className="rk-mut">—</span>;
  const [cls, label] = n >= 1500 ? ["bad", "Hard"] : n >= 400 ? ["warn", "Medium"] : ["ok", "Easy"];
  return <span className={`od-chip ${cls}`} title={`The first 10 apps average ${n} reviews`}>{label} · {n}</span>;
}

const pos = (n) => (n == null ? <span className="rk-mut">not in top 120</span> : <span className="rk-pos">#{n}</span>);

export default function AppStoreRank({ r }) {
  const fetcher = useFetcher();
  const [kw, setKw] = useState("");
  const [comp, setComp] = useState("");
  if (!r) return null;
  const busy = (intent) => fetcher.state !== "idle" && fetcher.formData?.get("intent") === intent;
  const post = (data) => fetcher.submit(data, { method: "post" });
  const add = (kind, value, clear) => { if (value.trim()) { post({ intent: "rank-add", kind, key: value }); clear(""); } };
  const a = r.app;
  const kws = [...r.keywords].sort((x, y) => (x.position ?? 9999) - (y.position ?? 9999));
  const found = kws.filter((k) => k.position != null).length;
  const top10 = kws.filter((k) => k.position != null && k.position <= 10).length;

  return (
    <div className="od-card">
      <style>{css}</style>
      <div className="od-card-h">
        <div>
          <p className="od-card-t">App Store rank</p>
          <span className="od-small">
            Read from the public App Store once a day{r.lastRun ? `, last ${new Date(r.lastRun).toISOString().slice(0, 16).replace("T", " ")} UTC` : ", not yet"}. Ads are left out.
          </span>
        </div>
        <button className="od-btn" disabled={r.running || busy("rank-check")} onClick={() => post({ intent: "rank-check" })}
          title="Read every keyword and category now (takes a few minutes)">
          {r.running || busy("rank-check") ? "Checking… (a few minutes)" : "Check now"}
        </button>
      </div>

      <div className="od-grid" style={{ marginTop: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <div className="od-stat">
          <div className="od-stat-l">Rating</div>
          <div className="od-stat-v">{a.rating != null ? `${a.rating.toFixed(1)}★` : "—"}</div>
          <div className="od-stat-h">{a.reviews ?? 0} reviews{a.reviewsWeekAgo != null && a.reviews > a.reviewsWeekAgo ? ` · +${a.reviews - a.reviewsWeekAgo} this week` : ""}</div>
        </div>
        {r.categories.map((c) => (
          <div className="od-stat" key={c.key}>
            <div className="od-stat-l">{c.label || c.key}</div>
            <div className="od-stat-v">{c.position != null ? `#${c.position}` : "—"}</div>
            <div className="od-stat-h">
              of {c.total ?? "?"} · page {c.position != null ? Math.ceil(c.position / 24) : "?"} · day <Move now={c.position} then={c.dayAgo} /> · week <Move now={c.position} then={c.weekAgo} />
            </div>
          </div>
        ))}
        <div className="od-stat">
          <div className="od-stat-l">Keywords</div>
          <div className="od-stat-v">{found}/{kws.length}</div>
          <div className="od-stat-h">found in the top 120 · {top10} in the top 10</div>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="rk-tbl">
          <thead><tr><th>Keyword</th><th>Position</th><th>Day</th><th>Week</th><th>30 days</th><th>Difficulty</th><th>Top 3</th><th /></tr></thead>
          <tbody>
            {kws.map((k) => (
              <tr key={k.key}>
                <td><a href={`https://apps.shopify.com/search?q=${encodeURIComponent(k.key)}`} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>{k.key}</a></td>
                <td>{k.day ? pos(k.position) : <span className="rk-mut">not read yet</span>}{k.position != null && <div className="rk-mut">page {Math.ceil(k.position / 24)}</div>}</td>
                <td><Move now={k.position} then={k.dayAgo} /></td>
                <td><Move now={k.position} then={k.weekAgo} /></td>
                <td><Spark history={k.history} /></td>
                <td><Difficulty n={k.topReviews} /></td>
                <td><div className="rk-top" title={k.top.map((t) => `${t.name} (${t.reviews})`).join("\n")}>{k.top.map((t) => t.name).join(" · ") || "—"}</div></td>
                <td><button className="rk-x" title="Stop tracking this keyword" onClick={() => post({ intent: "rank-remove", kind: "keyword", key: k.key })}>×</button></td>
              </tr>
            ))}
            {!kws.length && <tr><td colSpan={8} className="rk-mut" style={{ textAlign: "center", padding: 20 }}>No keywords tracked. Add one below.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="rk-add">
        <input placeholder="Add a search keyword, e.g. copy products" value={kw} onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add("keyword", kw, setKw)} />
        <button className="od-btn" disabled={busy("rank-add")} onClick={() => add("keyword", kw, setKw)}>Add keyword</button>
      </div>

      <p className="od-card-t" style={{ fontSize: 13, marginTop: 18 }}>Competitors</p>
      <div style={{ overflowX: "auto" }}>
        <table className="rk-tbl">
          <thead><tr><th>App</th><th>Rating</th><th>Reviews</th><th>New this week</th><th /></tr></thead>
          <tbody>
            {[{ ...a, label: a.label || "This app", own: true }, ...r.competitors].map((c) => (
              <tr key={c.key} style={c.own ? { background: "#FFF8F6" } : undefined}>
                <td><a href={`https://apps.shopify.com/${c.key}`} target="_blank" rel="noreferrer" style={{ color: "inherit", fontWeight: c.own ? 700 : 500 }}>{c.own ? `${r.handle} (this app)` : c.label || c.key}</a></td>
                <td>{c.rating != null ? `${c.rating.toFixed(1)}★` : "—"}</td>
                <td>{c.reviews != null ? c.reviews.toLocaleString("en-US") : <span className="rk-mut">not read yet</span>}</td>
                <td>{c.reviews != null && c.reviewsWeekAgo != null ? `+${Math.max(0, c.reviews - c.reviewsWeekAgo)}` : <span className="rk-mut">—</span>}</td>
                <td>{!c.own && <button className="rk-x" title="Stop tracking this app" onClick={() => post({ intent: "rank-remove", kind: "competitor", key: c.key })}>×</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rk-add">
        <input placeholder="Competitor handle or apps.shopify.com link" value={comp} onChange={(e) => setComp(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add("competitor", comp, setComp)} />
        <button className="od-btn" disabled={busy("rank-add")} onClick={() => add("competitor", comp, setComp)}>Add competitor</button>
      </div>
      <p className="od-note">Difficulty is our own measure: the average review count of the first 10 apps for that search. Shopify publishes no search volumes, so none are shown.</p>
      {fetcher.data?.rank && fetcher.state === "idle" && <p className="od-note" style={{ color: fetcher.data.ok ? "#1F9E6A" : "#C0271A" }}>{fetcher.data.message}</p>}
    </div>
  );
}
