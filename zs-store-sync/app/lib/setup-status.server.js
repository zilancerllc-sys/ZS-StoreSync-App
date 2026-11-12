// What, if anything, stops this merchant from copying data right now.
//
// One answer: the first blocker in the order a merchant meets them, so every
// admin page can say where they are stuck and give the one action that fixes
// it. Database only (no Admin API call), so it runs on every admin page and
// for every store on the owner dashboard. Read only: unlike getUsage() and
// listConnections() it never creates or updates a row.
//
// Codes, in order:
//   code_unused      this store's connection code was shown (Settings) but no
//                    store has paired with it, and this store copies from none
//   no_source        no store paired yet (this store is not a source either)
//   pair_revoked     a pairing exists but its code was changed, so it no longer works
//   source_gone      paired, but ZS StoreSync is no longer installed on the source
//   no_run           paired and ready, no migration or sync run yet
//   run_failed       the latest migration / sync failed
//   limit_reached    a data type's monthly plan limit is used up
//   run_partial      the latest run finished, but some items failed (which types)
//   schedule_paused  an automatic sync was paused by the app (plan, pairing)
//   ok               nothing in the way
//
// A store that only ever acts as a source (others pull from it) is "ok".
import prisma from "../db.server";
import { PLAN_LIMITS, PLAN_LABEL, ALL_DATA_TYPES, isCompShop } from "../credits.server";

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_MODES = ["migrate", "sync"];

// Same wording as History; the English is the translation key.
export const TYPE_LABEL = {
  products: "Products",
  collections: "Collections",
  pages: "Pages",
  discounts: "Discounts",
  files: "Files",
  menus: "Menus",
  redirects: "Redirects",
  metaobjects: "Metaobjects",
  blogPosts: "Blog Posts",
  inventory: "Stock levels",
  translations: "Translations",
  metafields: "Metafields",
  orders: "Orders",
  customers: "Customers",
};

function parseJson(json) {
  try {
    const v = JSON.parse(json || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function blockerFrom({
  conns = [],
  liveShops = new Set(),
  pulling = false,
  hasCode = false,
  lastRun = null,
  sub = null,
  comp = false,
  schedules = [],
  now = Date.now(),
}) {
  const verified = conns.filter((c) => c.codeVerified);
  if (!verified.length) {
    if (pulling) return { code: "ok", role: "source" };
    if (conns.length) return { code: "pair_revoked", sourceShop: conns[0].sourceShop };
    return { code: hasCode ? "code_unused" : "no_source" };
  }
  const ready = verified.filter((c) => liveShops.has(c.sourceShop));
  if (!ready.length) return { code: "source_gone", sourceShop: verified[0].sourceShop };

  if (!lastRun) return { code: "no_run", sourceShop: ready[0].sourceShop };

  if (lastRun.status === "failed") {
    return {
      code: "run_failed",
      jobId: lastRun.id,
      sourceShop: lastRun.sourceShop,
      error: String(lastRun.error || "").slice(0, 220),
    };
  }

  // Monthly plan limits, read the way getUsage() reads them (a window older
  // than 30 days counts as already reset).
  if (sub) {
    const plan = comp ? "pro" : sub.plan || "free";
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const started = new Date(sub.periodStart).getTime();
    if (now - started < PERIOD_MS) {
      const usage = parseJson(sub.usageJson);
      const full = ALL_DATA_TYPES.find((t) => limits[t] > 0 && (usage[t] || 0) >= limits[t]);
      if (full) {
        return {
          code: "limit_reached",
          type: full,
          typeLabel: TYPE_LABEL[full] || full,
          limit: limits[full],
          plan,
          planLabel: PLAN_LABEL[plan] || "Free Plan",
          resetsAt: new Date(started + PERIOD_MS).toISOString(),
        };
      }
    }
  }

  if (lastRun.status === "partial") {
    const stats = parseJson(lastRun.statsJson);
    const parts = Object.entries(stats)
      .filter(([, s]) => s && s.failed > 0)
      .map(([type, s]) => ({ type, label: TYPE_LABEL[type] || type, failed: s.failed }));
    return {
      code: "run_partial",
      jobId: lastRun.id,
      sourceShop: lastRun.sourceShop,
      failed: lastRun.failedCount || parts.reduce((n, p) => n + p.failed, 0),
      parts,
    };
  }

  const paused = schedules.find((s) => !s.enabled && /^Paused/.test(s.lastError || ""));
  if (paused) return { code: "schedule_paused", sourceShop: paused.sourceShop, reason: paused.lastError };

  return { code: "ok" };
}

export async function setupStatus(shop) {
  const [conns, pullingCount, secret, lastRun, sub, schedules] = await Promise.all([
    prisma.storeConnection
      .findMany({ where: { ownerShop: shop }, select: { sourceShop: true, codeVerified: true }, orderBy: { createdAt: "desc" } })
      .catch(() => []),
    prisma.storeConnection
      .count({ where: { sourceShop: shop, codeVerified: true, ownerShop: { not: shop } } })
      .catch(() => 0),
    prisma.shopSecret.findUnique({ where: { shop }, select: { id: true } }).catch(() => null),
    prisma.migrationJob
      .findFirst({
        where: { shop, mode: { in: RUN_MODES } },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, error: true, statsJson: true, sourceShop: true, failedCount: true },
      })
      .catch(() => null),
    prisma.subscription
      .findUnique({ where: { shop }, select: { plan: true, usageJson: true, periodStart: true } })
      .catch(() => null),
    prisma.syncSchedule
      .findMany({ where: { ownerShop: shop }, select: { sourceShop: true, enabled: true, lastError: true } })
      .catch(() => []),
  ]);

  // The source can be read only while it still has an offline session (the
  // uninstall webhook deletes it): the same truth listConnections() uses.
  const sources = [...new Set(conns.filter((c) => c.codeVerified).map((c) => c.sourceShop))];
  const live = sources.length
    ? await prisma.session
        .findMany({ where: { shop: { in: sources }, isOnline: false }, select: { shop: true, accessToken: true } })
        .catch(() => [])
    : [];

  const b = blockerFrom({
    conns,
    liveShops: new Set(live.filter((s) => s.accessToken).map((s) => s.shop)),
    pulling: pullingCount > 0,
    hasCode: !!secret,
    // A run still queued or running is neither failed nor partial, so it
    // passes the run checks until it finishes.
    lastRun,
    sub,
    comp: isCompShop(shop),
    schedules,
  });
  return {
    ...b,
    // Nothing done yet, either way round: the welcome is shown on the Dashboard.
    fresh: !conns.length && !pullingCount && !lastRun,
  };
}

// Short labels for the owner dashboard's "Stuck at" line.
export const BLOCKER_LABEL = {
  code_unused: "Code shown, never used",
  no_source: "No store connected",
  pair_revoked: "Pairing revoked (code changed)",
  source_gone: "App removed from source store",
  no_run: "Connected, never ran",
  run_failed: "Last run failed",
  limit_reached: "Plan limit reached",
  run_partial: "Last run partly failed",
  schedule_paused: "Auto-sync paused",
  ok: "",
};
