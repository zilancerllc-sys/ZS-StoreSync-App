import { useEffect, useState } from "react";
import { useLoaderData, useFetcher, useNavigate, Link as RouterLink } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { getUsage } from "../credits.server";
import { getVerifiedConnection, listConnections } from "../connection.server";
import { gql } from "../migrator.server";
import {
  getLiveSettings,
  saveLiveSettings,
  readLocations,
  parseLocationMap,
  parseActivity,
} from "../live-inventory.server";
import { brandStyles } from "./zs-styles.js";
import { useT } from "../i18n";
import {
  normalizePriceRule,
  parsePriceRule,
  priceFieldsFor,
  DEFAULT_PRICE_RULE,
  currencyDecimals,
} from "../lib/price-rules.js";
import { defaultLocationMap, DEFAULT_GUARDS } from "../lib/inventory-guards.js";
import { planHas } from "../lib/plan-features.js";
import { BadgePercent, Warehouse, Lock, AlertCircle, CheckCircle2, Loader2, Eye, PauseCircle } from "lucide-react";

const fmtDate = (d) =>
  d
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(d)
    : null;

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const connections = (await listConnections(shop)).filter((c) => c.authorized && c.codeVerified);
  const wanted = new URL(request.url).searchParams.get("source");
  const conn = connections.find((c) => c.sourceShop === wanted) || connections[0] || null;
  const usage = await getUsage(shop);
  const base = {
    connections: connections.map((c) => c.sourceShop),
    source: conn?.sourceShop || null,
    plan: usage.plan,
    canPrice: planHas(usage.plan, "priceRules"),
    canLive: planHas(usage.plan, "liveInventory"),
  };
  if (!conn) return { ...base, rule: DEFAULT_PRICE_RULE, live: null };

  const rule = parsePriceRule(conn.priceRuleJson) || DEFAULT_PRICE_RULE;
  const settings = await getLiveSettings(shop, conn.sourceShop);

  let sourceLocations = [];
  let targetLocations = [];
  let locationError = null;
  try {
    targetLocations = await readLocations(admin);
    const { admin: source } = await unauthenticated.admin(conn.sourceShop);
    sourceLocations = await readLocations(source);
  } catch (err) {
    locationError = String(err?.message || err).slice(0, 160);
  }
  const saved = parseLocationMap(settings?.locationMapJson);
  const defaults = defaultLocationMap(sourceLocations, targetLocations);
  const locationMap = {};
  for (const l of sourceLocations) {
    locationMap[l.id] = l.id in saved ? saved[l.id] : defaults[l.id] || "";
  }

  return {
    ...base,
    rule,
    live: {
      enabled: !!settings?.enabled,
      paused: !!settings?.pausedAt,
      pauseReason: settings?.pauseReason || null,
      pausedLabel: fmtDate(settings?.pausedAt),
      lastRunLabel: fmtDate(settings?.lastRunAt),
      lastSummary: settings?.lastSummary || null,
      maxZeroPerBatch: settings?.maxZeroPerBatch ?? DEFAULT_GUARDS.maxZeroPerBatch,
      maxUnitChange: settings?.maxUnitChange ?? DEFAULT_GUARDS.maxUnitChange,
      activity: parseActivity(settings?.activityJson).slice(0, 20).map((a) => ({
        ...a,
        atLabel: fmtDate(new Date(a.at)),
      })),
      sourceLocations: sourceLocations.map((l) => ({ id: l.id, name: l.name })),
      targetLocations: targetLocations.map((l) => ({ id: l.id, name: l.name })),
      locationMap,
      locationError,
    },
  };
};

const Q_PREVIEW = `#graphql
  query PricePreview {
    products(first: 10, sortKey: UPDATED_AT, reverse: true) {
      nodes { title variants(first: 3) { nodes { title price compareAtPrice } } }
    }
  }`;
