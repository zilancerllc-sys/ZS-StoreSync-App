// app/routes/app.stores.jsx
// Admin page: view + download all installed stores.

import { useState } from "react";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { requireOwnerShop } from "../lib/owner.server";
import { downloadFile } from "../lib/download";
import { brandStyles } from "./zs-styles.js";
import { Download, Store, Users, XCircle } from "lucide-react";

export const loader = async ({ request }) => {
  // Cross-shop data — owner store only. See lib/owner.server.js.
  const { session } = await authenticate.admin(request);
  requireOwnerShop(session.shop);

  const [contacts, subscriptions] = await Promise.all([
    db.merchantContact.findMany({ orderBy: { installedAt: "desc" } }),
    db.subscription.findMany(),
  ]);

  const subMap = Object.fromEntries(subscriptions.map((s) => [s.shop, s]));

  const total    = contacts.length;
  const active   = contacts.filter((c) => !c.uninstalledAt).length;
  const inactive = total - active;

  const rows = contacts.map((c) => {
    const sub = subMap[c.shop] ?? {};
    return {
      domain:        c.shop,
      email:         c.email ?? "",
      installedAt:   c.installedAt ? new Date(c.installedAt).toISOString().slice(0, 10) : "",
      uninstalledAt: c.uninstalledAt ? new Date(c.uninstalledAt).toISOString().slice(0, 10) : null,
      status:        c.uninstalledAt ? "Uninstalled" : "Active",
      plan:          sub.plan ?? "free",
      optedIn:       c.optedIn != null ? c.optedIn : null,
    };
  });

  return { total, active, inactive, rows };
};

const pageStyles = `
  .zs-stores-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px;}
  .zs-stores-stat{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:14px;padding:18px 20px;box-shadow:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);}
  .zs-stores-stat-label{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--zs-muted);margin-bottom:8px;}
  .zs-stores-stat-value{font-family:var(--zs-font-display);font-size:34px;font-weight:700;color:var(--zs-dark);line-height:1;}
  .zs-stores-stat-help{font-size:12px;color:var(--zs-camel);margin-top:6px;}
  .zs-stores-stat-value.glow{color:var(--zs-sage-deep);}
  .zs-stores-card{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:14px;padding:20px;box-shadow:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);margin-bottom:16px;}
  .zs-stores-card-title{font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--zs-muted);margin:0 0 14px;}
  .zs-stores-btn{background:var(--zs-clay);color:#fff;border:none;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:8px;}
  .zs-stores-btn:disabled{opacity:.55;cursor:not-allowed;}
  .zs-stores-btn:hover:not(:disabled){background:var(--zs-clay-deep);}
  .zs-stores-table{width:100%;border-collapse:collapse;font-size:13px;}
  .zs-stores-table th{text-align:left;padding:9px 14px;font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--zs-muted);background:var(--zs-cream-tint);border-bottom:1px solid var(--zs-border);white-space:nowrap;}
  .zs-stores-table td{padding:10px 14px;border-bottom:1px solid var(--zs-border);color:var(--zs-dark-2);}
  .zs-stores-table tr:last-child td{border-bottom:none;}
  .zs-stores-table tr:nth-child(even) td{background:rgba(250,243,230,.4);}
  .zs-stores-wrap{overflow-x:auto;border-radius:14px;border:1px solid var(--zs-border);}
  .zs-badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700;}
  .zs-badge.active{background:var(--zs-sage-soft);color:var(--zs-sage-deep);}
  .zs-badge.uninstalled{background:#fbeaea;color:#9a3412;}
  .zs-badge.plan{background:var(--zs-cream-tint);color:var(--zs-clay-deep);}
`;

export default function StoresPage() {
  const { total, active, inactive, rows } = useLoaderData();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");

  async function handleDownload() {
    setDownloading(true);
    setError("");
    try {
      await downloadFile("/app/stores-export.csv", "installed-stores.csv");
    } catch (e) {
      setError(e?.message || "Download failed.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <s-page heading="Installed Stores">
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap zs-reveal">
            <div className="zs-sec-eyebrow">App Owner</div>
            <h2 className="zs-sec-title">Installed Stores</h2>

            {/* ── Stats ─────────────────────────────────────────────────── */}
            <div className="zs-stores-grid">
              <div className="zs-stores-stat">
                <div className="zs-stores-stat-label">Total installs</div>
                <div className="zs-stores-stat-value">{total}</div>
                <div className="zs-stores-stat-help">All time</div>
              </div>
              <div className="zs-stores-stat">
                <div className="zs-stores-stat-label">Active</div>
                <div className="zs-stores-stat-value glow">{active}</div>
                <div className="zs-stores-stat-help">Currently installed</div>
              </div>
              <div className="zs-stores-stat">
                <div className="zs-stores-stat-label">Uninstalled</div>
                <div className="zs-stores-stat-value">{inactive}</div>
                <div className="zs-stores-stat-help">Churned stores</div>
              </div>
              <div className="zs-stores-stat">
                <div className="zs-stores-stat-label">Format</div>
                <div className="zs-stores-stat-value" style={{ fontSize: 22 }}>.CSV</div>
                <div className="zs-stores-stat-help">Excel / Sheets ready</div>
              </div>
            </div>

            {/* ── Download ──────────────────────────────────────────────── */}
            <div className="zs-stores-card">
              <div className="zs-stores-card-title">// Download</div>
              <p style={{ fontSize: 13, color: "var(--zs-muted)", lineHeight: 1.6, margin: "0 0 16px" }}>
                CSV includes: shop domain, owner name, owner email, install date, uninstall date, plan, and email opt-in.
                Opens directly in Microsoft Excel or Google Sheets.
              </p>
              {total === 0 ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--zs-muted)", fontSize: 13 }}>
                  No stores yet.
                </div>
              ) : (
                <>
                  <button
                    className="zs-stores-btn"
                    onClick={handleDownload}
                    disabled={downloading}
                  >
                    <Download size={14} />
                    {downloading ? " Preparing…" : " Download stores CSV"}
                  </button>
                  {error && (
                    <div style={{ marginTop: 12, fontSize: 13, color: "#ff6464", display: "flex", alignItems: "center", gap: 6 }}>
                      <XCircle size={13} /> {error}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ── Table ─────────────────────────────────────────────────── */}
            {rows.length > 0 && (
              <div className="zs-stores-wrap">
                <table className="zs-stores-table">
                  <thead>
                    <tr>
                      <th>Domain</th>
                      <th>Email</th>
                      <th>Installed</th>
                      <th>Plan</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.domain}>
                        <td style={{ fontWeight: 600 }}>{row.domain}</td>
                        <td style={{ color: "var(--zs-muted)" }}>{row.email || "—"}</td>
                        <td style={{ color: "var(--zs-muted)", whiteSpace: "nowrap" }}>{row.installedAt}</td>
                        <td>
                          <span className="zs-badge plan">{row.plan}</span>
                        </td>
                        <td>
                          <span className={`zs-badge ${row.uninstalledAt ? "uninstalled" : "active"}`}>
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
