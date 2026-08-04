import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRevalidator, Link as RouterLink } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getUsage, filterAllowedTypes } from "../credits.server";
import { getVerifiedConnection } from "../connection.server";
import { startMigrationJob, getActiveJob } from "../jobs.server";
import {
  listSchedules,
  upsertSchedule,
  deleteSchedule,
} from "../schedules.server";
// Client-safe: the component below renders cadence labels, and React Router
// only strips server imports that stay inside loader/action.
import {
  planAllowsSchedule,
  planAllowsFrequency,
  SCHEDULE_FREQUENCIES,
  FREQUENCY_LABEL,
} from "../schedule-config";
import { brandStyles } from "./zs-styles.js";
import {
  Zap,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock,
  Lock,
  Trash2,
} from "lucide-react";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const connections = await db.storeConnection.findMany({
    // only code-verified pairings can be used as a sync source
    where: { ownerShop: shop, authorized: true, codeVerified: true },
    orderBy: { lastUsedAt: "desc" },
  });
  const usage = await getUsage(shop);
  const schedules = await listSchedules(shop);
  return {
    connections: connections.map((c) => ({
      sourceShop: c.sourceShop,
      lastUsedAt: c.lastUsedAt,
    })),
    allowedTypes: usage.allowedTypes,
    limits: usage.limits,
    remaining: usage.remaining,
    allowsOverage: usage.allowsOverage,
    plan: usage.plan,
    canSchedule: planAllowsSchedule(usage.plan),
    allowedFrequencies: SCHEDULE_FREQUENCIES[usage.plan] || [],
    schedules: schedules.map((s) => ({
      sourceShop: s.sourceShop,
      dataTypes: s.dataTypes ? s.dataTypes.split(",") : [],
      frequency: s.frequency,
      hourUtc: s.hourUtc,
      dayOfWeek: s.dayOfWeek,
      enabled: s.enabled,
      lastError: s.lastError,
      notify: s.notify,
      notifyEmail: s.notifyEmail,
      // Formatted server-side: rendering a date during render would differ
      // between SSR and the browser and break hydration on this route.
      nextRunLabel: new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(s.nextRunAt),
      lastRunLabel: s.lastRunAt
        ? new Intl.DateTimeFormat("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "UTC",
          }).format(s.lastRunAt)
        : null,
    })),
  };
};

