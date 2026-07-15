import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { getUsage } from "../credits.server";
import { getVerifiedConnection } from "../connection.server";
import { previewCounts } from "../migrator.server";
import { brandStyles } from "./zs-styles.js";
import { Eye, Loader2, AlertCircle, Package, Layers } from "lucide-react";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const connections = await db.storeConnection.findMany({
    // only code-verified pairings can be previewed
    where: { ownerShop: shop, authorized: true, codeVerified: true },
    orderBy: { createdAt: "desc" },
  });
  const usage = await getUsage(shop);
  return {
    connections: connections.map((c) => ({ sourceShop: c.sourceShop })),
    allowedTypes: usage.allowedTypes,
    limits: usage.limits,
    remaining: usage.remaining,
    allowsOverage: usage.allowsOverage,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const sourceShop = String(form.get("sourceShop") || "").trim();
  const types = String(form.get("types") || "").split(",").filter(Boolean);

  if (!sourceShop || types.length === 0) {
    return { ok: false, error: "Select a source store and data types." };
  }

  // SECURITY: only code-verified pairings may read the source store's counts.
  const conn = await getVerifiedConnection(shop, sourceShop);
  if (!conn) {
    return {
      ok: false,
      error:
        "This source store isn't verified for your store. Connect it with its connection code on the Migrate page first.",
    };
  }

  const srcSession = await db.session.findFirst({
    where: { shop: sourceShop, isOnline: false },
  });
  if (!srcSession?.accessToken) {
    return { ok: false, error: "Source not authorized. Connect it on the Migrate page." };
  }

  const { admin: source } = await unauthenticated.admin(sourceShop);
  const { admin: target } = await unauthenticated.admin(shop);

  const counts = await previewCounts({ source, target, types });
  return { ok: true, counts, sourceShop };
};

