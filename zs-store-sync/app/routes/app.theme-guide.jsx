import { useState } from "react";
import { Link as RouterLink, useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getUsage, filterAllowedTypes } from "../credits.server";
import { getVerifiedConnection, listConnections } from "../connection.server";
import { startMigrationJob, getActiveJob } from "../jobs.server";
import { brandStyles } from "./zs-styles.js";
import { useT } from "../i18n";
import { Palette, AlertCircle, Lock, CheckCircle2, Wand2 } from "lucide-react";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const connections = (await listConnections(session.shop)).filter((c) => c.authorized && c.codeVerified);
  const usage = await getUsage(session.shop);
  return {
    connections: connections.map((c) => c.sourceShop),
    canTheme: (usage.limits.theme || 0) > 0,
    themeLeft: usage.remaining.theme || 0,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const sourceShop = String(form.get("sourceShop") || "").trim();
  const conn = await getVerifiedConnection(shop, sourceShop);
  if (!conn) return { ok: false, error: "That store pairing isn't verified." };
  const { allowed } = await filterAllowedTypes(shop, ["theme"]);
  if (!allowed.length) return { ok: false, error: "Automatic theme copy is on the Growth and Pro plans." };
  const usage = await getUsage(shop);
  const left = Math.max((usage.limits.theme || 0) - (usage.usage.theme || 0), 0);
  if (!left) return { ok: false, error: "Monthly limit reached for: theme. Upgrade your plan for more." };
  const srcSession = await db.session.findFirst({ where: { shop: sourceShop, isOnline: false } });
  if (!srcSession?.accessToken) return { ok: false, error: "Source not authorized." };
  const busy = "A migration or sync is already running for this store. Wait for it to finish (see History).";
  if (await getActiveJob(shop)) return { ok: false, error: busy };
  const jobId = await startMigrationJob({
    shop,
    sourceShop,
    mode: "migrate",
    types: ["theme"],
    limits: { theme: left },
    options: { themeLicence: form.get("licence") === "on" },
  });
  return jobId ? { ok: true, started: true } : { ok: false, error: busy };
};

