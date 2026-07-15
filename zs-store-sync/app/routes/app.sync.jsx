import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getUsage, filterAllowedTypes } from "../credits.server";
import { getVerifiedConnection } from "../connection.server";
import { startMigrationJob, getActiveJob } from "../jobs.server";
import { brandStyles } from "./zs-styles.js";
import { Zap, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const connections = await db.storeConnection.findMany({
    // only code-verified pairings can be used as a sync source
    where: { ownerShop: shop, authorized: true, codeVerified: true },
    orderBy: { lastUsedAt: "desc" },
  });
  const usage = await getUsage(shop);
  return {
    connections: connections.map((c) => ({
      sourceShop: c.sourceShop,
      lastUsedAt: c.lastUsedAt,
    })),
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

  if (!sourceShop || types.length === 0)
    return { ok: false, error: "Pick a source and data types." };

  // SECURITY: same rule as Migrate — only sources paired with this store via
  // a valid connection code can be read. Without this, any merchant could
  // pull data from any store that has the app installed.
  const conn = await getVerifiedConnection(shop, sourceShop);
  if (!conn) {
    return {
      ok: false,
      error:
        "This source store isn't verified for your store. Connect it with its connection code on the Migrate page first.",
    };
  }

  const { allowed } = await filterAllowedTypes(shop, types);
  if (allowed.length === 0)
    return { ok: false, error: "Your plan doesn't include these types." };

  // Per-type limits from the shop's plan + window usage
  const usage = await getUsage(shop);
  const planLimits = usage.limits;
  const usedSoFar = usage.usage;
  const allowsOverage = usage.allowsOverage;

  const migrateLimits = {};
  const exhaustedTypes = [];
  for (const t of allowed) {
    const rem = Math.max((planLimits[t] || 0) - (usedSoFar[t] || 0), 0);
    if (allowsOverage) {
      migrateLimits[t] = Infinity;
    } else {
      if (rem <= 0) exhaustedTypes.push(t);
      migrateLimits[t] = rem;
    }
  }
  if (!allowsOverage && exhaustedTypes.length > 0) {
    return {
      ok: false,
      error: `Monthly limit reached for: ${exhaustedTypes.join(", ")}. Upgrade your plan.`,
    };
  }

  const srcSession = await db.session.findFirst({
    where: { shop: sourceShop, isOnline: false },
  });
  if (!srcSession?.accessToken)
    return { ok: false, error: "Source not authorized." };

  // one job at a time per shop
  const active = await getActiveJob(shop);
  if (active) {
    return {
      ok: false,
      error:
        "A migration or sync is already running for this store. Wait for it to finish (see History).",
    };
  }

  // Sync uses the same engine — duplicates are detected live against the
  // target, so items that already exist are skipped and only NEW items get
  // created. Runs as a background job; the client polls /app/jobs/:id.
  const jobId = await startMigrationJob({
    shop,
    sourceShop,
    mode: "sync",
    types: allowed,
    limits: migrateLimits,
  });

  return { ok: true, started: true, jobId };
};

const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');
  .zs-root{--zs-font-display:"Fraunces",serif;--zs-font-body:"Hanken Grotesk",sans-serif;--zs-r-sm:10px;--zs-r-md:14px;--zs-r-lg:20px;--zs-shadow-sm:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);--zs-shadow-clay:0 10px 30px rgba(169,139,118,.28);font-family:var(--zs-font-body);color:var(--zs-dark);}
  .zs-section-wrap{width:100vw;position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;padding:1.5rem;box-sizing:border-box;}
  .zs-wrap{max-width:1400px;margin:0 auto;}
  .zs-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:6px;}
  .zs-title{font-family:var(--zs-font-display);font-size:22px;font-weight:600;margin:0 0 4px;}
  .zs-sub{font-size:13px;color:var(--zs-muted);margin:0 0 18px;line-height:1.5;}
  .zs-card{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:1.6rem;box-shadow:var(--zs-shadow-sm);}
  .zs-select{padding:12px 14px;border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);font-size:14px;font-family:inherit;background:var(--zs-cream-soft);min-width:260px;color:var(--zs-dark);}
  .zs-chk-row{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0;}
  .zs-chk{font-size:13px;font-weight:600;padding:8px 14px;border:1px solid var(--zs-border);border-radius:20px;cursor:pointer;user-select:none;transition:all .15s;}
  .zs-chk.on{background:var(--zs-clay-soft);border-color:var(--zs-clay);color:var(--zs-clay-deep);}
  .zs-chk.lock{opacity:.4;cursor:not-allowed;}
  .zs-btn{background:var(--zs-clay);color:#fff;border:none;padding:12px 22px;border-radius:var(--zs-r-sm);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:8px;box-shadow:var(--zs-shadow-clay);}
  .zs-btn:disabled{opacity:.5;cursor:not-allowed;}
  .zs-banner{display:flex;gap:9px;align-items:center;padding:13px 15px;border-radius:var(--zs-r-sm);font-size:13px;margin-top:14px;}
  .zs-banner.err{background:#fbeaea;color:#9a3412;border:1px solid #f3d2d2;}
  .zs-banner.ok{background:var(--zs-sage-soft);color:var(--zs-sage-deep);border:1px solid #d9e0c4;}
  .zs-log{margin-top:14px;background:var(--zs-dark);border-radius:var(--zs-r-md);padding:14px 16px;max-height:240px;overflow:auto;font-family:ui-monospace,monospace;font-size:12px;line-height:1.7;color:rgba(255,255,255,.8);}
  .zs-log div{white-space:pre-wrap;}
  .zs-spin{animation:zsRot 1s linear infinite;}@keyframes zsRot{to{transform:rotate(360deg);}}
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

export default function Sync() {
  const { connections, allowedTypes, remaining, limits, allowsOverage } = useLoaderData();
  const fetcher = useFetcher();
  const jobFetcher = useFetcher();
  const revalidator = useRevalidator();
  const [src, setSrc] = useState(connections[0]?.sourceShop || "");
  const [picked, setPicked] = useState(["products"]);
  const [activeJobId, setActiveJobId] = useState(null);
  const data = fetcher.data;

  const job = jobFetcher.data?.job;
  const jobRunning =
    !!activeJobId && (!job || job.id !== activeJobId || !job.finished);
  const busy = fetcher.state !== "idle" || jobRunning;

  useEffect(() => {
    if (fetcher.data?.started && fetcher.data.jobId) {
      setActiveJobId(fetcher.data.jobId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  useEffect(() => {
    if (!activeJobId) return undefined;
    if (job?.id === activeJobId && job?.finished) {
      revalidator.revalidate();
      return undefined;
    }
    const t = setInterval(() => {
      if (jobFetcher.state === "idle") {
        jobFetcher.load(`/app/jobs/${activeJobId}`);
      }
    }, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId, job?.id, job?.finished]);

  const toggle = (id) => {
    if (!allowedTypes.includes(id)) return;
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  return (
    <s-page heading="Sync Changes">
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap">
            <div className="zs-eyebrow">Delta Sync</div>
            <h2 className="zs-title">Sync Changes</h2>
            <p className="zs-sub">
              Already migrated before? Pull only what's new since last time. Items
              that already exist in this store are skipped automatically — only new
              ones are created.
            </p>

            <div className="zs-card">
              {connections.length === 0 ? (
                <div className="zs-banner err">
                  <AlertCircle size={16} /> No authorized source stores. Connect one on the Migrate page.
                </div>
              ) : (
                <fetcher.Form method="post">
                  <select
                    className="zs-select" name="sourceShop"
                    value={src} onChange={(e) => setSrc(e.target.value)}
                  >
                    {connections.map((c) => (
                      <option key={c.sourceShop} value={c.sourceShop}>{c.sourceShop}</option>
                    ))}
                  </select>
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
                        <div key={t.id}
                          className={`zs-chk ${picked.includes(t.id) ? "on" : ""} ${locked ? "lock" : ""}`}
                          onClick={() => toggle(t.id)}>
                          {t.name}{meta}
                        </div>
                      );
                    })}
                  </div>
                  <input type="hidden" name="types" value={picked.join(",")} />
                  <button className="zs-btn" disabled={busy || picked.length === 0}>
                    {busy ? (<><Loader2 size={15} className="zs-spin" /> Syncing…</>) : (<><Zap size={15} /> Sync New Items</>)}
                  </button>
                </fetcher.Form>
              )}

              {data?.error && (
                <div className="zs-banner err"><AlertCircle size={16} /> {data.error}</div>
              )}
              {jobRunning && (
                <>
                  <div className="zs-banner ok" style={{ background: "var(--zs-cream-tint)", color: "var(--zs-clay-deep)", borderColor: "var(--zs-border)" }}>
                    <Loader2 size={16} className="zs-spin" /> Sync running in the background — live progress below.
                  </div>
                  {job?.logs?.length > 0 && (
                    <div className="zs-log">
                      {job.logs.map((l, i) => <div key={i}>{l}</div>)}
                    </div>
                  )}
                </>
              )}
              {job?.finished && job.id === activeJobId && (
                <>
                  {job.status === "failed" ? (
                    <div className="zs-banner err">
                      <AlertCircle size={16} /> Sync failed{job.error ? ` — ${job.error}` : "."}
                    </div>
                  ) : (
                    <div className="zs-banner ok">
                      <CheckCircle2 size={16} /> Synced — {job.created} new items added, {job.skipped} already up to date.
                    </div>
                  )}
                  {job.logs?.length > 0 && (
                    <div className="zs-log">
                      {job.logs.map((l, i) => <div key={i}>{l}</div>)}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
