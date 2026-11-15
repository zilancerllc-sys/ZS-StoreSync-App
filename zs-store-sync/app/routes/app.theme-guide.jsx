import { Link as RouterLink } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { brandStyles } from "./zs-styles.js";
import { useT } from "../i18n";
import { Palette, AlertCircle } from "lucide-react";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

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