function AutoCopyCard() {
  const t = useT();
  const { connections, canTheme } = useLoaderData();
  const fetcher = useFetcher();
  const [src, setSrc] = useState(connections[0] || "");
  const [licence, setLicence] = useState(false);
  const res = fetcher.data;
  return (
    <div className="zs-card">
      <div className="zs-step">
        <span className="zs-num">
          <Wand2 size={14} />
        </span>
        <div style={{ flex: 1 }}>
          <h3>{t("Or let ZS StoreSync copy it")}</h3>
          <p>{t("Copies the source store's live theme into this store as a new, unpublished theme, then checks that the products, collections, pages, menus and images it points at are here, and lists app blocks that need their app installed. A Theme Store theme is licensed per store, so only your customizations are copied onto the same theme, which must already be on this store. Undo in History deletes the copy.")}</p>
          <p style={{ fontSize: 12.5, color: "var(--zs-muted)" }}>{t("This needs a theme permission Shopify grants separately. Until Shopify approves it, a run tells you it is waiting and nothing changes — use the steps below meanwhile.")}</p>
          {!canTheme ? (
            <div className="zs-warn">
              <Lock size={15} />
              <span>
                {t("Automatic theme copy is on the Growth and Pro plans.")} <RouterLink to="/app/plan">{t("See plans")}</RouterLink>
              </span>
            </div>
          ) : connections.length === 0 ? (
            <p>{t("No authorized source stores. Connect one on the Migrate page.")}</p>
          ) : (
            <fetcher.Form method="post" style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
              <select name="sourceShop" value={src} onChange={(e) => setSrc(e.target.value)} aria-label={t("Source store")} style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid var(--zs-border)", maxWidth: 360 }}>
                {connections.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                <input type="checkbox" name="licence" checked={licence} onChange={(e) => setLicence(e.target.checked)} />
                <span>{t("If it's a custom theme (not from the Theme Store): I own it, or my licence lets me use it on this store too.")}</span>
              </label>
              <button className="zs-btn-theme" disabled={fetcher.state !== "idle"}>
                {t("Copy the theme")}
              </button>
            </fetcher.Form>
          )}
          {res?.error && (
            <div className="zs-warn">
              <AlertCircle size={15} /> {t(res.error)}
            </div>
          )}
          {res?.started && (
            <div className="zs-warn">
              <CheckCircle2 size={15} />
              <span>
                {t("Started. Follow it in {history}.", { history: <RouterLink to="/app/history">{t("History")}</RouterLink> })}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');
  .zs-root{--zs-font-display:"Fraunces",serif;--zs-font-body:"Hanken Grotesk",sans-serif;--zs-r-sm:10px;--zs-r-lg:20px;--zs-shadow-sm:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);font-family:var(--zs-font-body);color:var(--zs-dark);}
  .zs-section-wrap{width:100vw;position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;padding:1.5rem;box-sizing:border-box;}
  .zs-wrap{max-width:900px;margin:0 auto;}
  .zs-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:6px;}
  .zs-title{font-family:var(--zs-font-display);font-size:22px;font-weight:600;margin:0 0 4px;}
  .zs-sub{font-size:13px;color:var(--zs-muted);margin:0 0 18px;line-height:1.55;}
  .zs-card{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:1.4rem 1.6rem;box-shadow:var(--zs-shadow-sm);margin-top:16px;}
  .zs-step{display:flex;gap:14px;align-items:flex-start;}
  .zs-num{width:28px;height:28px;border-radius:50%;background:var(--zs-clay);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;}
  .zs-step h3{font-family:var(--zs-font-display);font-size:16px;font-weight:600;margin:3px 0 6px;}
  .zs-step p,.zs-step li{font-size:13.5px;line-height:1.6;margin:0 0 6px;}
  .zs-step ul{margin:4px 0 0;padding-left:18px;}
  .zs-path{font-weight:600;color:var(--zs-clay-deep);}
  .zs-warn{display:flex;gap:10px;align-items:flex-start;background:var(--zs-cream-tint);border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);padding:13px 15px;font-size:13px;line-height:1.6;color:var(--zs-clay-deep);margin-top:16px;}
  .zs-warn svg{flex-shrink:0;margin-top:2px;}
  .zs-warn a,.zs-step a{color:var(--zs-clay-deep);font-weight:700;}
  .zs-btn-theme{align-self:flex-start;background:var(--zs-clay);color:#fff;border:none;padding:11px 20px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;}
  .zs-btn-theme:disabled{opacity:.5;cursor:not-allowed;}
`;

function Step({ n, title, children }) {
  return (
    <div className="zs-card">
      <div className="zs-step">
        <span className="zs-num">{n}</span>
        <div>
          <h3>{title}</h3>
          {children}
        </div>
      </div>
    </div>
  );
}

export default function ThemeGuide() {
  const t = useT();
  return (
    <s-page heading={t("Copy your theme")}>
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap">
            <div className="zs-eyebrow">
              <Palette size={12} /> {t("Theme")}
            </div>
            <h2 className="zs-title">{t("Copy your theme to the other store")}</h2>
            <p className="zs-sub">
              {t("Shopify has its own way to move a theme between stores: download it from one store and upload it to the other. Then ZS StoreSync copies the content the theme points at, so its sections show the right products, pages, menus and images.")}
            </p>

            <AutoCopyCard />

            <Step n={1} title={t("Download the theme from the source store")}>
              <p>
                {t("In the source store's Shopify admin go to {path}. Next to the theme, open the {menu} menu and choose {action}.", {
                  path: <span className="zs-path">{t("Online Store › Themes")}</span>,
                  menu: <b>…</b>,
                  action: <b>{t("Download theme file")}</b>,
                })}
              </p>
              <p>{t("Shopify emails a ZIP file to the store owner's email address. It can take a few minutes.")}</p>
            </Step>

            <Step n={2} title={t("Upload it to this store")}>
              <p>
                {t("In this store's admin go to {path}, choose {action}, and pick the ZIP file. The theme is added unpublished, so your live store doesn't change.", {
                  path: <span className="zs-path">{t("Online Store › Themes")}</span>,
                  action: <b>{t("Add theme › Upload zip file")}</b>,
                })}
              </p>
              <p>{t("Shopify accepts theme files up to 50 MB.")}</p>
            </Step>

            <Step n={3} title={t("Copy what the theme shows")}>
              <p>
                {t("A theme stores links to things, not the things themselves. Run a migration with these data types so every link finds its target:")}
              </p>
              <ul>
                <li>{t("Files — the images and videos picked in the theme editor")}</li>
                <li>{t("Metafields and Metaobjects — the definitions and entries that dynamic sources read")}</li>
                <li>{t("Products, Collections, Pages and Blog Posts — the items sections are pointed at, matched by handle")}</li>
                <li>{t("Menus — the header and footer navigation, matched by handle")}</li>
                <li>{t("Translations — if the store sells in more than one language")}</li>
              </ul>
              <p>
                <RouterLink to="/app/migrate">{t("Start a migration")} →</RouterLink>
              </p>
            </Step>

            <Step n={4} title={t("Check it, then publish")}>
              <p>{t("Open the new theme in the theme editor and look through each template. Re-pick any section that shows as empty — usually a product, collection or image whose handle or file name is different on this store.")}</p>
              <p>{t("Blocks added by other apps (reviews, upsells, chat…) only work after the same app is installed on this store.")}</p>
              <p>{t("When it looks right, publish it from Online Store › Themes.")}</p>
            </Step>

            <div className="zs-warn">
              <AlertCircle size={16} />
              <span>
                <b>{t("Theme licences.")}</b>{" "}
                {t("A paid theme from the Shopify Theme Store is licensed to one store. To use it on a second store, buy it for that store from the Theme Store — Shopify may ask you to before you can publish it. Free themes (such as Dawn or Horizon) and custom themes you own or have a licence for can be used on both.")}
              </span>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
