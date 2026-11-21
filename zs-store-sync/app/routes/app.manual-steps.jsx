import { useEffect, useState } from "react";
import { Link as RouterLink, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { brandStyles } from "./zs-styles.js";
import { useT } from "../i18n";
import { MANUAL_STEPS, adminUrl } from "../lib/manual-steps.js";
import { ListChecks, ExternalLink, CheckCircle2, Circle } from "lucide-react";

// Shown on the store being copied INTO: every link opens that store's admin.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return {
    shop: session.shop,
    steps: MANUAL_STEPS.map((s) => ({ ...s, url: adminUrl(session.shop, s.path) })),
  };
};

const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');
  .zs-root{--zs-font-display:"Fraunces",serif;--zs-font-body:"Hanken Grotesk",sans-serif;--zs-r-sm:10px;--zs-r-lg:20px;--zs-shadow-sm:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);font-family:var(--zs-font-body);color:var(--zs-dark);}
  .zs-section-wrap{width:100vw;position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;padding:1.5rem;box-sizing:border-box;}
  .zs-wrap{max-width:900px;margin:0 auto;}
  .zs-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:6px;display:flex;gap:6px;align-items:center;}
  .zs-title{font-family:var(--zs-font-display);font-size:22px;font-weight:600;margin:0 0 4px;}
  .zs-sub{font-size:13px;color:var(--zs-muted);margin:0 0 18px;line-height:1.55;}
  .zs-list{display:flex;flex-direction:column;gap:10px;}
  .zs-item{display:flex;gap:12px;align-items:flex-start;background:var(--zs-white);border:1px solid var(--zs-border);border-radius:14px;padding:14px 16px;box-shadow:var(--zs-shadow-sm);}
  .zs-item.done{opacity:.6;}
  .zs-tick{background:none;border:none;padding:0;cursor:pointer;color:var(--zs-clay);flex-shrink:0;margin-top:1px;}
  .zs-item h3{font-size:14.5px;font-weight:700;margin:0 0 4px;}
  .zs-item p{font-size:13px;line-height:1.55;margin:0 0 6px;color:var(--zs-dark-2);}
  .zs-item a{font-size:13px;font-weight:700;color:var(--zs-clay-deep);display:inline-flex;gap:4px;align-items:center;}
  .zs-count{font-size:13px;color:var(--zs-muted);margin:0 0 12px;}
`;

const storageKey = (shop) => `zs-manual-steps:${shop}`;

export default function ManualSteps() {
  const t = useT();
  const { shop, steps } = useLoaderData();
  const [done, setDone] = useState([]);
  // Ticks are a per-person reminder only; nothing depends on them.
  useEffect(() => {
    try {
      setDone(JSON.parse(window.localStorage.getItem(storageKey(shop)) || "[]"));
    } catch {
      setDone([]);
    }
  }, [shop]);
  const toggle = (id) => {
    setDone((list) => {
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      try {
        window.localStorage.setItem(storageKey(shop), JSON.stringify(next));
      } catch {
        /* not saved — fine */
      }
      return next;
    });
  };
  return (
    <s-page heading={t("Manual steps")} inlineSize="large">
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap">
            <div className="zs-eyebrow">
              <ListChecks size={12} /> {t("Not copyable by Shopify")}
            </div>
            <h2 className="zs-title">{t("Finish these on this store by hand")}</h2>
            <p className="zs-sub">
              {t("Shopify keeps these settings out of every app, so no migration app can copy them. Each link opens the right page in this store's admin. Everything else is copied from the {migrate} page.", {
                migrate: <RouterLink to="/app/migrate">{t("New Migration")}</RouterLink>,
              })}
            </p>
            <p className="zs-count">
              {t("{done} of {total} done", { done: done.filter((d) => steps.some((s) => s.id === d)).length, total: steps.length })}
            </p>
            <div className="zs-list">
              {steps.map((s) => {
                const isDone = done.includes(s.id);
                return (
                  <div key={s.id} className={`zs-item ${isDone ? "done" : ""}`}>
                    <button
                      type="button"
                      className="zs-tick"
                      onClick={() => toggle(s.id)}
                      aria-pressed={isDone}
                      aria-label={t("Mark as done")}
                    >
                      {isDone ? <CheckCircle2 size={20} /> : <Circle size={20} />}
                    </button>
                    <div>
                      <h3>{t(s.title)}</h3>
                      <p>{t(s.why)}</p>
                      {s.appPath ? (
                        <RouterLink to={s.appPath}>{t("Open the guide")} →</RouterLink>
                      ) : (
                        <a href={s.url} target="_top" rel="noreferrer">
                          {t("Open in Shopify admin")} <ExternalLink size={12} />
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
