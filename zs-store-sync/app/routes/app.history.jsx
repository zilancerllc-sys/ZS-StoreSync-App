import { useEffect, useRef, useState } from "react";
import { useLoaderData, useFetcher, Link as RouterLink } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { failStaleJobs } from "../jobs.server";
import { brandStyles } from "./zs-styles.js";
import {
  ArrowLeftRight, ChevronDown, CheckCircle2, AlertCircle, Clock, XCircle,
} from "lucide-react";

// Per-type stats are only useful if they parse into an object of counters —
// anything else (old rows, truncated writes) is treated as "not recorded".
function parseStatsJson(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length
      ? v
      : null;
  } catch {
    return null;
  }
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // jobs left "running" by a server restart are marked failed
  await failStaleJobs(shop);

  // logJson is deliberately NOT selected: each row can hold up to 100 KB of
  // log, so sending 50 of them made this page a multi-megabyte response for a
  // list where the logs are hidden until a row is expanded. The component
  // fetches them from /app/jobs/:id on demand instead.
  const jobs = await db.migrationJob.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      sourceShop: true,
      targetShop: true,
      mode: true,
      dataTypes: true,
      status: true,
      createdCount: true,
      updatedCount: true,
      skippedCount: true,
      failedCount: true,
      itemCount: true,
      summary: true,
      error: true,
      createdAt: true,
      finishedAt: true,
      // Small (a few hundred bytes) unlike logJson, so it rides along with the
      // list instead of needing a second request.
      statsJson: true,
    },
  });

  return {
    jobs: jobs.map((j) => ({
      id: j.id,
      sourceShop: j.sourceShop,
      targetShop: j.targetShop,
      mode: j.mode,
      dataTypes: j.dataTypes ? j.dataTypes.split(",") : [],
      status: j.status,
      created: j.createdCount,
      updated: j.updatedCount,
      skipped: j.skippedCount,
      failed: j.failedCount,
      total: j.itemCount,
      summary: j.summary,
      error: j.error,
      // null for runs from before statsJson existed — the UI falls back to
      // plain type chips for those rather than showing zeroes it cannot back up.
      stats: parseStatsJson(j.statsJson),
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
    })),
  };
};

