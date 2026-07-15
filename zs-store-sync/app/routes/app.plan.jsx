import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getUsage,
  setPlan,
  schedulePlanChange,
  PLAN_PRICE,
  PLAN_PRICE_ANNUAL,
  PLAN_ANNUAL_SAVINGS,
  PLAN_LIMITS,
} from "../credits.server";
import { brandStyles } from "./zs-styles.js";
import { Lock, Undo, Zap, MessageCircle, Check } from "lucide-react";

const APP_HANDLE = "zs-storesync";

function basePlan(billingPlan) {
  return String(billingPlan || "").replace("_annual", "");
}

const BILLING_PLANS = [
  "starter",
  "starter_annual",
  "growth",
  "growth_annual",
  "pro",
  "pro_annual",
];

// Pre-format the lock date on the server (fixed locale/timezone) so SSR and
// client render identical text — same hydration concern as the Migrate page.
function fmtLockDate(d) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(d));
}

async function loaderData(shop, extra = {}) {
  const usage = await getUsage(shop);
  const locked =
    usage.plan !== "free" &&
    usage.lockedUntil &&
    new Date() < new Date(usage.lockedUntil);
  return {
    current: usage.plan,
    usage: usage.usage,
    planPrice: PLAN_PRICE,
    planPriceAnnual: PLAN_PRICE_ANNUAL,
    planSavings: PLAN_ANNUAL_SAVINGS,
    planLimits: PLAN_LIMITS,
    // commitment window: downgrades take effect after this date
    lockedUntilLabel: locked ? fmtLockDate(usage.lockedUntil) : null,
    // scheduled downgrade, if any
    pendingPlan: usage.pendingPlan || null,
    activated: null,
    cleanBillingParams: false,
    ...extra,
  };
}

const Q_APP_SUBSCRIPTION = `#graphql
  query AppSubscription($id: ID!) {
    node(id: $id) {
      ... on AppSubscription { id name status currentPeriodEnd }
    }
  }`;

// ─── Loader ──────────────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { session, billing, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  const chargeId = url.searchParams.get("charge_id");
  const activate = url.searchParams.get("activate");

  if (chargeId && activate && BILLING_PLANS.includes(activate)) {
    // SECURITY: never trust the URL params alone — anyone could type them.
    // Confirm with Shopify what state this exact subscription is in before
    // touching the stored plan.
    const base = basePlan(activate);
    const interval = activate.endsWith("_annual") ? "annual" : "monthly";

    const { appSubscriptions } = await billing.check();
    const sub = (appSubscriptions || []).find(
      (s) =>
        s.name === activate &&
        (String(s.id).endsWith(`/${chargeId}`) || String(s.id) === chargeId),
    );
    if (sub) {
      // immediate activation (new purchase or prorated upgrade)
      await setPlan(shop, base, String(sub.id), {
        interval,
        lockedUntil: sub.currentPeriodEnd || undefined,
      });
      // Render the confirmation right away and tell the client to strip the
      // billing params from the URL in place — no second full-page reload.
      return loaderData(shop, { activated: base, cleanBillingParams: true });
    }

    // Not among active subscriptions — this may be a scheduled downgrade the
    // merchant just approved (APPLY_ON_NEXT_BILLING_CYCLE). Verify the charge
    // directly; only an ACCEPTED subscription with our name schedules a change.
    try {
      const res = await admin.graphql(Q_APP_SUBSCRIPTION, {
        variables: { id: `gid://shopify/AppSubscription/${chargeId}` },
      });
      const node = (await res.json())?.data?.node;
      if (node?.name === activate && node?.status === "ACCEPTED") {
        const current = (appSubscriptions || [])[0];
        await schedulePlanChange(
          shop,
          base,
          current?.currentPeriodEnd || undefined,
        );
        return loaderData(shop, { cleanBillingParams: true });
      }
    } catch {
      // verification failed — never change the plan on unverified params
    }
  }

  return loaderData(shop, { activated: url.searchParams.get("activated") });
};

