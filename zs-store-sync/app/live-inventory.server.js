// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — live stock sync (one way: source → this store)
//
//  inventory_levels/update from a source store queues the inventory item for
//  every store that switched live stock on for that source. The ticker drains
//  the queue about every minute: it reads the CURRENT stock from the source
//  (never trusting the webhook body), finds the same variant on this store by
//  SKU then barcode, and writes only what changed. Every guard lives in
//  lib/inventory-guards.js.
// ═════════════════════════════════════════════════════════════════════════════
import { randomUUID } from "node:crypto";
import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { gql, sleep } from "./migrator.server";
import { getUsage } from "./credits.server";
import { getVerifiedConnection } from "./connection.server";
import { planHas } from "./lib/plan-features.js";
import { notifyLiveStockPaused } from "./notify.server";
import {
  pickTargetVariant,
  planInventoryWrites,
  normalizeGuards,
  cleanLocationMap,
} from "./lib/inventory-guards.js";

const SETTLE_MS = 20 * 1000;
const ITEMS_PER_TICK = 100; // per pair, per minute — the rate limit
const READ_BATCH = 10;
const ACTIVITY_MAX = 50;

// ── Which stores are live sources? Cached, because every store with the app
// sends inventory webhooks and almost none of them are sources.
let sourceCache = { at: 0, set: new Set() };
async function liveSources() {
  if (Date.now() - sourceCache.at < 60 * 1000) return sourceCache.set;
  const rows = await db.liveInventorySync.findMany({
    where: { enabled: true },
    select: { sourceShop: true },
    distinct: ["sourceShop"],
  });
  sourceCache = { at: Date.now(), set: new Set(rows.map((r) => r.sourceShop)) };
  return sourceCache.set;
}
export function forgetLiveSourceCache() {
  sourceCache = { at: 0, set: new Set() };
}

export async function queueInventoryChange(sourceShop, inventoryItemId) {
  if (!/^\d+$/.test(String(inventoryItemId))) return;
  if (!(await liveSources()).has(sourceShop)) return;
  const owners = await db.liveInventorySync.findMany({
    where: { sourceShop, enabled: true, pausedAt: null },
    select: { ownerShop: true },
  });
  if (!owners.length) return;
  await db.pendingInventorySync.createMany({
    data: owners.map((o) => ({
      ownerShop: o.ownerShop,
      sourceShop,
      inventoryItemId: String(inventoryItemId),
    })),
    skipDuplicates: true,
  });
}

// ── Settings ─────────────────────────────────────────────────────────────────
export async function getLiveSettings(ownerShop, sourceShop) {
  return db.liveInventorySync.findUnique({
    where: { ownerShop_sourceShop: { ownerShop, sourceShop } },
  });
}