const Q_CURRENCY = `#graphql
  query PreviewCurrency { shop { currencyCode } }`;

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const sourceShop = String(form.get("sourceShop") || "").trim();
  const conn = await getVerifiedConnection(shop, sourceShop);
  if (!conn) return { ok: false, error: "That store pairing isn't verified." };
  const usage = await getUsage(shop);

  const ruleFromForm = () =>
    normalizePriceRule({
      enabled: form.get("enabled"),
      adjust: form.get("adjust"),
      direction: form.get("direction"),
      amount: form.get("amount"),
      rounding: form.get("rounding"),
      compareAt: form.get("compareAt"),
      keepTargetPrices: form.get("keepTargetPrices"),
    });

  if (intent === "savePrice" || intent === "previewPrice") {
    const { rule, error } = ruleFromForm();
    if (error) return { ok: false, intent, error };
    if (intent === "savePrice") {
      if (rule.enabled && !planHas(usage.plan, "priceRules")) {
        return { ok: false, intent, error: "Price rules are on the Starter plan and up." };
      }
      await db.storeConnection.updateMany({
        where: { ownerShop: shop, sourceShop },
        data: { priceRuleJson: JSON.stringify(rule) },
      });
      return { ok: true, intent, saved: true };
    }
    // Preview: the 10 most recently changed source products, nothing written.
    const { admin: source } = await unauthenticated.admin(sourceShop);
    const d = await gql(source, Q_PREVIEW);
    let decimals = 2;
    try {
      decimals = currencyDecimals((await gql(admin, Q_CURRENCY))?.shop?.currencyCode);
    } catch {
      /* 2 decimals */
    }
    const previewRule = { ...rule, enabled: true };
    const rows = [];
    for (const p of d?.products?.nodes || []) {
      for (const v of p.variants?.nodes || []) {
        const { fields, warnings } = priceFieldsFor(v, previewRule, { existing: false, decimals });
        rows.push({
          name: v.title && v.title !== "Default Title" ? `${p.title} / ${v.title}` : p.title,
          price: v.price,
          compareAt: v.compareAtPrice,
          newPrice: fields.price ?? v.price,
          newCompareAt: fields.compareAtPrice ?? null,
          warning: warnings[0] || null,
        });
      }
    }
    return { ok: true, intent, preview: rows.slice(0, 20), keep: rule.keepTargetPrices };
  }

  if (intent === "saveLive") {
    const enabled = form.get("enabled") === "true";
    let sourceLocations = [];
    let targetLocations = [];
    try {
      targetLocations = await readLocations(admin);
      const { admin: source } = await unauthenticated.admin(sourceShop);
      sourceLocations = await readLocations(source);
    } catch (err) {
      return { ok: false, intent, error: `Couldn't read store locations: ${String(err?.message || err).slice(0, 120)}` };
    }
    const locationMap = {};
    for (const l of sourceLocations) locationMap[l.id] = String(form.get(`loc:${l.id}`) || "");
    const r = await saveLiveSettings({
      ownerShop: shop,
      sourceShop,
      enabled,
      locationMap,
      guards: { maxZeroPerBatch: form.get("maxZeroPerBatch"), maxUnitChange: form.get("maxUnitChange") },
      sourceLocations,
      targetLocations,
    });
    return r.error ? { ok: false, intent, error: r.error } : { ok: true, intent, saved: true, enabled };
  }

  return { ok: false, error: "Unknown action." };
};