// ─── Action ──────────────────────────────────────────────────────────────────
// Plan-change policy:
//   • UPGRADES apply immediately — Shopify replaces the subscription and
//     prorates the difference.
//   • DOWNGRADES (incl. cancel to Free) never cut a paid period short: they
//     take effect when the current billing period ends. Free = cancel the
//     subscription now (no renewal, no refund) but keep the plan until the
//     period ends. Lower paid tier = Shopify's APPLY_ON_NEXT_BILLING_CYCLE.
export const action = async ({ request }) => {
  const { billing, session } = await authenticate.admin(request);
  const form = await request.formData();
  const plan = String(form.get("plan") || "");
  const interval = String(form.get("interval") || "monthly");
  const shop = session.shop;
  // Test charges (no real money) when not in production, OR when BILLING_TEST is
  // explicitly set — lets us exercise the billing flow on prod without charging.
  const isTest =
    process.env.BILLING_TEST === "true" ||
    process.env.NODE_ENV !== "production";

  if (![...PLAN_ORDER].includes(plan)) return { error: "Invalid plan." };

  const usage = await getUsage(shop);
  const currentPlan = usage.plan;

  if (plan === currentPlan && (plan === "free" || interval === usage.interval)) {
    return { error: "You're already on this plan." };
  }

  // Live subscription state — currentPeriodEnd is authoritative (it advances
  // with every auto-renewal, unlike our stored lockedUntil).
  const { appSubscriptions } = await billing.check();
  const activeSub = (appSubscriptions || [])[0] || null;
  const periodEnd = activeSub?.currentPeriodEnd
    ? new Date(activeSub.currentPeriodEnd)
    : null;
  const inPaidPeriod =
    currentPlan !== "free" && periodEnd && new Date() < periodEnd;

  const currentIdx = PLAN_ORDER.indexOf(currentPlan);
  const targetIdx = PLAN_ORDER.indexOf(plan);
  const isUpgradeChange =
    targetIdx > currentIdx ||
    (targetIdx === currentIdx &&
      interval === "annual" &&
      usage.interval === "monthly");

  const billingPlan =
    plan === "free" ? null : interval === "annual" ? `${plan}_annual` : plan;
  const storeName = shop.replace(".myshopify.com", "");
  const returnUrl = billingPlan
    ? `https://admin.shopify.com/store/${storeName}/apps/${APP_HANDLE}/app/plan?activate=${billingPlan}`
    : null;

  // ── Downgrades during a paid period → scheduled, never immediate ────────────
  if (!isUpgradeChange && inPaidPeriod) {
    if (usage.pendingPlan) {
      return {
        error: `A change to ${usage.pendingPlan[0].toUpperCase() + usage.pendingPlan.slice(1)} is already scheduled for ${fmtLockDate(usage.lockedUntil || periodEnd)}. It will apply automatically when your current period ends.`,
      };
    }

    if (plan === "free") {
      // Stop the renewal now (no refund — the period was committed), keep the
      // paid plan until the period ends, then getUsage flips it to free.
      for (const sub of appSubscriptions || []) {
        await billing.cancel({ subscriptionId: sub.id, isTest, prorate: false });
      }
      await schedulePlanChange(shop, "free", periodEnd);
      return { scheduled: "free", effectiveLabel: fmtLockDate(periodEnd) };
    }

    // Lower paid tier: merchant approves the new charge now; Shopify activates
    // it when the current billing cycle ends (no double charge). Our plan
    // updates via the ACTIVE webhook / the return-URL loader.
    await billing.request({
      plan: billingPlan,
      isTest,
      returnUrl,
      replacementBehavior: "APPLY_ON_NEXT_BILLING_CYCLE",
    });
    return null;
  }

  // ── Free (no active paid period) → immediate ────────────────────────────────
  if (plan === "free") {
    for (const sub of appSubscriptions || []) {
      await billing.cancel({ subscriptionId: sub.id, isTest, prorate: false });
    }
    await setPlan(shop, "free", null);
    // Return data (no redirect): React Router revalidates the loader in place,
    // keeping the authenticated embedded context. A bare redirect here can land
    // on a request without the App Bridge session token → the login screen.
    return { downgradedToFree: true };
  }

  // ── Upgrades (and changes outside a paid period) → immediate, prorated ─────
  await billing.request({
    plan: billingPlan,
    isTest,
    returnUrl,
  });

  return null;
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,500&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');

  .zs-root {
    --zs-font-display: "Fraunces", Georgia, serif;
    --zs-font-body: "Hanken Grotesk", -apple-system, BlinkMacSystemFont, sans-serif;
    --zs-r-sm: 10px; --zs-r-md: 14px; --zs-r-lg: 20px;
    --zs-shadow-sm: 0 1px 2px rgba(58,49,40,.04), 0 2px 8px rgba(58,49,40,.05);
    --zs-shadow-md: 0 4px 14px rgba(58,49,40,.06), 0 18px 40px rgba(58,49,40,.06);
    --zs-shadow-clay: 0 10px 30px rgba(169,139,118,.28);
    font-family: var(--zs-font-body);
    -webkit-font-smoothing: antialiased;
    color: var(--zs-dark);
  }
  .zs-section-wrap { width: 100vw; position: relative; left: 50%; right: 50%; margin-left: -50vw; margin-right: -50vw; padding: 1.5rem; box-sizing: border-box; }
  .zs-wrap { max-width: 1280px; margin: 0 auto; width: 100%; }
  .zs-stack > * + * { margin-top: 26px; }

  @keyframes zsFadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
  .zs-reveal { opacity: 0; animation: zsFadeUp .55s cubic-bezier(.2,.7,.2,1) forwards; }
  .zs-d1 { animation-delay: .04s; } .zs-d2 { animation-delay: .14s; } .zs-d3 { animation-delay: .24s; }

  /* ── Activated banner ── */
  .zs-activated { background: #eaf4e3; border: 1px solid #cfe6c0; color: #2e6b1a; border-radius: var(--zs-r-md); padding: 13px 20px; font-size: 14px; font-weight: 600; text-align: center; }

  /* ── Header ── */
  .zs-pricing-head { text-align: center; max-width: 620px; margin: 0 auto; }
  .zs-pricing-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 1.8px; text-transform: uppercase; color: var(--zs-clay); margin-bottom: 14px; }
  .zs-pricing-title { font-family: var(--zs-font-display); font-size: 38px; font-weight: 600; color: var(--zs-dark); line-height: 1.08; letter-spacing: -.02em; margin: 0 0 14px; }
  .zs-pricing-title em { font-style: italic; color: var(--zs-clay); }
  .zs-pricing-sub { font-size: 15px; color: #948d86; line-height: 1.65; margin: 0; }

  /* ── Toggle ── */
  .zs-toggle-wrap { display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: 26px; flex-wrap: wrap; }
  .zs-toggle-label { font-size: 13px; font-weight: 600; color: #b4ada5; transition: color .15s; cursor: pointer; user-select: none; }
  .zs-toggle-label.active { color: var(--zs-dark); }
  .zs-toggle-cb { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
  .zs-toggle-track { width: 52px; height: 28px; border-radius: 20px; background: var(--zs-clay); cursor: pointer; position: relative; flex-shrink: 0; display: inline-block; transition: background .2s; }
  .zs-toggle-knob { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #fff; transition: transform .22s cubic-bezier(.2,.7,.2,1); box-shadow: 0 2px 4px rgba(0,0,0,.2); pointer-events: none; }
  .zs-toggle-track.annual .zs-toggle-knob { transform: translateX(24px); }
  .zs-save-badge { font-size: 11px; font-weight: 700; color: #3a7020; background: #eaf4e3; padding: 4px 10px; border-radius: 20px; }

  /* ── Grid ── */
  .zs-plan-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; align-items: stretch; }

  /* ── Card ── */
  .zs-plan { background: var(--zs-white); border: 1px solid var(--zs-border); border-radius: var(--zs-r-lg); padding: 2rem 1.75rem; box-shadow: var(--zs-shadow-sm); display: flex; flex-direction: column; position: relative; transition: transform .2s, box-shadow .2s, border-color .2s; }
  .zs-plan:hover { transform: translateY(-4px); box-shadow: var(--zs-shadow-md); }
  .zs-plan.featured { background: var(--zs-dark); border-color: transparent; box-shadow: var(--zs-shadow-md); }
  .zs-plan.featured::before { content: ""; position: absolute; inset: 0; border-radius: var(--zs-r-lg); pointer-events: none; background: radial-gradient(circle at 85% 8%, rgba(169,139,118,.35) 0%, transparent 52%); }
  .zs-plan.current-plan { border-color: var(--zs-clay); box-shadow: 0 0 0 2px rgba(169,139,118,.25); }
  .zs-plan-badge { position: absolute; top: -13px; left: 50%; transform: translateX(-50%); background: var(--zs-clay); color: #fff; font-size: 11px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; padding: 6px 16px; border-radius: 20px; box-shadow: var(--zs-shadow-clay); white-space: nowrap; z-index: 2; }
  .zs-plan-badge.cur { background: var(--zs-sage-deep, #4a7c59); }

  .zs-plan-name { font-family: var(--zs-font-display); font-size: 22px; font-weight: 600; letter-spacing: -.01em; margin-bottom: 6px; position: relative; z-index: 1; }
  .zs-plan-tagline { font-size: 13px; color: #948d86; line-height: 1.5; margin-bottom: 22px; min-height: 38px; position: relative; z-index: 1; }
  .zs-plan.featured .zs-plan-name { color: #fff; }
  .zs-plan.featured .zs-plan-tagline { color: rgba(255,255,255,.6); }

  .zs-plan-price-row { display: flex; align-items: baseline; gap: 4px; margin-bottom: 4px; position: relative; z-index: 1; }
  .zs-plan-price { font-family: var(--zs-font-display); font-size: 44px; font-weight: 600; color: var(--zs-dark); line-height: 1; letter-spacing: -.02em; }
  .zs-plan.featured .zs-plan-price { color: #fff; }
  .zs-plan-period { font-size: 14px; color: #b4ada5; font-weight: 500; }
  .zs-plan.featured .zs-plan-period { color: rgba(255,255,255,.5); }
  .zs-plan-billed { font-size: 12px; color: #b4ada5; margin-bottom: 22px; min-height: 18px; position: relative; z-index: 1; }
  .zs-plan.featured .zs-plan-billed { color: rgba(255,255,255,.45); }

  .zs-plan-cta { width: 100%; padding: 13px; border-radius: var(--zs-r-sm); font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit; transition: transform .16s, box-shadow .16s, opacity .16s; margin-bottom: 26px; position: relative; z-index: 1; border: 1px solid var(--zs-border); background: var(--zs-white); color: var(--zs-dark); display: flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; box-sizing: border-box; }
  .zs-plan-cta:hover { border-color: var(--zs-clay); color: var(--zs-clay); }
  .zs-plan-cta.primary { background: var(--zs-clay); border-color: var(--zs-clay); color: #fff; box-shadow: var(--zs-shadow-clay); }
  .zs-plan-cta.primary:hover { transform: translateY(-2px); box-shadow: 0 14px 34px rgba(169,139,118,.4); color: #fff; }
  .zs-plan-cta.current { background: var(--zs-bg, #f7f4f1); border-color: var(--zs-border); color: #b4ada5; cursor: default; }
  .zs-plan-cta.current:hover { transform: none; border-color: var(--zs-border); color: #b4ada5; }
  .zs-plan-cta:disabled { opacity: .6; cursor: default; }
  .zs-spin { animation: zsRot 1s linear infinite; } @keyframes zsRot { to { transform: rotate(360deg); } }

  .zs-feat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; color: #b4ada5; margin-bottom: 14px; position: relative; z-index: 1; }
  .zs-plan.featured .zs-feat-label { color: rgba(255,220,130,.8); }
  .zs-feat-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; flex: 1; position: relative; z-index: 1; }
  .zs-feat { display: flex; align-items: flex-start; gap: 9px; font-size: 13px; color: var(--zs-dark); line-height: 1.45; }
  .zs-plan.featured .zs-feat { color: rgba(255,255,255,.82); }
  .zs-feat-check { width: 17px; height: 17px; border-radius: 50%; background: #e8f0e3; color: #3a7020; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
  .zs-plan.featured .zs-feat-check { background: rgba(255,255,255,.15); color: rgba(255,220,130,.9); }
  .zs-feat strong { font-weight: 700; }

  /* ── Usage ── */
  .zs-usage { background: var(--zs-white); border: 1px solid var(--zs-border); border-radius: var(--zs-r-lg); padding: 1.4rem 1.75rem; box-shadow: var(--zs-shadow-sm); }
  .zs-usage-title { font-family: var(--zs-font-display); font-size: 18px; font-weight: 600; margin-bottom: 16px; }
  .zs-usage-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 24px; }
  .zs-usage-row { display: flex; flex-direction: column; gap: 4px; padding: 6px 0; }
  .zs-usage-label { display: flex; justify-content: space-between; font-size: 13px; color: #948d86; }
  .zs-usage-label b { color: var(--zs-dark); }
  .zs-bar-wrap { height: 4px; background: var(--zs-border); border-radius: 4px; overflow: hidden; }
  .zs-bar { height: 100%; border-radius: 4px; background: var(--zs-clay); transition: width .4s; }
  .zs-bar.warn { background: #e8a838; }
  .zs-bar.full { background: #d94f4f; }

  /* ── Trust strip ── */
  .zs-trust { display: flex; align-items: center; justify-content: center; gap: 32px; flex-wrap: wrap; padding: 1rem; }
  .zs-trust-item { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #948d86; font-weight: 500; }

  /* ── FAQ ── */
  .zs-faq-title { font-family: var(--zs-font-display); font-size: 24px; font-weight: 600; color: var(--zs-dark); text-align: center; letter-spacing: -.01em; margin-bottom: 20px; }
  .zs-faq-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .zs-faq-card { background: var(--zs-white); border: 1px solid var(--zs-border); border-radius: var(--zs-r-md); padding: 1.3rem 1.5rem; box-shadow: var(--zs-shadow-sm); }
  .zs-faq-q { font-size: 14px; font-weight: 700; color: var(--zs-dark); margin-bottom: 7px; }
  .zs-faq-a { font-size: 13px; color: #948d86; line-height: 1.6; }

  @media (max-width: 1100px) { .zs-plan-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 640px) { .zs-plan-grid { grid-template-columns: 1fr; } .zs-faq-grid { grid-template-columns: 1fr; } .zs-usage-grid { grid-template-columns: 1fr 1fr; } .zs-pricing-title { font-size: 30px; } }
`;

// ─── Plan data ────────────────────────────────────────────────────────────────
const PLAN_META = {
  free: {
    tagline: "Try it out — core content types with a generous monthly quota.",
    featureLabel: "Includes",
    featured: false,
    badge: null,
  },
  starter: {
    tagline: "For active store moves — adds files, discounts, menus & more.",
    featureLabel: "Everything in Free, plus",
    featured: false,
    badge: null,
  },
  growth: {
    tagline: "Higher limits across every data type for larger catalogs.",
    featureLabel: "Everything in Starter, plus",
    featured: true,
    badge: "★ Most Popular",
  },
  pro: {
    tagline: "Maximum limits for big migrations and ongoing syncs.",
    featureLabel: "Everything in Growth, plus",
    featured: false,
    badge: null,
  },
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

const faqs = [
  {
    q: "What counts toward my monthly quota?",
    a: "Each new item created in this store by a migration or sync (product, page, file, etc.) counts once per billing cycle. Items that already exist and are skipped don't count. The counter resets every 30 days.",
  },
  {
    q: "What happens if I hit my limit?",
    a: "Syncs for that data type pause until your quota resets or you upgrade. Existing data in both stores is never deleted.",
  },
  {
    q: "Can I change or cancel my plan later?",
    a: "Upgrades apply immediately — Shopify prorates so you only pay the difference. Downgrades and cancellations can be requested anytime but take effect at the end of your current billing period; you keep your paid features until then, and nothing is refunded mid-period.",
  },
  {
    q: "Is there a free trial?",
    a: "The Free plan is yours forever with no credit card required — use it to try the app before upgrading. Paid plans are billed from day one through Shopify.",
  },
];

// Plan order for upgrade/downgrade comparison
const PLAN_ORDER = ["free", "starter", "growth", "pro"];

const fmt = (n) => {
  if (!n || n === 0) return "0";
  if (n >= 1000) return `${n / 1000}k`;
  return `${n}`;
};

function buildFeatures(planId, L) {
  if (planId === "free")
    return [
      { text: `${fmt(L.products)} Products`, ok: true },
      { text: `${fmt(L.collections)} Collections`, ok: true },
      {
        text: `${fmt(L.pages)} Pages, ${fmt(L.discounts)} Discounts`,
        ok: true,
      },
      {
        text: `${fmt(L.files)} Files, ${fmt(L.menus)} Menus, ${fmt(L.redirects)} Redirects`,
        ok: true,
      },
      { text: `${fmt(L.metaobjects)} Metaobjects`, ok: true },
      { text: `${fmt(L.blogPosts)} Blog Posts`, ok: true },
      { text: `${fmt(L.metafields)} Metafields`, ok: true },
      {
        text: `${fmt(L.orders)} Orders, ${fmt(L.customers)} Customers`,
        ok: true,
      },
    ];

  if (planId === "starter")
    return [
      { text: `${fmt(L.products)} Products`, ok: true },
      { text: `${fmt(L.collections)} Collections`, ok: true },
      {
        text: `${fmt(L.pages)} Pages, ${fmt(L.discounts)} Discounts`,
        ok: true,
      },
      {
        text: `${fmt(L.files)} Files, ${fmt(L.menus)} Menus, ${fmt(L.redirects)} Redirects`,
        ok: true,
      },
      { text: `${fmt(L.metaobjects)} Metaobjects`, ok: true },
      { text: `${fmt(L.blogPosts)} Blog Posts`, ok: true },
      { text: `${fmt(L.metafields)} Metafields`, ok: true },
      {
        text: `${fmt(L.orders)} Orders, ${fmt(L.customers)} Customers`,
        ok: true,
      },
    ];

  if (planId === "growth")
    return [
      { text: `${fmt(L.products)} Products`, ok: true },
      { text: `${fmt(L.collections)} Collections`, ok: true },
      {
        text: `${fmt(L.pages)} Pages, ${fmt(L.discounts)} Discounts`,
        ok: true,
      },
      {
        text: `${fmt(L.files)} Files, ${fmt(L.menus)} Menus, ${fmt(L.redirects)} Redirects`,
        ok: true,
      },
      { text: `${fmt(L.metaobjects)} Metaobjects`, ok: true },
      { text: `${fmt(L.blogPosts)} Blog Posts`, ok: true },
      { text: `${fmt(L.metafields)} Metafields`, ok: true },
      {
        text: `${fmt(L.orders)} Orders, ${fmt(L.customers)} Customers`,
        ok: true,
      },
    ];

  if (planId === "pro")
    return [
      { text: `${fmt(L.products)} Products`, ok: true },
      { text: `${fmt(L.collections)} Collections`, ok: true },
      {
        text: `${fmt(L.pages)} Pages, ${fmt(L.discounts)} Discounts`,
        ok: true,
      },
      {
        text: `${fmt(L.files)} Files, ${fmt(L.menus)} Menus, ${fmt(L.redirects)} Redirects`,
        ok: true,
      },
      { text: `${fmt(L.metaobjects)} Metaobjects`, ok: true },
      { text: `${fmt(L.blogPosts)} Blog Posts`, ok: true },
      { text: `${fmt(L.metafields)} Metafields`, ok: true },
      {
        text: `${fmt(L.orders)} Orders, ${fmt(L.customers)} Customers`,
        ok: true,
      },
    ];

  return [];
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function Plan() {
  const {
    current,
    usage,
    planPrice,
    planPriceAnnual,
    planSavings,
    planLimits,
    lockedUntilLabel,
    pendingPlan,
    activated,
    cleanBillingParams,
  } = useLoaderData();

  // Submit every plan change through one App Bridge fetcher. A native <form>
  // POST doesn't carry the embedded session token, so authenticate.admin fails
  // and renders the login screen — the fetcher uses App Bridge's fetch (token
  // attached), keeping us authenticated for both billing redirects and the
  // in-place free downgrade.
  const planFetcher = useFetcher();
  const [annual, setAnnual] = useState(false);

  const submittingPlan =
    planFetcher.state !== "idle" ? planFetcher.formData?.get("plan") : null;
  // Just dropped to Free. Takes priority over any stale ?activated=<paid> param
  // left in the URL from an earlier upgrade.
  const justFree = planFetcher.data?.downgradedToFree;
  const bannerPlan = justFree ? "free" : activated;

  // After a paid plan activates, drop the one-time billing params (charge_id,
  // activate) from the URL in place — keeps host/shop/embedded intact and
  // avoids a second full-page reload.
  useEffect(() => {
    if (cleanBillingParams && typeof window !== "undefined") {
      const u = new URL(window.location.href);
      u.searchParams.delete("charge_id");
      u.searchParams.delete("activate");
      if (activated) u.searchParams.set("activated", activated);
      window.history.replaceState(null, "", u.pathname + u.search);
    }
  }, [cleanBillingParams, activated]);

  // After downgrading to Free, drop the stale ?activated=<paid> param so the old
  // banner can't reappear on a later load.
  useEffect(() => {
    if (justFree && typeof window !== "undefined") {
      const u = new URL(window.location.href);
      u.searchParams.delete("activated");
      window.history.replaceState(null, "", u.pathname + u.search);
    }
  }, [justFree]);

  const maxSavings = Math.max(...Object.values(planSavings));

  const priceLabel = (planId) => {
    const monthly = planPrice[planId];
    const yearly = planPriceAnnual[planId];
    const savings = planSavings[planId];
    if (monthly === 0)
      return { price: "$0", period: "/mo", billed: "Free forever" };
    if (annual) {
      const perMo = (yearly / 12).toFixed(0);
      return {
        price: `$${perMo}`,
        period: "/mo",
        billed: `$${yearly}/yr · save ${savings}%`,
      };
    }
    return {
      price: `$${monthly}`,
      period: "/mo",
      billed: `or $${yearly}/yr · save ${savings}%`,
    };
  };

  const isUpgrade = (planId) => {
    const currentIdx = PLAN_ORDER.indexOf(current);
    const targetIdx = PLAN_ORDER.indexOf(planId);
    return targetIdx > currentIdx;
  };

  const ctaLabel = (planId, inPaidPeriod = false) => {
    if (submittingPlan === planId) return "Redirecting to Shopify…";
    const name = planId[0].toUpperCase() + planId.slice(1);
    if (isUpgrade(planId)) return `Upgrade to ${name}`;
    // downgrades during a paid period are scheduled for the period's end
    return inPaidPeriod
      ? `Downgrade to ${name} at period end`
      : `Downgrade to ${name}`;
  };

  return (
    <s-page heading="Pricing Plans">
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />

      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap zs-stack">
            {/* Activated banner */}
            {bannerPlan && (
              <div className="zs-activated zs-reveal zs-d1">
                ✓ Your{" "}
                <strong>
                  {bannerPlan[0].toUpperCase() + bannerPlan.slice(1)}
                </strong>{" "}
                plan is now active.
              </div>
            )}

            {/* Scheduled downgrade notice */}
            {pendingPlan && (
              <div
                className="zs-activated zs-reveal zs-d1"
                style={{
                  background: "var(--zs-cream-tint)",
                  border: "1px solid var(--zs-border)",
                  color: "var(--zs-clay-deep)",
                }}
              >
                <Lock size={13} style={{ verticalAlign: "-2px" }} /> Your plan
                switches to{" "}
                <strong>
                  {pendingPlan[0].toUpperCase() + pendingPlan.slice(1)}
                </strong>
                {lockedUntilLabel ? (
                  <>
                    {" "}
                    on <strong>{lockedUntilLabel}</strong>
                  </>
                ) : (
                  " when your current period ends"
                )}
                . You keep your{" "}
                <strong>{current[0].toUpperCase() + current.slice(1)}</strong>{" "}
                features until then.
              </div>
            )}

            {/* Just scheduled a free downgrade */}
            {planFetcher.data?.scheduled === "free" && !pendingPlan && (
              <div
                className="zs-activated zs-reveal zs-d1"
                style={{
                  background: "var(--zs-cream-tint)",
                  border: "1px solid var(--zs-border)",
                  color: "var(--zs-clay-deep)",
                }}
              >
                ✓ Downgrade scheduled — your plan switches to{" "}
                <strong>Free</strong> on{" "}
                <strong>{planFetcher.data.effectiveLabel}</strong>. No further
                charges.
              </div>
            )}

            {/* Commitment notice (paid period, nothing scheduled) */}
            {lockedUntilLabel && !pendingPlan && (
              <div
                className="zs-activated zs-reveal zs-d1"
                style={{
                  background: "var(--zs-cream-tint)",
                  border: "1px solid var(--zs-border)",
                  color: "var(--zs-clay-deep)",
                }}
              >
                <Lock size={13} style={{ verticalAlign: "-2px" }} /> Your{" "}
                <strong>{current[0].toUpperCase() + current.slice(1)}</strong>{" "}
                plan runs until <strong>{lockedUntilLabel}</strong>. Upgrades
                apply immediately (prorated by Shopify); downgrades and
                cancellations take effect on that date.
              </div>
            )}

            {/* Action errors (e.g. attempted change while locked) */}
            {planFetcher.data?.error && (
              <div
                className="zs-activated zs-reveal zs-d1"
                style={{
                  background: "#fbeaea",
                  border: "1px solid #f3d2d2",
                  color: "#9a3412",
                }}
              >
                {planFetcher.data.error}
              </div>
            )}

            {/* Header */}
            <div className="zs-pricing-head zs-reveal zs-d1">
              <div className="zs-pricing-eyebrow">Pricing</div>
              <h1 className="zs-pricing-title">
                Plans that grow <em>with your store</em>
              </h1>
              <p className="zs-pricing-sub">
                Start free, upgrade when you're ready. Migrate and sync
                products, collections, pages, files, and more — billed securely
                through Shopify.
              </p>

              <div className="zs-toggle-wrap">
                <label
                  className={`zs-toggle-label ${!annual ? "active" : ""}`}
                  onClick={() => setAnnual(false)}
                >
                  Monthly
                </label>
                <label
                  className={`zs-toggle-track ${annual ? "annual" : ""}`}
                  onClick={() => setAnnual((v) => !v)}
                >
                  <span className="zs-toggle-knob" />
                </label>
                <label
                  className={`zs-toggle-label ${annual ? "active" : ""}`}
                  onClick={() => setAnnual(true)}
                >
                  Annual
                </label>
                <span className="zs-save-badge">Save up to {maxSavings}%</span>
              </div>
            </div>

            {/* Plan cards */}
            <div className="zs-plan-grid zs-reveal zs-d2">
              {Object.keys(planPrice).map((planId) => {
                const isCurrent = current === planId;
                const isFree = planPrice[planId] === 0;
                const meta = PLAN_META[planId] || {};
                const { price, period, billed } = priceLabel(planId);
                const submitting = submittingPlan === planId;

                return (
                  <div
                    key={planId}
                    className={`zs-plan${meta.featured ? " featured" : ""}${isCurrent ? " current-plan" : ""}`}
                  >
                    {isCurrent ? (
                      <div className="zs-plan-badge cur">✓ Current</div>
                    ) : meta.badge ? (
                      <div className="zs-plan-badge">{meta.badge}</div>
                    ) : null}

                    <div className="zs-plan-name">
                      {planId[0].toUpperCase() + planId.slice(1)}
                    </div>
                    <div className="zs-plan-tagline">{meta.tagline}</div>

                    <div className="zs-plan-price-row">
                      <span className="zs-plan-price">{price}</span>
                      <span className="zs-plan-period">{period}</span>
                    </div>
                    <div className="zs-plan-billed">{billed}</div>

                    {/* CTA */}
                    {isCurrent ? (
                      <button
                        type="button"
                        className="zs-plan-cta current"
                        disabled
                      >
                        ✓ Current Plan
                      </button>
                    ) : isFree ? (
                      // Free has no charge to request — submit via the fetcher so
                      // it cancels in place (no reload) and the loader
                      // revalidates once it finishes.
                      <planFetcher.Form
                        method="post"
                        style={{ marginBottom: 0 }}
                      >
                        <input type="hidden" name="plan" value="free" />
                        <input type="hidden" name="interval" value="monthly" />
                        <button
                          type="submit"
                          className="zs-plan-cta"
                          disabled={!!submittingPlan || !!pendingPlan}
                          title={
                            pendingPlan
                              ? "A plan change is already scheduled"
                              : lockedUntilLabel
                                ? `Takes effect ${lockedUntilLabel}`
                                : undefined
                          }
                        >
                          {submittingPlan === "free"
                            ? "Scheduling…"
                            : pendingPlan
                              ? "Change scheduled"
                              : lockedUntilLabel
                                ? "Downgrade at period end"
                                : "Downgrade to Free"}
                        </button>
                      </planFetcher.Form>
                    ) : (
                      <planFetcher.Form
                        method="post"
                        style={{ marginBottom: 0 }}
                      >
                        <input type="hidden" name="plan" value={planId} />
                        <input
                          type="hidden"
                          name="interval"
                          value={annual ? "annual" : "monthly"}
                        />
                        <button
                          type="submit"
                          className={`zs-plan-cta ${isUpgrade(planId) && meta.featured ? "primary" : ""}`}
                          disabled={
                            !!submittingPlan ||
                            (!isUpgrade(planId) && !!pendingPlan)
                          }
                          title={
                            !isUpgrade(planId) && pendingPlan
                              ? "A plan change is already scheduled"
                              : !isUpgrade(planId) && lockedUntilLabel
                                ? `Takes effect ${lockedUntilLabel}`
                                : undefined
                          }
                        >
                          {!isUpgrade(planId) && pendingPlan
                            ? "Change scheduled"
                            : ctaLabel(planId, !!lockedUntilLabel)}
                        </button>
                      </planFetcher.Form>
                    )}

                    <div className="zs-feat-label">{meta.featureLabel}</div>
                    <ul className="zs-feat-list">
                      {buildFeatures(planId, planLimits[planId] || {}).map(
                        (f, i) => (
                          <li key={i} className="zs-feat">
                            <span className="zs-feat-check">
                              {f.ok ? (
                                <Check size={10} strokeWidth={3} />
                              ) : (
                                <span style={{ fontSize: 11 }}>—</span>
                              )}
                            </span>
                            <span style={f.ok ? {} : { color: "#c7c0b8" }}>
                              {f.text}
                            </span>
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                );
              })}
            </div>

            {/* Trust strip */}
            <div className="zs-trust zs-reveal zs-d3">
              <div className="zs-trust-item">
                <Lock size={15} /> Secure Shopify billing
              </div>
              <div className="zs-trust-item">
                <Undo size={15} /> Cancel anytime
              </div>
              <div className="zs-trust-item">
                <Zap size={15} /> Instant activation
              </div>
              <div className="zs-trust-item">
                <MessageCircle size={15} /> Human support
              </div>
            </div>

            {/* Usage */}
            {DISPLAY_TYPES.some((t) => (usage[t] || 0) > 0) && (
              <div className="zs-usage zs-reveal zs-d3">
                <div className="zs-usage-title">Usage this billing period</div>
                <div className="zs-usage-grid">
                  {DISPLAY_TYPES.map((t) => {
                    const used = usage[t] || 0;
                    const lim = planLimits[current]?.[t] || 0;
                    if (lim === 0 && used === 0) return null;
                    const pct = lim > 0 ? Math.min((used / lim) * 100, 100) : 0;
                    const barClass =
                      pct >= 100 ? "full" : pct >= 80 ? "warn" : "";
                    return (
                      <div key={t} className="zs-usage-row">
                        <div className="zs-usage-label">
                          <span>{TYPE_LABEL[t]}</span>
                          <span>
                            <b>{used}</b> / {lim}
                          </span>
                        </div>
                        <div className="zs-bar-wrap">
                          <div
                            className={`zs-bar ${barClass}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* FAQ */}
            <div className="zs-reveal zs-d3">
              <div className="zs-faq-title">Frequently asked questions</div>
              <div className="zs-faq-grid">
                {faqs.map((f, i) => (
                  <div key={i} className="zs-faq-card">
                    <div className="zs-faq-q">{f.q}</div>
                    <div className="zs-faq-a">{f.a}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
