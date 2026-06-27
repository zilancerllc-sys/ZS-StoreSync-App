import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useState } from "react";
import {
  getUsage,
  PLAN_PRICE,
  PLAN_PRICE_ANNUAL,
  PLAN_ANNUAL_SAVINGS,
  PLAN_LIMITS,
} from "../credits.server";
import { brandStyles } from "./zs-styles.js";
import { Check, ExternalLink } from "lucide-react";

// App handle used to build the Shopify Managed Pricing URL.
const APP_HANDLE = "zs-storesync";

// ─── Loader ──────────────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const usage = await getUsage(session.shop);
  return {
    shop: session.shop,
    current: usage.plan,
    usage: usage.usage,
    limits: usage.limits,
    planPrice: PLAN_PRICE,
    planPriceAnnual: PLAN_PRICE_ANNUAL,
    planSavings: PLAN_ANNUAL_SAVINGS,
    planLimits: PLAN_LIMITS,
  };
};

const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');
  .zs-root{--zs-font-display:"Fraunces",serif;--zs-font-body:"Hanken Grotesk",sans-serif;--zs-r-sm:10px;--zs-r-md:14px;--zs-r-lg:20px;--zs-shadow-sm:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);--zs-shadow-md:0 4px 14px rgba(58,49,40,.06),0 18px 40px rgba(58,49,40,.06);--zs-shadow-clay:0 10px 30px rgba(169,139,118,.28);font-family:var(--zs-font-body);color:var(--zs-dark);}
  .zs-section-wrap{width:100vw;position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;padding:1.5rem;box-sizing:border-box;}
  .zs-wrap{max-width:1400px;margin:0 auto;}
  .zs-head{text-align:center;margin-bottom:24px;}
  .zs-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:8px;}
  .zs-title{font-family:var(--zs-font-display);font-size:30px;font-weight:600;margin:0 0 8px;letter-spacing:-.02em;}
  .zs-sub{font-size:14px;color:var(--zs-muted);}
  .zs-toggle-wrap{display:flex;justify-content:center;margin:18px 0 30px;}
  .zs-toggle{display:inline-flex;background:var(--zs-cream-soft);border:1px solid var(--zs-border);border-radius:30px;padding:4px;gap:4px;}
  .zs-toggle button{border:none;background:transparent;font-family:inherit;font-size:13px;font-weight:600;color:var(--zs-muted);padding:8px 18px;border-radius:24px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;transition:background .15s,color .15s;}
  .zs-toggle button.active{background:var(--zs-clay);color:#fff;box-shadow:var(--zs-shadow-clay);}
  .zs-toggle .zs-save-pill{font-size:10px;font-weight:700;background:var(--zs-sage-soft);color:var(--zs-sage-deep);padding:2px 7px;border-radius:20px;}
  .zs-toggle button.active .zs-save-pill{background:rgba(255,255,255,.22);color:#fff;}
  .zs-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;}
  .zs-plan{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:1.6rem;position:relative;box-shadow:var(--zs-shadow-sm);display:flex;flex-direction:column;transition:transform .2s,box-shadow .2s;}
  .zs-plan:hover{transform:translateY(-4px);box-shadow:var(--zs-shadow-md);}
  .zs-plan.featured{border-color:var(--zs-clay);box-shadow:var(--zs-shadow-clay);}
  .zs-plan.current{border-color:var(--zs-sage-deep);}
  .zs-tag{position:absolute;top:-11px;left:50%;transform:translateX(-50%);background:var(--zs-clay);color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;padding:4px 14px;border-radius:20px;white-space:nowrap;}
  .zs-tag.cur{background:var(--zs-sage-deep);}
  .zs-pname{font-family:var(--zs-font-display);font-size:20px;font-weight:600;margin-bottom:6px;}
  .zs-price{font-family:var(--zs-font-display);font-size:34px;font-weight:600;letter-spacing:-.02em;line-height:1.1;}
  .zs-price small{font-size:13px;color:var(--zs-muted);font-weight:500;}
  .zs-price-sub{font-size:12px;color:var(--zs-sage-deep);font-weight:600;margin-top:4px;min-height:16px;}
  .zs-price-sub.muted{color:var(--zs-muted);font-weight:500;}
  .zs-pdesc{font-size:13px;color:var(--zs-muted);margin:10px 0 16px;line-height:1.5;}
  .zs-feats{list-style:none;padding:0;margin:0 0 20px;flex:1;}
  .zs-feats li{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;color:var(--zs-dark);padding:6px 0;}
  .zs-feats li svg{color:var(--zs-sage-deep);flex-shrink:0;margin-top:2px;}
  .zs-cta{width:100%;box-sizing:border-box;padding:12px;border-radius:var(--zs-r-sm);font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;border:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:transform .15s,background .15s;text-decoration:none;}
  .zs-cta.primary{background:var(--zs-clay);color:#fff;box-shadow:var(--zs-shadow-clay);}
  .zs-cta.primary:hover{transform:translateY(-2px);background:var(--zs-clay-deep);}
  .zs-cta.ghost{background:var(--zs-cream-soft);color:var(--zs-clay-deep);border:1px solid var(--zs-border);}
  .zs-cta.ghost:hover{background:var(--zs-clay-soft);}
  .zs-cta.disabled{opacity:.6;cursor:default;pointer-events:none;}
  .zs-foot{text-align:center;margin-top:22px;font-size:12px;color:var(--zs-muted);}
  .zs-usage{margin-top:30px;max-width:680px;margin-left:auto;margin-right:auto;background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:1.4rem 1.6rem;box-shadow:var(--zs-shadow-sm);}
  .zs-usage-head{font-size:13px;font-weight:700;color:var(--zs-dark);margin-bottom:12px;}
  .zs-usage-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 24px;}
  .zs-usage-row{display:flex;justify-content:space-between;font-size:13px;color:var(--zs-muted);padding:3px 0;}
  .zs-usage-row b{color:var(--zs-dark);}
  @media(max-width:1100px){.zs-grid{grid-template-columns:repeat(2,1fr);}}
  @media(max-width:620px){.zs-grid{grid-template-columns:1fr;}.zs-usage-grid{grid-template-columns:1fr;}}
`;

const PLAN_DESC = {
  free: "Try it out — core content types with a generous monthly quota.",
  starter: "For active store moves — adds files, discounts, menus & more.",
  growth: "Higher limits across every data type for larger catalogs.",
  pro: "Maximum limits for big migrations and ongoing syncs.",
};

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

const DISPLAY_TYPES = [
  "products",
  "collections",
  "pages",
  "discounts",
  "files",
  "menus",
  "redirects",
  "metaobjects",
  "blogPosts",
  "metafields",
  "orders",
  "customers",
];

const fmt = (n) => (n >= 5000 || n === 1000 ? `${n / 1000}k` : `${n}`);

function featureLines(L) {
  return [
    `${fmt(L.products)} Products`,
    `${fmt(L.collections)} Collections`,
    `${fmt(L.pages)} Pages, ${fmt(L.discounts)} Discounts`,
    `${fmt(L.files)} Files, ${fmt(L.menus)} Menus, ${fmt(L.redirects)} Redirects`,
    `${fmt(L.metaobjects)} Metaobjects`,
    `${fmt(L.blogPosts)} Blog Posts`,
    `${fmt(L.metafields)} Metafields`,
    `${fmt(L.orders)} Orders, ${fmt(L.customers)} Customers`,
  ];
}

// Build the Shopify Managed Pricing page URL for this app + store.
// e.g. https://admin.shopify.com/store/zs-storesync/charges/zs-storesync/pricing_plans
function managedPricingUrl(shop) {
  const storeHandle = String(shop || "").replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${storeHandle}/charges/${APP_HANDLE}/pricing_plans`;
}

