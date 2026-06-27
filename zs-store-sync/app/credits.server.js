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
    products: 20,
    collections: 10,
    pages: 10,
    files: 0,
    metaobjects: 0,
    metafields: 0,
    orders: 0,
    customers: 0,
  },
  starter: {
    products: 500,
    collections: 100,
    pages: 50,
    files: 500,
    metaobjects: 30,
    metafields: 30,
    orders: 0,
    customers: 0,
  },
  pro: {
    products: 1000,
    collections: 500,
    pages: 200,
    files: 1000,
    metaobjects: 200,
    metafields: 200,
    orders: 100,
    customers: 100,
  },
};

// ─── Overage rate per item over limit (Pro plan only) ─────────────────────────
export const OVERAGE_RATE = {
  products: 0.02,
  collections: 0.05,
  pages: 0.05,
  files: 0.02,
  metaobjects: 0.05,
  metafields: 0.02,
  orders: 0.5,
  customers: 0.5,
};

// ─── Which plans allow overage (pay-per-item past the limit) ──────────────────
export const OVERAGE_PLANS = ["pro"];

// ─── Monthly price shown in UI (Shopify Billing handles real charge) ──────────
export const PLAN_PRICE = {
  free: 0,
  starter: 12.99,
  pro: 39.99,
};

export const PLAN_LABEL = {
  free: "Free Plan",
  starter: "Starter Plan",
  pro: "Pro Plan",
};

// All known data types (order matters for display)
export const ALL_DATA_TYPES = [
  "products", "collections", "pages",
  "files", "metaobjects", "metafields",
  "orders", "customers",
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
