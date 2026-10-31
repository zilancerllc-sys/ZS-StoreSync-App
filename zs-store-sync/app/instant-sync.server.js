// ═══════════════════════════════════════
//  ZS StoreSync — instant product sync
//
//  A products/create or products/update webhook from a source store queues the
//  product for every store that switched instant sync on for that source. The
//  queue is drained on the schedule ticker, after a short wait, so an edit
//  session or a bulk import becomes one run rather than a run per save.
// ═══════════════════════════════════════
import db from "./db.server";
import { getUsage, filterAllowedTypes } from "./credits.server";
import { planAllowsSchedule } from "./schedule-config";
import { getActiveJob, startMigrationJob } from "./jobs.server";

const SETTLE_MS = 45 * 1000;
const BATCH = 50;

export async function queueProductChange(sourceShop, productId) {
  if (!/^\d+$/.test(String(productId))) return;
  const owners = await db.storeConnection.findMany({
    where: { sourceShop, instantSync: true, authorized: true, codeVerified: true },
    select: { ownerShop: true },
  });
  if (!owners.length) return;
  await db.pendingProductSync.createMany({
    data: owners.map((o) => ({
      ownerShop: o.ownerShop,
      sourceShop,
      productId: String(productId),
    })),
    skipDuplicates: true,
  });
}

// Returns { error } (shown through t()) or null.
export async function setInstantSync(ownerShop, sourceShop, enabled) {
  if (enabled) {
    const usage = await getUsage(ownerShop);
    if (!planAllowsSchedule(usage.plan)) {
      return { error: "Instant sync isn't included on the Free plan. Upgrade to turn it on." };
    }
    // Each store's sync would count as a change on the other, forever.
    const reverse = await db.storeConnection.findFirst({
      where: { ownerShop: sourceShop, sourceShop: ownerShop, instantSync: true },
    });
    if (reverse) {
      return { error: "Instant sync is already on in the other direction. Turn it off on that store first." };
    }
  }
  await db.storeConnection.updateMany({
    where: { ownerShop, sourceShop },
    data: { instantSync: enabled },
  });
  if (!enabled) await db.pendingProductSync.deleteMany({ where: { ownerShop, sourceShop } });
  return null;
}

async function drainPair(ownerShop, sourceShop, settledBefore) {
  const conn = await db.storeConnection.findFirst({
    where: { ownerShop, sourceShop, instantSync: true, authorized: true, codeVerified: true },
  });
  const usage = await getUsage(ownerShop);
  if (!conn || !planAllowsSchedule(usage.plan)) {
    await db.pendingProductSync.deleteMany({ where: { ownerShop, sourceShop } });
    return "dropped";
  }

  // Busy is fine: the rows wait for the next tick.
  if (await getActiveJob(ownerShop)) return "busy";

  const rows = await db.pendingProductSync.findMany({
    where: { ownerShop, sourceShop, createdAt: { lt: settledBefore } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });
  if (!rows.length) return "none";

  const { allowed } = await filterAllowedTypes(ownerShop, ["products"]);
  if (!allowed.length) return "none";

  const remaining = Math.max((usage.limits.products || 0) - (usage.usage.products || 0), 0);
  const jobId = await startMigrationJob({
    shop: ownerShop,
    sourceShop,
    mode: "sync",
    types: ["products"],
    limits: { products: remaining },
    productFilter: { ids: rows.map((r) => r.productId) },
  });
  if (!jobId) return "busy";

  await db.pendingProductSync.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  return "started";
}

export async function runDueInstantSyncs() {
  const settledBefore = new Date(Date.now() - SETTLE_MS);
  const pairs = await db.pendingProductSync.findMany({
    where: { createdAt: { lt: settledBefore } },
    distinct: ["ownerShop", "sourceShop"],
    select: { ownerShop: true, sourceShop: true },
  });
  const results = [];
  for (const { ownerShop, sourceShop } of pairs) {
    const outcome = await drainPair(ownerShop, sourceShop, settledBefore);
    results.push({ shop: ownerShop, outcome });
  }
  return results;
}