const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');
  .zs-root{--zs-font-display:"Fraunces",serif;--zs-font-body:"Hanken Grotesk",sans-serif;--zs-r-sm:10px;--zs-r-md:14px;--zs-r-lg:20px;--zs-shadow-sm:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);--zs-shadow-clay:0 10px 30px rgba(169,139,118,.28);font-family:var(--zs-font-body);color:var(--zs-dark);}
  .zs-section-wrap{width:100vw;position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;padding:1.5rem;box-sizing:border-box;}
  .zs-wrap{max-width:1100px;margin:0 auto;}
  .zs-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:6px;}
  .zs-title{font-family:var(--zs-font-display);font-size:22px;font-weight:600;margin:0 0 4px;}
  .zs-sub{font-size:13px;color:var(--zs-muted);margin:0 0 18px;line-height:1.55;}
  .zs-card{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:1.6rem;box-shadow:var(--zs-shadow-sm);margin-top:20px;}
  .zs-head{display:flex;gap:12px;align-items:flex-start;margin-bottom:14px;}
  .zs-ico{width:40px;height:40px;border-radius:11px;background:var(--zs-clay-soft);color:var(--zs-clay-deep);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .zs-head h3{font-family:var(--zs-font-display);font-size:17px;font-weight:600;margin:2px 0 3px;}
  .zs-head p{font-size:12.5px;color:var(--zs-muted);margin:0;line-height:1.55;max-width:640px;}
  .zs-select,.zs-input{padding:10px 12px;border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);font-size:14px;font-family:inherit;background:var(--zs-cream-soft);color:var(--zs-dark);}
  .zs-input{width:110px;}
  .zs-grid{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;}
  .zs-field{display:flex;flex-direction:column;gap:5px;}
  .zs-field>span{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--zs-muted);}
  .zs-check{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-top:14px;}
  .zs-check input{width:16px;height:16px;accent-color:var(--zs-clay);}
  .zs-btn{background:var(--zs-clay);color:#fff;border:none;padding:11px 20px;border-radius:var(--zs-r-sm);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:8px;box-shadow:var(--zs-shadow-clay);}
  .zs-btn:disabled{opacity:.5;cursor:not-allowed;}
  .zs-btn-ghost{background:var(--zs-white);color:var(--zs-clay-deep);border:1px solid var(--zs-border);box-shadow:none;}
  .zs-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;}
  .zs-banner{display:flex;gap:9px;align-items:flex-start;padding:12px 14px;border-radius:var(--zs-r-sm);font-size:13px;margin-top:14px;line-height:1.5;}
  .zs-banner svg{flex-shrink:0;margin-top:1px;}
  .zs-banner.err{background:#fbeaea;color:#9a3412;border:1px solid #f3d2d2;}
  .zs-banner.ok{background:var(--zs-sage-soft);color:var(--zs-sage-deep);border:1px solid #d9e0c4;}
  .zs-banner.info{background:var(--zs-cream-tint);color:var(--zs-clay-deep);border:1px solid var(--zs-border);}
  .zs-banner a{color:inherit;font-weight:700;}
  .zs-table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px;}
  .zs-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--zs-muted);padding:8px 10px;border-bottom:1px solid var(--zs-border);}
  .zs-table td{padding:8px 10px;border-bottom:1px solid var(--zs-border);}
  .zs-note{font-size:12px;color:var(--zs-muted);margin-top:10px;line-height:1.55;}
  .zs-spin{animation:zsRot 1s linear infinite;}@keyframes zsRot{to{transform:rotate(360deg);}}
  @media(max-width:640px){.zs-table{font-size:12px;}}