const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');
  .zs-root{--zs-font-display:"Fraunces",Georgia,serif;--zs-font-body:"Hanken Grotesk",sans-serif;
    --zs-r-sm:10px;--zs-r-md:14px;--zs-r-lg:20px;
    --zs-shadow-sm:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);
    font-family:var(--zs-font-body);-webkit-font-smoothing:antialiased;color:var(--zs-dark);}
  .zs-section-wrap{width:100vw;position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;padding:1.5rem;box-sizing:border-box;}
  .zs-wrap{max-width:1400px;margin:0 auto;width:100%;}
  .zs-sec-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:6px;}
  .zs-sec-title{font-family:var(--zs-font-display);font-size:22px;font-weight:600;margin:0 0 16px;letter-spacing:-.01em;}
  @keyframes zsFadeUp{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:translateY(0);}}
  .zs-reveal{opacity:0;animation:zsFadeUp .5s cubic-bezier(.2,.7,.2,1) forwards;}

  .zs-job{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-md);margin-bottom:10px;overflow:hidden;box-shadow:var(--zs-shadow-sm);}
  /* A real <button> so the row is reachable by keyboard and announced as an
     expandable control; these reset the browser's button chrome. */
  .zs-job-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;cursor:pointer;gap:12px;width:100%;background:none;border:none;font:inherit;color:inherit;text-align:left;}
  .zs-job-head:hover{background:var(--zs-cream-soft);}
  .zs-job-left{display:flex;align-items:center;gap:12px;min-width:0;}
  .zs-job-ico{width:40px;height:40px;border-radius:11px;background:var(--zs-clay-soft);color:var(--zs-clay-deep);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .zs-job-route{font-size:14px;font-weight:600;color:var(--zs-dark);}
  .zs-job-meta{font-size:12px;color:var(--zs-muted);margin-top:3px;}
  .zs-job-right{display:flex;align-items:center;gap:14px;flex-shrink:0;}
  .zs-status{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:5px 11px;border-radius:20px;}
  .zs-status.completed{background:var(--zs-sage-soft);color:var(--zs-sage-deep);}
  .zs-status.partial{background:var(--zs-cream-tint);color:var(--zs-clay-deep);}
  .zs-status.running{background:var(--zs-camel-soft);color:var(--zs-clay-deep);}
  .zs-status.failed{background:#fbeaea;color:#9a3412;}
  .zs-status.queued{background:#eee;color:#777;}
  .zs-chev{color:var(--zs-camel);transition:transform .2s;}
  .zs-chev.open{transform:rotate(180deg);}

  .zs-job-body{padding:0 16px 16px;border-top:1px solid var(--zs-border);}
  .zs-counts{display:flex;gap:8px;margin:14px 0;flex-wrap:wrap;}
  .zs-count{background:var(--zs-cream-soft);border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);padding:8px 14px;}
  .zs-count .v{font-family:var(--zs-font-display);font-size:18px;font-weight:600;}
  .zs-count .l{font-size:10px;text-transform:uppercase;color:var(--zs-muted);letter-spacing:.4px;}
  .zs-types-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;}
  .zs-tchip{font-size:11px;font-weight:600;background:var(--zs-sage-soft);color:var(--zs-sage-deep);padding:3px 10px;border-radius:20px;}

  /* Per-type breakdown. Wrapper scrolls on its own so the five columns never
     force the page into a horizontal scroll on a narrow admin window. */
  .zs-bd-wrap{overflow-x:auto;margin-bottom:14px;border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);background:var(--zs-white);}
  .zs-bd{width:100%;border-collapse:collapse;min-width:420px;}
  .zs-bd th{text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--zs-muted);font-weight:700;padding:9px 12px;background:var(--zs-cream-tint);border-bottom:1px solid var(--zs-border);white-space:nowrap;}
  .zs-bd th:first-child{text-align:left;}
  .zs-bd td{padding:9px 12px;font-size:13px;text-align:right;border-bottom:1px solid var(--zs-border);font-variant-numeric:tabular-nums;}
  .zs-bd tr:last-child td{border-bottom:none;}
  .zs-bd td.ty{text-align:left;font-weight:600;color:var(--zs-dark);}
  .zs-bd td.ok{color:var(--zs-sage-deep);font-weight:700;}
  .zs-bd td.up{color:var(--zs-clay-deep);font-weight:700;}
  .zs-bd td.sk{color:var(--zs-muted);font-weight:600;}
  .zs-bd td.er{color:#9a3412;font-weight:700;}
  /* A zero is context, not a result — keep it readable but out of the way. */
  .zs-bd td.zero{color:var(--zs-border);}
  .zs-bd tr.quiet td.ty{font-weight:500;color:var(--zs-muted);}
  .zs-bd td.none{text-align:left;font-size:12px;color:var(--zs-muted);font-style:italic;}
  .zs-log{background:var(--zs-dark);border-radius:var(--zs-r-md);padding:14px 16px;max-height:240px;overflow:auto;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.7;color:rgba(255,255,255,.8);}
  .zs-log div{white-space:pre-wrap;}
  .zs-empty{padding:3rem 1.5rem;text-align:center;border:1px dashed var(--zs-border);border-radius:var(--zs-r-md);background:var(--zs-white);}
  .zs-empty-t{font-family:var(--zs-font-display);font-size:18px;font-weight:600;margin:12px 0 6px;}
  .zs-empty-s{font-size:13px;color:var(--zs-muted);}
  .zs-btn{background:var(--zs-clay);color:#fff;border:none;padding:11px 20px;border-radius:var(--zs-r-sm);font-size:13px;font-weight:600;text-decoration:none;display:inline-flex;align-items:center;gap:7px;margin-top:14px;}
`;

const statusIcon = (s) =>
  s === "completed" ? <CheckCircle2 size={13} /> :
  s === "partial" ? <AlertCircle size={13} /> :
  s === "running" ? <Clock size={13} /> :
  s === "failed" ? <XCircle size={13} /> : <Clock size={13} />;

// The stored dataTypes are the internal keys ("blogPosts"); show merchants the
// same wording the Migrate page uses when they picked them.
const TYPE_LABEL = {
  products: "Products",
  collections: "Collections",
  pages: "Pages",
  discounts: "Discounts",
  files: "Files",
  menus: "Menus",
  redirects: "Redirects",
  metaobjects: "Metaobjects",
  blogPosts: "Blog Posts",
  metafields: "Metafields",
  orders: "Orders",
  customers: "Customers",
};

export default function History() {
  const { jobs } = useLoaderData();
  const [open, setOpen] = useState(null);

  // Logs are fetched per job the first time its row is expanded, then cached
  // for the rest of the visit. /app/jobs/:id is already scoped to the
  // authenticated shop, so this cannot reach another merchant's job.
  const logFetcher = useFetcher();
  const [logsById, setLogsById] = useState({});
  const requestedRef = useRef(null);

  const toggle = (id) => {
    const next = open === id ? null : id;
    setOpen(next);
    // No "is the fetcher idle" guard: opening a second row while the first is
    // still loading must still fetch, otherwise that row shows "Loading log…"
    // forever. React Router replaces the in-flight request, and the effect
    // below files each response under its own job id.
    if (next && logsById[next] === undefined) {
      requestedRef.current = next;
      logFetcher.load(`/app/jobs/${next}`);
    }
  };

  useEffect(() => {
    if (logFetcher.state !== "idle") return;
    const job = logFetcher.data?.job;
    const id = job?.id ?? requestedRef.current;
    if (!id) return;
    // job is undefined when the request failed (404, network). Cache an empty
    // log rather than leaving the row stuck on "Loading log…".
    setLogsById((prev) =>
      prev[id] === undefined ? { ...prev, [id]: job?.logs || [] } : prev,
    );
  }, [logFetcher.state, logFetcher.data]);

  return (
    <s-page heading="Migration History">
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap zs-reveal">
            <div className="zs-sec-eyebrow">Activity</div>
            <h2 className="zs-sec-title">Migration History</h2>

            {jobs.length === 0 ? (
              <div className="zs-empty">
                <ArrowLeftRight size={34} color="var(--zs-camel)" />
                <div className="zs-empty-t">No migrations yet</div>
                <div className="zs-empty-s">Run your first transfer to see it here.</div>
                <RouterLink to="/app/migrate" className="zs-btn">
                  <ArrowLeftRight size={14} /> Start a Migration
                </RouterLink>
              </div>
            ) : (
              jobs.map((j) => (
                <div key={j.id} className="zs-job">
                  <button
                    type="button"
                    className="zs-job-head"
                    onClick={() => toggle(j.id)}
                    aria-expanded={open === j.id}
                  >
                    <div className="zs-job-left">
                      <div className="zs-job-ico">
                        <ArrowLeftRight size={18} />
                      </div>
                      <div>
                        <div className="zs-job-route">
                          {j.sourceShop} → {j.targetShop}
                        </div>
                        <div className="zs-job-meta">
                          {j.mode} · {new Date(j.createdAt).toLocaleString()}
                          {j.summary ? ` · ${j.summary}` : ""}
                        </div>
                      </div>
                    </div>
                    <div className="zs-job-right">
                      <span className={`zs-status ${j.status}`}>
                        {statusIcon(j.status)} {j.status}
                      </span>
                      <ChevronDown
                        size={18}
                        className={`zs-chev ${open === j.id ? "open" : ""}`}
                      />
                    </div>
                  </button>

                  {open === j.id && (
                    <div className="zs-job-body">
                      {j.stats ? (
                        <div className="zs-bd-wrap">
                          <table className="zs-bd">
                            <thead>
                              <tr>
                                <th>Data type</th>
                                <th>Created</th>
                                <th>Updated</th>
                                <th>Skipped</th>
                                <th>Failed</th>
                              </tr>
                            </thead>
                            <tbody>
                              {j.dataTypes.map((t) => {
                                const s = j.stats[t] || {};
                                const c = s.created || 0;
                                const u = s.updated || 0;
                                const k = s.skipped || 0;
                                const f = s.failed || 0;
                                const empty = !c && !u && !k && !f;
                                return (
                                  <tr key={t} className={empty ? "quiet" : ""}>
                                    <td className="ty">{TYPE_LABEL[t] || t}</td>
                                    {empty ? (
                                      <td className="none" colSpan={4}>
                                        nothing to migrate
                                      </td>
                                    ) : (
                                      <>
                                        <td className={c ? "ok" : "zero"}>{c}</td>
                                        <td className={u ? "up" : "zero"}>{u}</td>
                                        <td className={k ? "sk" : "zero"}>{k}</td>
                                        <td className={f ? "er" : "zero"}>{f}</td>
                                      </>
                                    )}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        // Run predates per-type tracking — show what was
                        // selected rather than counters we do not have.
                        <div className="zs-types-row">
                          {j.dataTypes.map((t) => (
                            <span key={t} className="zs-tchip">
                              {TYPE_LABEL[t] || t}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="zs-counts">
                        <div className="zs-count"><div className="v">{j.created}</div><div className="l">Created</div></div>
                        <div className="zs-count"><div className="v">{j.updated}</div><div className="l">Updated</div></div>
                        <div className="zs-count"><div className="v">{j.skipped}</div><div className="l">Skipped</div></div>
                        <div className="zs-count"><div className="v">{j.failed}</div><div className="l">Failed</div></div>
                        <div className="zs-count"><div className="v">{j.total}</div><div className="l">Total</div></div>
                      </div>
                      {j.error && (
                        <div style={{ color: "#9a3412", fontSize: 13, marginBottom: 12 }}>
                          Error: {j.error}
                        </div>
                      )}
                      {logsById[j.id] === undefined ? (
                        <div className="zs-log">Loading log…</div>
                      ) : (
                        logsById[j.id].length > 0 && (
                          <div className="zs-log">
                            {logsById[j.id].map((l, i) => <div key={i}>{l}</div>)}
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