const Q_SHOP_EMAIL = `#graphql { shop { email } }`;

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "run");
  const sourceShop = String(form.get("sourceShop") || "").trim();
  const types = String(form.get("types") || "").split(",").filter(Boolean);

  // ── Automatic sync: save or remove the schedule ───────────────────────────
  if (intent === "schedule" || intent === "unschedule") {
    const conn = await getVerifiedConnection(shop, sourceShop);
    if (!conn) return { ok: false, error: "That store pairing isn't verified." };

    if (intent === "unschedule") {
      await deleteSchedule(shop, sourceShop);
      return { ok: true, scheduleRemoved: true };
    }

    const usage = await getUsage(shop);
    const frequency = String(form.get("frequency") || "");
    if (!planAllowsSchedule(usage.plan)) {
      return {
        ok: false,
        error: "Automatic sync isn't included on the Free plan. Upgrade to schedule syncs.",
      };
    }
    if (!planAllowsFrequency(usage.plan, frequency)) {
      return {
        ok: false,
        error: `The ${usage.plan} plan doesn't include ${FREQUENCY_LABEL[frequency] || frequency} syncs.`,
      };
    }
    const { allowed } = await filterAllowedTypes(shop, types);
    if (allowed.length === 0)
      return { ok: false, error: "Pick at least one data type your plan includes." };

    // Whatever the merchant typed wins; otherwise seed from the store's own
    // contact address so notifications work without them filling anything in.
    let notifyEmail = String(form.get("notifyEmail") || "").trim();
    if (!notifyEmail) {
      try {
        const res = await admin.graphql(Q_SHOP_EMAIL);
        notifyEmail = (await res.json())?.data?.shop?.email || "";
      } catch {
        // Not worth failing the save over — the schedule still runs, silently.
      }
    }

    await upsertSchedule({
      ownerShop: shop,
      sourceShop,
      dataTypes: allowed,
      frequency,
      hourUtc: Math.min(23, Math.max(0, Number(form.get("hourUtc")) || 0)),
      dayOfWeek: Math.min(6, Math.max(0, Number(form.get("dayOfWeek")) || 0)),
      notify: form.get("notify") === "on",
      notifyEmail: notifyEmail || null,
    });
    return { ok: true, scheduleSaved: true };
  }

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
  // null = the database rejected a second concurrent run (see app.migrate.jsx).
  if (!jobId) {
    return {
      ok: false,
      error:
        "A migration or sync is already running for this store. Wait for it to finish (see History).",
    };
  }

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
  .zs-chk{font-size:13px;font-weight:600;padding:8px 14px;border:1px solid var(--zs-border);border-radius:20px;cursor:pointer;user-select:none;transition:all .15s;background:none;font-family:inherit;color:inherit;}
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
  .zs-auto-head{display:flex;gap:12px;align-items:flex-start;margin-bottom:16px;}
  .zs-auto-ico{width:40px;height:40px;border-radius:11px;background:var(--zs-clay-soft);color:var(--zs-clay-deep);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .zs-auto-head h3{font-family:var(--zs-font-display);font-size:17px;font-weight:600;margin:2px 0 3px;color:var(--zs-dark);}
  .zs-auto-head p{font-size:12.5px;color:var(--zs-muted);margin:0;line-height:1.55;max-width:560px;}
  .zs-locked{display:flex;gap:9px;align-items:flex-start;background:var(--zs-cream-tint);border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);padding:13px 15px;font-size:13px;color:var(--zs-clay-deep);line-height:1.55;}
  .zs-locked svg{flex-shrink:0;margin-top:2px;}
  .zs-locked a{color:var(--zs-clay-deep);font-weight:700;}
  .zs-sched-state{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border:1px solid var(--zs-border);border-left:3px solid var(--zs-sage-deep);border-radius:0 var(--zs-r-sm) var(--zs-r-sm) 0;padding:12px 14px;margin-bottom:14px;font-size:13px;color:var(--zs-dark);background:var(--zs-cream-soft);}
  .zs-sched-state.off{border-left-color:var(--zs-muted);opacity:.75;}
  .zs-sched-meta{font-size:12px;color:var(--zs-muted);margin-top:3px;}
  .zs-btn-link{background:none;border:none;font-family:inherit;font-size:12.5px;font-weight:600;color:var(--zs-muted);cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:4px 0;}
  .zs-btn-link:hover{color:#9a3412;}
  .zs-sched-form{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;}
  .zs-field{display:flex;flex-direction:column;gap:5px;}
  .zs-field>span{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--zs-muted);}
  .zs-field .zs-select{min-width:150px;}
  .zs-sched-hint{font-size:12px;color:var(--zs-muted);margin-top:11px;line-height:1.55;}
  .zs-check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--zs-dark);cursor:pointer;padding-bottom:11px;}
  .zs-check input{width:16px;height:16px;accent-color:var(--zs-clay);cursor:pointer;}
  .zs-field input.zs-input{min-width:230px;flex:none;}
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
  const {
    connections, allowedTypes, remaining, limits, allowsOverage,
    plan, canSchedule, allowedFrequencies, schedules,
  } = useLoaderData();
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
              Already migrated before? Pull only what&apos;s new since last time. Items
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
                        <button key={t.id}
                          type="button"
                          className={`zs-chk ${picked.includes(t.id) ? "on" : ""} ${locked ? "lock" : ""}`}
                          aria-pressed={picked.includes(t.id)}
                          onClick={() => toggle(t.id)}>
                          {t.name}{meta}
                        </button>
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

            <AutoSyncCard
              src={src}
              picked={picked}
              connections={connections}
              canSchedule={canSchedule}
              allowedFrequencies={allowedFrequencies}
              schedules={schedules}
              plan={plan}
            />
          </div>
        </div>
      </div>
    </s-page>
  );
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ─── Automatic sync ──────────────────────────────────────────────────────────
// Set once and the same delta sync runs on its own. Everything is re-checked at
// run time, so a downgrade or an unpaired store pauses the schedule instead of
// failing quietly.
function AutoSyncCard({
  src,
  picked,
  connections,
  canSchedule,
  allowedFrequencies,
  schedules,
  plan,
}) {
  const scheduleFetcher = useFetcher();
  const existing = schedules.find((s) => s.sourceShop === src) || null;

  const [frequency, setFrequency] = useState(
    existing?.frequency || allowedFrequencies[0] || "daily",
  );
  const [hourUtc, setHourUtc] = useState(existing?.hourUtc ?? 3);
  const [dayOfWeek, setDayOfWeek] = useState(existing?.dayOfWeek ?? 1);
  const [notify, setNotify] = useState(existing?.notify ?? true);
  const [notifyEmail, setNotifyEmail] = useState(existing?.notifyEmail ?? "");

  // Switching source store swaps which schedule is being edited.
  useEffect(() => {
    setFrequency(existing?.frequency || allowedFrequencies[0] || "daily");
    setHourUtc(existing?.hourUtc ?? 3);
    setDayOfWeek(existing?.dayOfWeek ?? 1);
    setNotify(existing?.notify ?? true);
    setNotifyEmail(existing?.notifyEmail ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (connections.length === 0) return null;
  const saving = scheduleFetcher.state !== "idle";

  return (
    <div className="zs-card" style={{ marginTop: 22 }}>
      <div className="zs-auto-head">
        <div className="zs-auto-ico">
          <Clock size={19} />
        </div>
        <div>
          <h3>Automatic sync</h3>
          <p>
            Run this sync on a schedule, without opening the app. Only new items
            are created — the same as pressing Sync yourself.
          </p>
        </div>
      </div>

      {!canSchedule ? (
        <div className="zs-locked">
          <Lock size={15} />
          <span>
            Automatic sync isn&apos;t included on the {plan} plan.{" "}
            <RouterLink to="/app/plan">See plans</RouterLink> — Starter syncs
            weekly, Growth daily, Pro every 6 hours.
          </span>
        </div>
      ) : (
        <>
          {existing && (
            <div className={`zs-sched-state ${existing.enabled ? "on" : "off"}`}>
              <div>
                <b>{FREQUENCY_LABEL[existing.frequency] || existing.frequency}</b>
                {" · "}
                {existing.dataTypes.length} data type
                {existing.dataTypes.length === 1 ? "" : "s"}
                <div className="zs-sched-meta">
                  Next run {existing.nextRunLabel} UTC
                  {existing.lastRunLabel ? ` · last ran ${existing.lastRunLabel} UTC` : ""}
                </div>
              </div>
              <scheduleFetcher.Form method="post">
                <input type="hidden" name="intent" value="unschedule" />
                <input type="hidden" name="sourceShop" value={src} />
                <button className="zs-btn-link" disabled={saving}>
                  <Trash2 size={13} /> Turn off
                </button>
              </scheduleFetcher.Form>
            </div>
          )}

          {existing?.lastError && (
            <div className="zs-banner err" style={{ marginBottom: 12 }}>
              <AlertCircle size={16} /> {existing.lastError}
            </div>
          )}

          <scheduleFetcher.Form method="post" className="zs-sched-form">
            <input type="hidden" name="intent" value="schedule" />
            <input type="hidden" name="sourceShop" value={src} />
            <input type="hidden" name="types" value={picked.join(",")} />

            <label className="zs-field">
              <span>How often</span>
              <select
                className="zs-select"
                name="frequency"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
              >
                {allowedFrequencies.map((f) => (
                  <option key={f} value={f}>
                    {FREQUENCY_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>

            {frequency === "weekly" && (
              <label className="zs-field">
                <span>Day</span>
                <select
                  className="zs-select"
                  name="dayOfWeek"
                  value={dayOfWeek}
                  onChange={(e) => setDayOfWeek(Number(e.target.value))}
                >
                  {DAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {frequency !== "every6h" && (
              <label className="zs-field">
                <span>Time (UTC)</span>
                <select
                  className="zs-select"
                  name="hourUtc"
                  value={hourUtc}
                  onChange={(e) => setHourUtc(Number(e.target.value))}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, "0")}:00
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="zs-check">
              <input
                type="checkbox"
                name="notify"
                checked={notify}
                onChange={(e) => setNotify(e.target.checked)}
              />
              <span>Email me the results</span>
            </label>

            {notify && (
              <label className="zs-field">
                <span>Send to</span>
                <input
                  className="zs-input"
                  type="email"
                  name="notifyEmail"
                  value={notifyEmail}
                  placeholder="your store's contact email"
                  onChange={(e) => setNotifyEmail(e.target.value)}
                />
              </label>
            )}

            <button className="zs-btn" disabled={saving || picked.length === 0}>
              {saving ? (
                <>
                  <Loader2 size={15} className="zs-spin" /> Saving…
                </>
              ) : (
                <>
                  <Clock size={15} /> {existing ? "Update schedule" : "Turn on"}
                </>
              )}
            </button>
          </scheduleFetcher.Form>

          <div className="zs-sched-hint">
            Uses the data types selected above ({picked.length ? picked.join(", ") : "none yet"}).
            Runs are billed against your monthly quota just like manual ones, and
            appear in History. You&apos;ll only be emailed when a run adds
            something or fails — a sync that finds nothing new stays quiet.
          </div>

          {scheduleFetcher.data?.error && (
            <div className="zs-banner err">
              <AlertCircle size={16} /> {scheduleFetcher.data.error}
            </div>
          )}
          {scheduleFetcher.data?.scheduleSaved && (
            <div className="zs-banner ok">
              <CheckCircle2 size={16} /> Automatic sync is on.
            </div>
          )}
          {scheduleFetcher.data?.scheduleRemoved && (
            <div className="zs-banner ok">
              <CheckCircle2 size={16} /> Automatic sync turned off.
            </div>
          )}
        </>
      )}
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