const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');
  .zs-root{--zs-font-display:"Fraunces",serif;--zs-font-body:"Hanken Grotesk",sans-serif;--zs-r-sm:10px;--zs-r-md:14px;--zs-r-lg:20px;--zs-shadow-sm:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);--zs-shadow-clay:0 10px 30px rgba(169,139,118,.28);font-family:var(--zs-font-body);color:var(--zs-dark);}
  .zs-section-wrap{width:100vw;position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;padding:1.5rem;box-sizing:border-box;}
  .zs-wrap{max-width:1400px;margin:0 auto;}
  .zs-sec-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:6px;}
  .zs-sec-title{font-family:var(--zs-font-display);font-size:22px;font-weight:600;margin:0 0 4px;}
  .zs-sec-sub{font-size:13px;color:var(--zs-muted);margin:0 0 18px;}
  .zs-card{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:1.6rem;box-shadow:var(--zs-shadow-sm);}
  .zs-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;}
  .zs-select{padding:12px 14px;border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);font-size:14px;font-family:inherit;background:var(--zs-cream-soft);color:var(--zs-dark);min-width:240px;}
  .zs-chk-row{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0;}
  .zs-chk{font-size:13px;font-weight:600;padding:8px 14px;border:1px solid var(--zs-border);border-radius:20px;cursor:pointer;user-select:none;transition:all .15s;}
  .zs-chk.on{background:var(--zs-clay-soft);border-color:var(--zs-clay);color:var(--zs-clay-deep);}
  .zs-chk.lock{opacity:.4;cursor:not-allowed;}
  .zs-btn{background:var(--zs-clay);color:#fff;border:none;padding:12px 22px;border-radius:var(--zs-r-sm);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:8px;box-shadow:var(--zs-shadow-clay);}
  .zs-btn:disabled{opacity:.5;cursor:not-allowed;}
  .zs-table{width:100%;border-collapse:collapse;margin-top:16px;}
  .zs-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--zs-muted);padding:10px 12px;border-bottom:1px solid var(--zs-border);}
  .zs-table td{padding:12px;border-bottom:1px solid var(--zs-border);font-size:14px;}
  .zs-table td.num{font-family:var(--zs-font-display);font-weight:600;}
  .zs-diff{font-size:12px;font-weight:600;color:var(--zs-sage-deep);}
  .zs-banner.err{display:flex;gap:9px;align-items:center;background:#fbeaea;color:#9a3412;border:1px solid #f3d2d2;padding:13px 15px;border-radius:var(--zs-r-sm);font-size:13px;margin-top:14px;}
  .zs-spin{animation:zsRot 1s linear infinite;}@keyframes zsRot{to{transform:rotate(360deg);}}
  @keyframes zsFadeUp{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}
  .zs-reveal{animation:zsFadeUp .5s ease forwards;}
`;

const TYPES = [
  { id: "products", name: "Products" },
  { id: "collections", name: "Collections" },
  { id: "pages", name: "Pages" },
  { id: "discounts", name: "Discounts" },
  { id: "files", name: "Files" },
  { id: "menus", name: "Menus" },
  { id: "redirects", name: "Redirects" },
  { id: "metaobjects", name: "Metaobjects" },
  { id: "blogPosts", name: "Blog Posts" },
  { id: "metafields", name: "Metafields" },
];

export default function Preview() {
  const { connections, allowedTypes, limits, remaining, allowsOverage } = useLoaderData();
  const fetcher = useFetcher();
  const [src, setSrc] = useState(connections[0]?.sourceShop || "");
  const [picked, setPicked] = useState(["products", "collections"]);

  const busy = fetcher.state !== "idle";
  const data = fetcher.data;

  const toggle = (id) => {
    if (!allowedTypes.includes(id)) return;
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  return (
    <s-page heading="Preview & Compare">
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap zs-reveal">
            <div className="zs-sec-eyebrow">Dry Run</div>
            <h2 className="zs-sec-title">Preview &amp; Compare</h2>
            <p className="zs-sec-sub">
              See how many items exist in the source vs this store before you migrate.
              Nothing is changed.
            </p>

            <div className="zs-card">
              {connections.length === 0 ? (
                <div className="zs-banner err">
                  <AlertCircle size={16} /> No authorized source stores yet. Connect one on the Migrate page first.
                </div>
              ) : (
                <fetcher.Form method="post">
                  <div className="zs-row">
                    <select
                      className="zs-select"
                      name="sourceShop"
                      value={src}
                      onChange={(e) => setSrc(e.target.value)}
                    >
                      {connections.map((c) => (
                        <option key={c.sourceShop} value={c.sourceShop}>
                          {c.sourceShop}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="zs-chk-row">
                    {TYPES.map((t) => {
                      const locked = !allowedTypes.includes(t.id);
                      const left = remaining[t.id] ?? 0;
                      const lim = limits[t.id] ?? 0;
                      const meta = locked
                        ? ""
                        : allowsOverage
                          ? ` · ${lim}/mo +overage`
                          : ` · ${left}/${lim}`;
                      return (
                        <div
                          key={t.id}
                          className={`zs-chk ${picked.includes(t.id) ? "on" : ""} ${locked ? "lock" : ""}`}
                          onClick={() => toggle(t.id)}
                        >
                          {t.name}{meta}
                        </div>
                      );
                    })}
                  </div>

                  <input type="hidden" name="types" value={picked.join(",")} />
                  <button className="zs-btn" disabled={busy || picked.length === 0}>
                    {busy ? (
                      <><Loader2 size={15} className="zs-spin" /> Comparing…</>
                    ) : (
                      <><Eye size={15} /> Compare Counts</>
                    )}
                  </button>
                </fetcher.Form>
              )}

              {data?.error && (
                <div className="zs-banner err">
                  <AlertCircle size={16} /> {data.error}
                </div>
              )}

              {data?.ok && data.counts && (
                <table className="zs-table">
                  <thead>
                    <tr>
                      <th>Data Type</th>
                      <th>Source ({data.sourceShop})</th>
                      <th>This Store</th>
                      <th>Likely New</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.counts).map(([type, c]) => {
                      const diff =
                        typeof c.source === "number" && typeof c.target === "number"
                          ? Math.max(c.source - c.target, 0)
                          : "—";
                      return (
                        <tr key={type}>
                          <td style={{ textTransform: "capitalize" }}>{type}</td>
                          <td className="num">{c.source}</td>
                          <td className="num">{c.target}</td>
                          <td><span className="zs-diff">+{diff}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
