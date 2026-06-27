import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getUsage, setPlan, PLAN_PRICE, PLAN_LIMITS,
} from "../credits.server";
import { brandStyles } from "./zs-styles.js";
import { Check, Loader2 } from "lucide-react";

// ─── Loader ──────────────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const usage = await getUsage(session.shop);
  return {
    current: usage.plan,
    usage: usage.usage,           // { products: 10, ... }
    limits: usage.limits,         // { products: 20, ... }
    planPrice: PLAN_PRICE,
    planLimits: PLAN_LIMITS,      // { free: { products: 20, ... }, ... }
  };
};

// ─── Action: create a Shopify recurring subscription ─────────────────────────
export const action = async ({ request }) => {
  const { admin, session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const plan = String(form.get("plan") || "");

  // Free → just downgrade locally
  if (plan === "free") {
    await setPlan(shop, "free");
    return { ok: true, downgraded: true };
  }

  const price = PLAN_PRICE[plan];
  if (!price) return { ok: false, error: "Unknown plan." };

  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const returnUrl = `${appUrl}/app/plan?upgraded=${plan}`;

  // Create the recurring charge via GraphQL Billing API
  const resp = await admin.graphql(
    `#graphql
    mutation CreateSub($name:String!,$price:Decimal!,$returnUrl:URL!,$test:Boolean!){
      appSubscriptionCreate(
        name:$name
        returnUrl:$returnUrl
        test:$test
        lineItems:[{
          plan:{ appRecurringPricingDetails:{ price:{ amount:$price, currencyCode:USD }, interval:EVERY_30_DAYS } }
        }]
      ){
        confirmationUrl
        appSubscription { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        name: `ZS StoreSync — ${plan[0].toUpperCase() + plan.slice(1)}`,
        price: price.toFixed(2),
        returnUrl,
        test: process.env.NODE_ENV !== "production",
      },
    },
  );
  const json = await resp.json();
  const node = json?.data?.appSubscriptionCreate;
  const errs = node?.userErrors;
  if (errs?.length) return { ok: false, error: errs[0].message };

  // store intended plan; confirm on return (or via webhook)
  await setPlan(shop, plan, node?.appSubscription?.id);

  return { ok: true, confirmationUrl: node.confirmationUrl };
};

const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');
  .zs-root{--zs-font-display:"Fraunces",serif;--zs-font-body:"Hanken Grotesk",sans-serif;--zs-r-sm:10px;--zs-r-md:14px;--zs-r-lg:20px;--zs-shadow-sm:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);--zs-shadow-md:0 4px 14px rgba(58,49,40,.06),0 18px 40px rgba(58,49,40,.06);--zs-shadow-clay:0 10px 30px rgba(169,139,118,.28);font-family:var(--zs-font-body);color:var(--zs-dark);}
  .zs-section-wrap{width:100vw;position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;padding:1.5rem;box-sizing:border-box;}
  .zs-wrap{max-width:1080px;margin:0 auto;}
  .zs-head{text-align:center;margin-bottom:28px;}
  .zs-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:8px;}
  .zs-title{font-family:var(--zs-font-display);font-size:30px;font-weight:600;margin:0 0 8px;letter-spacing:-.02em;}
  .zs-sub{font-size:14px;color:var(--zs-muted);}
  .zs-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;}
  .zs-plan{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:1.8rem;position:relative;box-shadow:var(--zs-shadow-sm);display:flex;flex-direction:column;transition:transform .2s,box-shadow .2s;}
  .zs-plan:hover{transform:translateY(-4px);box-shadow:var(--zs-shadow-md);}
  .zs-plan.featured{border-color:var(--zs-clay);box-shadow:var(--zs-shadow-clay);}
  .zs-plan.current{border-color:var(--zs-sage-deep);}
  .zs-tag{position:absolute;top:-11px;left:50%;transform:translateX(-50%);background:var(--zs-clay);color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;padding:4px 14px;border-radius:20px;}
  .zs-tag.cur{background:var(--zs-sage-deep);}
  .zs-pname{font-family:var(--zs-font-display);font-size:21px;font-weight:600;margin-bottom:4px;}
  .zs-price{font-family:var(--zs-font-display);font-size:38px;font-weight:600;letter-spacing:-.02em;}
  .zs-price small{font-size:14px;color:var(--zs-muted);font-weight:500;}
  .zs-pdesc{font-size:13px;color:var(--zs-muted);margin:6px 0 18px;line-height:1.5;}
  .zs-feats{list-style:none;padding:0;margin:0 0 22px;flex:1;}
  .zs-feats li{display:flex;align-items:flex-start;gap:9px;font-size:13px;color:var(--zs-dark);padding:7px 0;}
  .zs-feats li svg{color:var(--zs-sage-deep);flex-shrink:0;margin-top:2px;}
  .zs-cta{width:100%;padding:13px;border-radius:var(--zs-r-sm);font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;border:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:transform .15s,background .15s;}
  .zs-cta.primary{background:var(--zs-clay);color:#fff;box-shadow:var(--zs-shadow-clay);}
  .zs-cta.primary:hover{transform:translateY(-2px);background:var(--zs-clay-deep);}
  .zs-cta.ghost{background:var(--zs-cream-soft);color:var(--zs-clay-deep);border:1px solid var(--zs-border);}
  .zs-cta.ghost:hover{background:var(--zs-clay-soft);}
  .zs-cta:disabled{opacity:.6;cursor:default;}
  .zs-usage{text-align:center;margin-top:24px;font-size:13px;color:var(--zs-muted);}
  .zs-spin{animation:zsRot 1s linear infinite;}@keyframes zsRot{to{transform:rotate(360deg);}}
  @media(max-width:840px){.zs-grid{grid-template-columns:1fr;}}
`;

const PLAN_DESC = {
  free: "Try it out — core content types, small monthly quota.",
  starter: "For active store moves — adds files, metafields & metaobjects.",
  pro: "Full migrations with orders & customers + overage billing.",
};

const TYPE_LABEL = {
  products: "Products",
  collections: "Collections",
  pages: "Pages",
  files: "Files",
  metaobjects: "Metaobjects",
  metafields: "Metafields",
  orders: "Orders",
  customers: "Customers",
};

// ordered display of types within each plan card
const DISPLAY_TYPES = ["products", "collections", "pages", "files", "metaobjects", "metafields", "orders", "customers"];

export default function Plan() {
  const { current, usage, planPrice, planLimits } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";

  // redirect to Shopify confirmation when returned
  if (fetcher.data?.confirmationUrl && typeof window !== "undefined") {
    window.top.location.href = fetcher.data.confirmationUrl;
  }

  return (
    <s-page heading="Plans">
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap">
            <div className="zs-head">
              <div className="zs-eyebrow">Pricing</div>
              <h1 className="zs-title">Pick your plan</h1>
              <p className="zs-sub">Monthly item quota per data type. Upgrade or cancel anytime — billed securely through Shopify.</p>
            </div>

            <div className="zs-grid">
              {Object.keys(PLAN_PRICE).map((planId) => {
                const isCurrent = current === planId;
                const featured = planId === "starter";
                const limits = PLAN_LIMITS[planId];
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
                    <div className="zs-price">
                      {planPrice[planId] === 0 ? "Free" : `$${planPrice[planId]}`}
                      {planPrice[planId] !== 0 && <small>/mo</small>}
                    </div>
                    <p className="zs-pdesc">{PLAN_DESC[planId]}</p>
                    <ul className="zs-feats">
                      {DISPLAY_TYPES.map((t) => {
                        const lim = limits[t] || 0;
                        if (lim === 0) return null;
                        const label = lim >= 1000 ? `${(lim / 1000)}k` : lim;
                        const overage = planId === "pro" ? " +overage" : "";
                        return (
                          <li key={t}>
                            <Check size={15} /> {TYPE_LABEL[t]}: {label}/mo{overage}
                          </li>
                        );
                      })}
                      {planId === "pro" && (
                        <li><Check size={15} /> Priority email support</li>
                      )}
                    </ul>

                    <fetcher.Form method="post">
                      <input type="hidden" name="plan" value={planId} />
                      <button
                        className={`zs-cta ${featured ? "primary" : "ghost"}`}
                        disabled={isCurrent || busy}
                      >
                        {busy ? (
                          <><Loader2 size={15} className="zs-spin" /> Redirecting…</>
                        ) : isCurrent ? (
                          "Current Plan"
                        ) : planId === "free" ? (
                          "Downgrade to Free"
                        ) : (
                          `Choose ${planId[0].toUpperCase() + planId.slice(1)}`
                        )}
                      </button>
                    </fetcher.Form>
                  </div>
                );
              })}
            </div>

            {DISPLAY_TYPES.some((t) => (usage[t] || 0) > 0) && (
              <div className="zs-usage">
                <div style={{ marginBottom: 10 }}>
                  Usage this billing period ({current} plan):
                </div>
                {DISPLAY_TYPES.map((t) => {
                  const used = usage[t] || 0;
                  const lim = PLAN_LIMITS[current]?.[t] || 0;
                  if (lim === 0 && used === 0) return null;
                  return (
                    <div key={t} style={{ fontSize: 13, marginBottom: 4 }}>
                      {TYPE_LABEL[t]}: <b>{used}</b> / {lim}{current === "pro" ? " (+overage)" : ""}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