`;

export default function Rules() {
  const t = useT();
  const data = useLoaderData();
  const navigate = useNavigate();
  const { connections, source } = data;

  return (
    <s-page heading={t("Price & stock rules")}>
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap">
            <div className="zs-eyebrow">{t("Per store pair")}</div>
            <h2 className="zs-title">{t("Price & stock rules")}</h2>
            <p className="zs-sub">
              {t("Rules for everything copied from one source store into this store: migrations, scheduled syncs and instant syncs.")}
            </p>
            {!source ? (
              <div className="zs-banner err" data-nav-anchors="price-rules live-stock">
                <AlertCircle size={16} />
                <span>
                  {t("No authorized source stores. Connect one on the Migrate page.")}{" "}
                  <RouterLink to="/app/migrate">{t("New Migration")}</RouterLink>
                </span>
              </div>
            ) : (
              <>
                <label className="zs-field">
                  <span>{t("Source store")}</span>
                  <select
                    className="zs-select"
                    value={source}
                    onChange={(e) => navigate(`/app/rules?source=${encodeURIComponent(e.target.value)}`)}
                  >
                    {connections.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <PriceRuleCard key={`p-${source}`} {...data} />
                <LiveStockCard key={`l-${source}`} {...data} />
              </>
            )}
          </div>
        </div>
      </div>
    </s-page>
  );
}

function PriceRuleCard({ source, rule, canPrice }) {
  const t = useT();
  const fetcher = useFetcher();
  const [r, setR] = useState(rule);
  const set = (k) => (e) => setR((x) => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const busy = fetcher.state !== "idle";
  const res = fetcher.data;

  const submit = (intent) => {
    const fd = new FormData();
    fd.append("intent", intent);
    fd.append("sourceShop", source);
    for (const [k, v] of Object.entries(r)) fd.append(k, String(v));
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <div className="zs-card" id="price-rules">
      <div className="zs-head">
        <div className="zs-ico">
          <BadgePercent size={19} />
        </div>
        <div>
          <h3>{t("Price rules")}</h3>
          <p>{t("Change prices as they are copied: a markup or markdown, a price ending such as .99, and what happens to compare-at prices. Prices are copied as numbers, so if the two stores use different currencies, a percentage can convert them.")}</p>
        </div>
      </div>
      {!canPrice && (
        <div className="zs-banner info">
          <Lock size={15} />
          <span>
            {t("Price rules are on the Starter plan and up.")} <RouterLink to="/app/plan">{t("See plans")}</RouterLink>
          </span>
        </div>
      )}
      <label className="zs-check">
        <input type="checkbox" checked={!!r.enabled} onChange={set("enabled")} disabled={!canPrice} />
        <span>{t("Use a price rule for this store pair")}</span>
      </label>
      <div className="zs-grid" style={{ marginTop: 14, opacity: r.enabled ? 1 : 0.55 }}>
        <label className="zs-field">
          <span>{t("Change")}</span>
          <select className="zs-select" value={r.adjust} onChange={set("adjust")}>
            <option value="none">{t("No change")}</option>
            <option value="percent">{t("Percentage")}</option>
            <option value="fixed">{t("Fixed amount")}</option>
          </select>
        </label>
        {r.adjust !== "none" && (
          <>
            <label className="zs-field">
              <span>{t("Direction")}</span>
              <select className="zs-select" value={r.direction} onChange={set("direction")}>
                <option value="up">{t("Markup (+)")}</option>
                <option value="down">{t("Markdown (−)")}</option>
              </select>
            </label>
            <label className="zs-field">
              <span>{r.adjust === "percent" ? t("Percent") : t("Amount")}</span>
              <input className="zs-input" type="number" min="0" step="0.01" value={r.amount} onChange={set("amount")} />
            </label>
          </>
        )}
        <label className="zs-field">
          <span>{t("Rounding")}</span>
          <select className="zs-select" value={r.rounding} onChange={set("rounding")}>
            <option value="none">{t("No rounding")}</option>
            <option value="99">{t("End in .99")}</option>
            <option value="95">{t("End in .95")}</option>
            <option value="whole">{t("Whole number")}</option>
          </select>
        </label>
        <label className="zs-field">
          <span>{t("Compare-at price")}</span>
          <select className="zs-select" value={r.compareAt} onChange={set("compareAt")}>
            <option value="same">{t("Same rule as the price")}</option>
            <option value="copy">{t("Copy unchanged")}</option>
            <option value="sourcePrice">{t("Source price (shows as “was”)")}</option>
            <option value="clear">{t("Remove")}</option>
          </select>
        </label>
      </div>
      <label className="zs-check">
        <input type="checkbox" checked={!!r.keepTargetPrices} onChange={set("keepTargetPrices")} />
        <span>{t("Keep this store's prices on products that already exist here (new products still get prices)")}</span>
      </label>
      <p className="zs-note">
        {t("A price the rule would make 0 or less keeps the source price, free items stay free, and a compare-at price that isn't above the new price is removed. Order and discount amounts are never changed.")}
      </p>
      <div className="zs-actions">
        <button type="button" className="zs-btn" disabled={busy} onClick={() => submit("savePrice")}>
          {busy && fetcher.formData?.get("intent") === "savePrice" ? <Loader2 size={15} className="zs-spin" /> : <CheckCircle2 size={15} />}{" "}
          {t("Save price rule")}
        </button>
        <button type="button" className="zs-btn zs-btn-ghost" disabled={busy} onClick={() => submit("previewPrice")}>
          <Eye size={15} /> {t("Preview prices")}
        </button>
      </div>
      {res?.error && (
        <div className="zs-banner err">
          <AlertCircle size={16} /> {t(res.error)}
        </div>
      )}
      {res?.saved && (
        <div className="zs-banner ok">
          <CheckCircle2 size={16} /> {t("Saved. The next run from this store uses it.")}
        </div>
      )}
      {res?.preview && (
        <>
          <p className="zs-note">
            {t("The 10 most recently changed products on {shop}, with the rule applied. Nothing is written.", { shop: source })}
            {res.keep ? ` ${t("Products that already exist on this store keep their prices.")}` : ""}
          </p>
          <table className="zs-table">
            <thead>
              <tr>
                <th>{t("Product")}</th>
                <th>{t("Source price")}</th>
                <th>{t("New price")}</th>
                <th>{t("New compare-at")}</th>
              </tr>
            </thead>
            <tbody>
              {res.preview.map((row, i) => (
                <tr key={i}>
                  <td>{row.name}</td>
                  <td>
                    {row.price}
                    {row.compareAt ? ` (${row.compareAt})` : ""}
                  </td>
                  <td>
                    <b>{row.newPrice}</b>
                    {row.warning ? " ⚠" : ""}
                  </td>
                  <td>{row.newCompareAt || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function LiveStockCard({ source, live, canLive }) {
  const t = useT();
  const fetcher = useFetcher();
  const [map, setMap] = useState(live?.locationMap || {});
  const [maxZero, setMaxZero] = useState(live?.maxZeroPerBatch ?? 20);
  const [maxChange, setMaxChange] = useState(live?.maxUnitChange ?? 1000);
  useEffect(() => setMap(live?.locationMap || {}), [live?.locationMap]);
  if (!live) return null;
  const busy = fetcher.state !== "idle";
  const res = fetcher.data;

  const submit = (enabled) => {
    const fd = new FormData();
    fd.append("intent", "saveLive");
    fd.append("sourceShop", source);
    fd.append("enabled", enabled ? "true" : "false");
    fd.append("maxZeroPerBatch", String(maxZero));
    fd.append("maxUnitChange", String(maxChange));
    for (const [k, v] of Object.entries(map)) fd.append(`loc:${k}`, v || "");
    fetcher.submit(fd, { method: "post" });
  };
  const allTo = (id) => setMap(Object.fromEntries(live.sourceLocations.map((l) => [l.id, id])));

  return (
    <div className="zs-card" id="live-stock">
      <div className="zs-head">
        <div className="zs-ico">
          <Warehouse size={19} />
        </div>
        <div>
          <h3>{t("Live stock sync")}</h3>
          <p>{t("When stock changes on {shop} (a sale, a return, an edit), the same variant on this store is updated about a minute later. One way only: changes on this store are not sent back. Variants are matched by SKU, then barcode.", { shop: source })}</p>
        </div>
      </div>
      {!canLive && (
        <div className="zs-banner info">
          <Lock size={15} />
          <span>
            {t("Live stock sync is on the Growth and Pro plans.")} <RouterLink to="/app/plan">{t("See plans")}</RouterLink>
          </span>
        </div>
      )}
      {live.enabled && live.paused && (
        <div className="zs-banner err">
          <PauseCircle size={16} />
          <span>
            <b>{t("Paused by the safety check on {date} UTC — nothing in that batch was written.", { date: live.pausedLabel })}</b>{" "}
            {live.pauseReason}. {t("Check the stock on the source store, then press Resume.")}
          </span>
        </div>
      )}
      {live.enabled && !live.paused && (
        <div className="zs-banner ok">
          <CheckCircle2 size={16} />
          <span>
            {t("Live stock sync is on.")}
            {live.lastRunLabel ? ` ${t("Last update {date} UTC: {summary}", { date: live.lastRunLabel, summary: live.lastSummary })}` : ` ${t("Waiting for the first stock change.")}`}
          </span>
        </div>
      )}
      {!live.enabled && live.lastSummary && (
        <div className="zs-banner info">
          <AlertCircle size={16} /> {t(live.lastSummary)}
        </div>
      )}
      {live.locationError ? (
        <div className="zs-banner err">
          <AlertCircle size={16} /> {t("Couldn't read store locations: {error}", { error: live.locationError })}
        </div>
      ) : (
        <>
          <table className="zs-table">
            <thead>
              <tr>
                <th>{t("Location on {shop}", { shop: source })}</th>
                <th>{t("Copy its stock to")}</th>
              </tr>
            </thead>
            <tbody>
              {live.sourceLocations.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td>
                    <select
                      className="zs-select"
                      aria-label={t("Copy its stock to")}
                      value={map[l.id] || ""}
                      onChange={(e) => setMap((m) => ({ ...m, [l.id]: e.target.value }))}
                    >
                      <option value="">{t("Don't sync this location")}</option>
                      {live.targetLocations.map((tl) => (
                        <option key={tl.id} value={tl.id}>
                          {tl.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {live.sourceLocations.length > 1 && live.targetLocations.length > 0 && (
            <div className="zs-actions">
              <select className="zs-select" aria-label={t("Send every location to")} value="" onChange={(e) => e.target.value && allTo(e.target.value)}>
                <option value="">{t("Send every location to one location…")}</option>
                {live.targetLocations.map((tl) => (
                  <option key={tl.id} value={tl.id}>
                    {tl.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="zs-note">{t("Several source locations sent to one location are added together.")}</p>
        </>
      )}
      <div className="zs-grid" style={{ marginTop: 14 }}>
        <label className="zs-field">
          <span>{t("Pause if more than this many variants would drop to 0 at once")}</span>
          <input className="zs-input" type="number" min="1" value={maxZero} onChange={(e) => setMaxZero(e.target.value)} />
        </label>
        <label className="zs-field">
          <span>{t("Pause if one change is bigger than (units)")}</span>
          <input className="zs-input" type="number" min="1" value={maxChange} onChange={(e) => setMaxChange(e.target.value)} />
        </label>
      </div>
      <p className="zs-note">
        {t("Safety: stock is never set below 0, a variant the source store doesn't answer for is skipped (never treated as 0), and when a batch trips a limit above, nothing in it is written, live sync pauses and you are emailed. Up to 100 stock changes are copied per minute. For the first copy of all stock, run a Stock levels migration.")}
      </p>
      <div className="zs-actions">
        {live.enabled ? (
          <>
            <button type="button" className="zs-btn" disabled={busy || !canLive || !!live.locationError} onClick={() => submit(true)}>
              {live.paused ? t("Resume") : t("Save")}
            </button>
            <button type="button" className="zs-btn zs-btn-ghost" disabled={busy} onClick={() => submit(false)}>
              {t("Turn off live stock sync")}
            </button>
          </>
        ) : (
          <button type="button" className="zs-btn" disabled={busy || !canLive || !!live.locationError} onClick={() => submit(true)}>
            {t("Turn on live stock sync")}
          </button>
        )}
      </div>
      {res?.error && (
        <div className="zs-banner err">
          <AlertCircle size={16} /> {t(res.error)}
        </div>
      )}
      {live.activity.length > 0 && (
        <table className="zs-table">
          <thead>
            <tr>
              <th>{t("When (UTC)")}</th>
              <th>{t("Variant")}</th>
              <th>{t("Change")}</th>
            </tr>
          </thead>
          <tbody>
            {live.activity.map((a, i) => (
              <tr key={i}>
                <td>{a.atLabel}</td>
                <td>{a.label}</td>
                <td>
                  {a.error
                    ? `✕ ${a.error}`
                    : a.skipped
                      ? `↪ ${a.skipped}`
                      : `${a.from ?? "—"} → ${a.to}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