export default function Plan() {
  const {
    shop,
    current,
    usage,
    planPrice,
    planPriceAnnual,
    planSavings,
    planLimits,
  } = useLoaderData();
  const [annual, setAnnual] = useState(false);

  const maxSavings = Math.max(...Object.values(planSavings));
  const pricingUrl = managedPricingUrl(shop);

  // Managed Pricing: send the merchant to Shopify's pricing page (top-level).
  const goToPricing = () => {
    if (typeof window !== "undefined") {
      open(pricingUrl, "_top");
    }
  };

  return (
    <s-page heading="Plans">
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap">
            <div className="zs-head">
              <div className="zs-eyebrow">Pricing</div>
              <h1 className="zs-title">Pick your plan</h1>
              <p className="zs-sub">
                Monthly item quota per data type. Upgrade or cancel anytime —
                billed securely through Shopify.
              </p>
            </div>

            <div className="zs-toggle-wrap">
              <div className="zs-toggle">
                <button
                  className={!annual ? "active" : ""}
                  onClick={() => setAnnual(false)}
                  type="button"
                >
                  Monthly
                </button>
                <button
                  className={annual ? "active" : ""}
                  onClick={() => setAnnual(true)}
                  type="button"
                >
                  Annual{" "}
                  <span className="zs-save-pill">save up to {maxSavings}%</span>
                </button>
              </div>
            </div>

            <div className="zs-grid">
              {Object.keys(planPrice).map((planId) => {
                const isCurrent = current === planId;
                const featured = planId === "growth";
                const isFree = planPrice[planId] === 0;
                const monthly = planPrice[planId];
                const yearly = planPriceAnnual[planId];
                const savings = planSavings[planId];

                return (
                  <div
                    key={planId}
                    className={`zs-plan ${featured ? "featured" : ""} ${isCurrent ? "current" : ""}`}
                  >
                    {isCurrent ? (
                      <span className="zs-tag cur">Current</span>
                    ) : featured ? (
                      <span className="zs-tag">Most Popular</span>
                    ) : null}

                    <div className="zs-pname">
                      {planId[0].toUpperCase() + planId.slice(1)}
                    </div>

                    {isFree ? (
                      <>
                        <div className="zs-price">Free</div>
                        <div className="zs-price-sub muted">Forever</div>
                      </>
                    ) : annual ? (
                      <>
                        <div className="zs-price">
                          ${yearly}
                          <small>/yr</small>
                        </div>
                        <div className="zs-price-sub">
                          save {savings}% vs monthly
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="zs-price">
                          ${monthly}
                          <small>/mo</small>
                        </div>
                        <div className="zs-price-sub muted">
                          or ${yearly}/yr · save {savings}%
                        </div>
                      </>
                    )}

                    <p className="zs-pdesc">{PLAN_DESC[planId]}</p>

                    <ul className="zs-feats">
                      {featureLines(planLimits[planId]).map((line) => (
                        <li key={line}>
                          <Check size={15} /> {line}
                        </li>
                      ))}
                    </ul>

                    {isCurrent ? (
                      <span className={`zs-cta ghost disabled`}>
                        Current Plan
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={`zs-cta ${featured ? "primary" : "ghost"}`}
                        onClick={goToPricing}
                      >
                        {isFree ? (
                          "Switch to Free"
                        ) : (
                          <>
                            Choose {planId[0].toUpperCase() + planId.slice(1)}{" "}
                            <ExternalLink size={14} />
                          </>
                        )}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="zs-foot">
              Plans are managed and billed securely by Shopify. Choosing a plan
              opens Shopify's secure checkout. Charges are billed in USD and
              renew every 30 days (monthly) or every year (annual).
            </div>

            {DISPLAY_TYPES.some((t) => (usage[t] || 0) > 0) && (
              <div className="zs-usage">
                <div className="zs-usage-head">
                  Usage this billing period ({current} plan)
                </div>
                <div className="zs-usage-grid">
                  {DISPLAY_TYPES.map((t) => {
                    const used = usage[t] || 0;
                    const lim = planLimits[current]?.[t] || 0;
                    if (lim === 0 && used === 0) return null;
                    return (
                      <div key={t} className="zs-usage-row">
                        <span>{TYPE_LABEL[t]}</span>
                        <span>
                          <b>{used}</b> / {lim}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
