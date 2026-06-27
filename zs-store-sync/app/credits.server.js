import db from "./db.server";

// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — Per-type plan limits, overage & usage tracking
//
//  Each data type (products, collections, …) has its OWN monthly limit.
//  Free & Starter are HARD limits; Pro allows overage billed per item.
// ═════════════════════════════════════════════════════════════════════════════

// ─── Per-type limits per plan (0 = not available) ────────────────────────────
export const PLAN_LIMITS = {
  free: {
    products: 30,
    collections: 10,
    pages: 20,
    discounts: 5,
    files: 50,
    menus: 3,
    redirects: 100,
    metaobjects: 20,
    blogPosts: 20,
    metafields: 1000,
    orders: 5,
    customers: 5,
  },
  starter: {
    products: 500,
    collections: 50,
    pages: 50,
    discounts: 100,
    files: 5000,
    menus: 50,
    redirects: 10000,
    metaobjects: 100,
    blogPosts: 20,
    metafields: 50000,
    orders: 200,
    customers: 500,
  },
  growth: {
    products: 1500,
    collections: 500,
    pages: 200,
    discounts: 400,
    files: 20000,
    menus: 300,
    redirects: 50000,
    metaobjects: 250,
    blogPosts: 20,
    metafields: 75000,
    orders: 500,
    customers: 1000,
  },
  pro: {
    products: 3000,
    collections: 2000,
    pages: 500,
    discounts: 1000,
    files: 50000,
    menus: 1000,
    redirects: 100000,
    metaobjects: 500,
    blogPosts: 20,
    metafields: 100000,
    orders: 500,
    customers: 1000,
  },
};

// ─── Overage rate per item over limit ─────────────────────────────────────────
// Kept for future per-item billing; no plan currently allows overage (all
// tiers use hard limits, matching the published pricing).
export const OVERAGE_RATE = {
  products: 0.02,
  collections: 0.05,
  pages: 0.05,
  discounts: 0.05,
  files: 0.02,
  menus: 0.05,
  redirects: 0.02,
  metaobjects: 0.05,
  blogPosts: 0.05,
  metafields: 0.02,
  orders: 0.5,
  customers: 0.5,
};

// ─── Which plans allow overage (pay-per-item past the limit) ──────────────────
// Hard limits on every tier — no overage. (Empty = all limits are hard caps.)
export const OVERAGE_PLANS = [];

// ─── Monthly price shown in UI (Shopify Billing handles real charge) ──────────
export const PLAN_PRICE = {
  free: 0,
  starter: 12.99,
  growth: 24.99,
  pro: 39.99,
};

// ─── Annual price (billed once per year) ──────────────────────────────────────
export const PLAN_PRICE_ANNUAL = {
  free: 0,
  starter: 139.99,
  growth: 248.99,
  pro: 459.99,
};

// ─── % saved by paying annually vs 12× monthly (shown in UI) ──────────────────
export const PLAN_ANNUAL_SAVINGS = {
  starter: 10,
  growth: 17,
  pro: 4,
};

export const PLAN_LABEL = {
  free: "Free Plan",
  starter: "Starter Plan",
  growth: "Growth Plan",
  pro: "Pro Plan",
};

// All known data types (order matters for display)
export const ALL_DATA_TYPES = [
  "products", "collections", "pages", "discounts",
  "files", "menus", "redirects", "metaobjects",
  "blogPosts", "metafields", "orders", "customers",
];

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Parse usage JSON safely ──────────────────────────────────────────────────
function parseUsage(json) {
  try {
    return JSON.parse(json || "{}");
  } catch {
    return {};
  }
}

// ─── Allowed types for a plan (limit > 0) ─────────────────────────────────────
export function planAllowedTypes(plan) {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  return ALL_DATA_TYPES.filter((t) => limits[t] > 0);
}

// ─── Does this plan allow overage? ────────────────────────────────────────────
export function planAllowsOverage(plan) {
  return OVERAGE_PLANS.includes(plan);
}

// ─── Estimate overage cost for given overage counts ───────────────────────────
// overageByType: { products: 100, collections: 20, ... }
export function estimateOverageCost(overageByType) {
  let cost = 0;
  for (const [type, count] of Object.entries(overageByType || {})) {
    cost += (count || 0) * (OVERAGE_RATE[type] || 0);
  }
  return Math.round(cost * 100) / 100;
}

// ─── Get (or lazily create) subscription, rolling window if due ───────────────
export async function getUsage(shop) {
  let sub = await db.subscription.findUnique({ where: { shop } });
  if (!sub) {
    sub = await db.subscription.create({ data: { shop, plan: "free" } });
  }

  // roll the 30-day window if it has elapsed
  const now = Date.now();
  if (now - new Date(sub.periodStart).getTime() >= PERIOD_MS) {
    sub = await db.subscription.update({
      where: { shop },
      data: { monthlyUsed: 0, usageJson: "{}", periodStart: new Date() },
    });
  }

  const usage = parseUsage(sub.usageJson);
  const limits = PLAN_LIMITS[sub.plan] || PLAN_LIMITS.free;

  // remaining per type
  const remaining = {};
  for (const t of ALL_DATA_TYPES) {
    remaining[t] = Math.max((limits[t] || 0) - (usage[t] || 0), 0);
  }

  return {
    plan: sub.plan,
    status: sub.status,
    usage,                         // { products: 10, collections: 5, ... }
    limits,                        // { products: 1000, collections: 500, ... }
    remaining,                     // { products: 990, ... }
    allowedTypes: planAllowedTypes(sub.plan),
    allowsOverage: planAllowsOverage(sub.plan),
    periodStart: sub.periodStart,
  };
}

// ─── Record consumed items per type after a run ───────────────────────────────
// consumedByType: { products: 5, collections: 3, ... }
export async function consumeQuota(shop, consumedByType) {
  if (!consumedByType || typeof consumedByType !== "object") return;
  const sub = await db.subscription.findUnique({ where: { shop } });
  if (!sub) return;

  const usage = parseUsage(sub.usageJson);
  let total = 0;
  for (const [type, count] of Object.entries(consumedByType)) {
    if (!count || count <= 0) continue;
    usage[type] = (usage[type] || 0) + count;
    total += count;
  }

  await db.subscription.update({
    where: { shop },
    data: {
      usageJson: JSON.stringify(usage),
      monthlyUsed: { increment: total },
    },
  });
}

// ─── Remaining items for a specific type this period ──────────────────────────
export async function remainingForType(shop, type) {
  const u = await getUsage(shop);
  return u.remaining[type] ?? 0;
}

// ─── Check whether requested types are allowed on the shop's plan ─────────────
export async function filterAllowedTypes(shop, requestedTypes) {
  const u = await getUsage(shop);
  const allowed = requestedTypes.filter((t) => u.allowedTypes.includes(t));
  const blocked = requestedTypes.filter((t) => !u.allowedTypes.includes(t));
  return { allowed, blocked, plan: u.plan };
}

// ─── Set the plan (called from billing callback) ──────────────────────────────
export async function setPlan(shop, plan, shopifyChargeId = null) {
  return db.subscription.upsert({
    where: { shop },
    update: { plan, shopifyChargeId, status: "active" },
    create: { shop, plan, shopifyChargeId },
  });
}