export function parseLocationMap(json) {
  try {
    const v = JSON.parse(json || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function parseActivity(json) {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const Q_LOCATIONS = `#graphql
  query LiveLocations {
    locations(first: 100) { edges { node { id name isActive } } }
  }`;

export async function readLocations(admin) {
  const d = await gql(admin, Q_LOCATIONS);
  return (d?.locations?.edges || []).map((e) => e.node).filter((l) => l.isActive !== false);
}

// Returns { error } (shown through t()) or { ok: true }.
export async function saveLiveSettings({ ownerShop, sourceShop, enabled, locationMap, guards, sourceLocations, targetLocations }) {
  if (enabled) {
    const usage = await getUsage(ownerShop);
    if (!planHas(usage.plan, "liveInventory")) {
      return { error: "Live stock sync is on the Growth and Pro plans." };
    }
    // Each store's writes would count as a change on the other, forever.
    const reverse = await db.liveInventorySync.findFirst({
      where: { ownerShop: sourceShop, sourceShop: ownerShop, enabled: true },
    });
    if (reverse) {
      return { error: "Live stock sync is already on in the other direction. Turn it off on that store first." };
    }
  }
  const map = cleanLocationMap(locationMap, sourceLocations, targetLocations);
  if (enabled && !Object.values(map).some(Boolean)) {
    return { error: "Pick a location on this store for at least one source location." };
  }
  const g = normalizeGuards(guards);
  const data = {
    enabled,
    locationMapJson: JSON.stringify(map),
    maxZeroPerBatch: g.maxZeroPerBatch,
    maxUnitChange: g.maxUnitChange,
    // saving (or resuming) clears a pause: the merchant has looked
    pausedAt: null,
    pauseReason: null,
  };
  await db.liveInventorySync.upsert({
    where: { ownerShop_sourceShop: { ownerShop, sourceShop } },
    update: data,
    create: { ownerShop, sourceShop, ...data },
  });
  if (!enabled) await db.pendingInventorySync.deleteMany({ where: { ownerShop, sourceShop } });
  forgetLiveSourceCache();
  return { ok: true };
}

// ── Reading stock ────────────────────────────────────────────────────────────
const Q_SOURCE_ITEMS = `#graphql
  query LiveSourceItems($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id sku tracked
        variant { barcode title displayName }
        inventoryLevels(first: 50) { edges { node {
          location { id }
          quantities(names: ["available"]) { name quantity }
        } } }
      }
    }
  }`;

const Q_TARGET_VARIANTS = `#graphql
  query LiveTargetVariants($q: String!) {
    productVariants(first: 5, query: $q) {
      nodes {
        id sku barcode
        inventoryItem {
          id tracked
          inventoryLevels(first: 50) { nodes {
            location { id }
            quantities(names: ["available"]) { name quantity }
          } }
        }
      }
    }
  }`;

const M_TRACK = `#graphql
  mutation LiveTrack($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id } userErrors { field message } }
  }`;
const M_ACTIVATE = `#graphql
  mutation LiveActivate($inventoryItemId: ID!, $locationId: ID!, $key: String!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $key) {
      inventoryLevel { id }
      userErrors { field message }
    }
  }`;
const M_SET = `#graphql
  mutation LiveSet($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
      userErrors { field message }
    }
  }`;

const qv = (v) => `"${String(v).replace(/[\\"]/g, "\\$&")}"`;
const errText = (errs) => (errs || []).map((e) => e.message).join("; ").slice(0, 300);

async function findTarget(target, sku, barcode) {
  const bySku = sku ? (await gql(target, Q_TARGET_VARIANTS, { q: `sku:${qv(sku)}` }))?.productVariants?.nodes || [] : [];
  let byBarcode = [];
  const skuHit = bySku.filter((v) => String(v.sku || "").trim() === String(sku || "").trim());
  if (!skuHit.length && barcode) {
    byBarcode = (await gql(target, Q_TARGET_VARIANTS, { q: `barcode:${qv(barcode)}` }))?.productVariants?.nodes || [];
  }
  return pickTargetVariant({ sku, barcode, candidatesBySku: bySku, candidatesByBarcode: byBarcode });
}

function levelsOf(nodes) {
  const out = {};
  for (const l of nodes || []) {
    const q = l.quantities?.find((x) => x.name === "available")?.quantity;
    out[l.location?.id] = q;
  }
  return out;
}

async function pause(settings, reason) {
  await db.liveInventorySync.update({
    where: { id: settings.id },
    data: { pausedAt: new Date(), pauseReason: reason.slice(0, 400), lastRunAt: new Date(), lastSummary: "Paused by the safety check — nothing written." },
  });
  await db.pendingInventorySync.deleteMany({ where: { ownerShop: settings.ownerShop, sourceShop: settings.sourceShop } });
  forgetLiveSourceCache();
  try {
    const [schedule, contact] = await Promise.all([
      db.syncSchedule.findFirst({ where: { ownerShop: settings.ownerShop, sourceShop: settings.sourceShop, notify: true } }),
      db.merchantContact.findUnique({ where: { shop: settings.ownerShop } }),
    ]);
    const to = schedule?.notifyEmail || (contact?.uninstalledAt ? null : contact?.email);
    if (to) await notifyLiveStockPaused({ to, shop: settings.ownerShop, sourceShop: settings.sourceShop, reason });
  } catch (err) {
    console.error("[live-stock] pause mail failed:", err);
  }
}

// One pair, one tick. Exported for the test harness.
export async function drainLivePair(settings, settledBefore) {
  const { ownerShop, sourceShop } = settings;
  const conn = await getVerifiedConnection(ownerShop, sourceShop);
  const usage = await getUsage(ownerShop);
  if (!conn || !planHas(usage.plan, "liveInventory")) {
    await db.pendingInventorySync.deleteMany({ where: { ownerShop, sourceShop } });
    await db.liveInventorySync.update({
      where: { id: settings.id },
      data: {
        enabled: false,
        lastSummary: !conn
          ? "Turned off — this store pairing was removed."
          : "Turned off — live stock sync is on the Growth and Pro plans.",
      },
    });
    forgetLiveSourceCache();
    return "dropped";
  }

  const rows = await db.pendingInventorySync.findMany({
    where: { ownerShop, sourceShop, createdAt: { lt: settledBefore } },
    orderBy: { createdAt: "asc" },
    take: ITEMS_PER_TICK,
  });
  if (!rows.length) return "none";
  // Taken off the queue first: a later change re-queues the item, so one bad
  // item can never block the queue.
  await db.pendingInventorySync.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });

  const { admin: source } = await unauthenticated.admin(sourceShop);
  const { admin: target } = await unauthenticated.admin(ownerShop);
  const locationMap = parseLocationMap(settings.locationMapJson);

  const items = [];
  for (let i = 0; i < rows.length; i += READ_BATCH) {
    const ids = rows.slice(i, i + READ_BATCH).map((r) => `gid://shopify/InventoryItem/${r.inventoryItemId}`);
    let nodes = [];
    try {
      nodes = (await gql(source, Q_SOURCE_ITEMS, { ids }))?.nodes || [];
    } catch {
      for (const id of ids) items.push({ label: id.split("/").pop(), sourceLevels: null });
      continue;
    }
    for (let k = 0; k < ids.length; k++) {
      const n = nodes[k];
      if (!n?.id) {
        items.push({ label: ids[k].split("/").pop(), sourceLevels: null });
        continue;
      }
      const label = n.variant?.displayName || n.sku || ids[k].split("/").pop();
      if (!n.tracked) {
        items.push({ label, skip: "stock isn't tracked on the source store" });
        continue;
      }
      const sourceLevels = (n.inventoryLevels?.edges || []).map(({ node: l }) => ({
        locationId: l.location?.id,
        available: l.quantities?.find((x) => x.name === "available")?.quantity ?? null,
      }));
      try {
        const picked = await findTarget(target, n.sku, n.variant?.barcode);
        if (picked.skip) {
          items.push({ label, skip: picked.skip });
          continue;
        }
        items.push({
          label,
          sourceLevels,
          target: {
            inventoryItemId: picked.match.inventoryItem.id,
            tracked: picked.match.inventoryItem.tracked,
            levels: levelsOf(picked.match.inventoryItem.inventoryLevels?.nodes),
          },
        });
      } catch (err) {
        items.push({ label, skip: `couldn't read this store (${String(err.message).slice(0, 60)})` });
      }
    }
    await sleep(200);
  }

  const plan = planInventoryWrites(items, locationMap, settings);
  if (plan.pause) {
    await pause(settings, plan.pause);
    return "paused";
  }

  let written = 0;
  let failed = 0;
  const activity = [];
  // turn tracking on / stock the variant at a location it isn't stocked at yet
  for (const it of items) {
    if (it.target && it.target.tracked === false && plan.writes.some((w) => w.inventoryItemId === it.target.inventoryItemId)) {
      await gql(target, M_TRACK, { id: it.target.inventoryItemId, input: { tracked: true } }).catch(() => {});
    }
  }
  for (const w of plan.writes) {
    if (w.from === null) {
      await gql(target, M_ACTIVATE, { inventoryItemId: w.inventoryItemId, locationId: w.locationId, key: randomUUID() }).catch(() => {});
    }
  }
  for (let i = 0; i < plan.writes.length; i += 100) {
    const batch = plan.writes.slice(i, i + 100);
    try {
      const d = await gql(target, M_SET, {
        input: {
          name: "available",
          reason: "correction",
          quantities: batch.map((w) => ({
            inventoryItemId: w.inventoryItemId,
            locationId: w.locationId,
            quantity: w.quantity,
            changeFromQuantity: null,
          })),
        },
        key: randomUUID(),
      });
      const errs = d?.inventorySetQuantities?.userErrors || [];
      if (errs.length) {
        failed += batch.length;
        activity.push({ at: new Date().toISOString(), label: `${batch.length} change(s) not written`, error: errText(errs) });
      } else {
        written += batch.length;
        for (const w of batch) {
          activity.push({ at: new Date().toISOString(), label: w.label, from: w.from, to: w.quantity, location: w.locationId });
        }
      }
    } catch (err) {
      failed += batch.length;
      activity.push({ at: new Date().toISOString(), label: `${batch.length} change(s) not written`, error: String(err.message).slice(0, 200) });
    }
    await sleep(300);
  }
  for (const s of plan.skipped.slice(0, 10)) {
    activity.push({ at: new Date().toISOString(), label: s.label, skipped: s.reason });
  }

  const summary = `${written} updated · ${plan.unchanged} already right · ${plan.skipped.length} skipped${failed ? ` · ${failed} failed` : ""}`;
  const fresh = await db.liveInventorySync.findUnique({ where: { id: settings.id }, select: { activityJson: true } });
  await db.liveInventorySync.update({
    where: { id: settings.id },
    data: {
      lastRunAt: new Date(),
      lastSummary: summary,
      activityJson: JSON.stringify([...activity.reverse(), ...parseActivity(fresh?.activityJson)].slice(0, ACTIVITY_MAX)),
    },
  });
  return summary;
}

// A slow tick must not overlap the next one on this machine.
let draining = false;
export async function runDueLiveInventory() {
  if (draining) return [];
  draining = true;
  try {
    return await runDue();
  } finally {
    draining = false;
  }
}

async function runDue() {
  const settledBefore = new Date(Date.now() - SETTLE_MS);
  const pairs = await db.pendingInventorySync.findMany({
    where: { createdAt: { lt: settledBefore } },
    distinct: ["ownerShop", "sourceShop"],
    select: { ownerShop: true, sourceShop: true },
  });
  const results = [];
  for (const { ownerShop, sourceShop } of pairs) {
    const settings = await getLiveSettings(ownerShop, sourceShop);
    if (!settings?.enabled || settings.pausedAt) {
      await db.pendingInventorySync.deleteMany({ where: { ownerShop, sourceShop } });
      continue;
    }
    try {
      results.push({ shop: ownerShop, outcome: await drainLivePair(settings, settledBefore) });
    } catch (err) {
      results.push({ shop: ownerShop, outcome: `failed: ${String(err?.message || err).slice(0, 160)}` });
    }
  }
  return results;
}
