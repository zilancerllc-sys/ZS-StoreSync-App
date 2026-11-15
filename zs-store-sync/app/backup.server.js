// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — backups before sync, and restore
//
//  The engine (migrator.server.js) reads what an existing item looks like just
//  before a sync overwrites it; this file keeps those snapshots for 30 days and
//  writes them back on request. See app/lib/backup-core.js for what is kept.
// ═════════════════════════════════════════════════════════════════════════════
import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { gql, sleep } from "./migrator.server";
import { redactPII } from "./redact.server";
import { safeLogsJson } from "./jobs.server";
import { sourcesFromRuleSet } from "./lib/collection-sources";
import {
  BACKUP_DAYS,
  BACKUP_MAX_ROWS_PER_SHOP,
  encodeSnapshot,
  decodeSnapshot,
  productRestoreInputs,
  collectionRestoreInput,
  pageRestoreInput,
} from "./lib/backup-core.js";

const BACKUP_MS = BACKUP_DAYS * 24 * 60 * 60 * 1000;

// The engine calls this for every item it is about to overwrite.
export function backupWriter(jobId, shop) {
  return async (kind, gid, label, snapshot) => {
    await db.syncBackup.create({
      data: { jobId, shop, kind, gid, label: String(label || "").slice(0, 200), data: encodeSnapshot(snapshot) },
    });
  };
}

// 30 days, and at most BACKUP_MAX_ROWS_PER_SHOP rows per store (oldest go).
export async function purgeOldBackups(shop) {
  await db.syncBackup.deleteMany({
    where: { shop, createdAt: { lt: new Date(Date.now() - BACKUP_MS) } },
  });
  const count = await db.syncBackup.count({ where: { shop } });
  if (count > BACKUP_MAX_ROWS_PER_SHOP) {
    const cut = await db.syncBackup.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      skip: BACKUP_MAX_ROWS_PER_SHOP,
      take: 1,
      select: { createdAt: true },
    });
    if (cut[0]) {
      await db.syncBackup.deleteMany({ where: { shop, createdAt: { lte: cut[0].createdAt } } });
    }
  }
}

// Every store's, once an hour, from the ticker.
let lastGlobalPurge = 0;
export async function purgeAllOldBackups() {
  if (Date.now() - lastGlobalPurge < 60 * 60 * 1000) return;
  lastGlobalPurge = Date.now();
  await db.syncBackup.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - BACKUP_MS) } } });
}

// { jobId: backups not yet restored }
export async function restorableCounts(shop, jobIds) {
  if (!jobIds.length) return {};
  const rows = await db.syncBackup.groupBy({
    by: ["jobId"],
    where: { shop, jobId: { in: jobIds }, restoredAt: null },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.jobId, r._count._all]));
}

const M_PRODUCT_UPDATE = `#graphql
  mutation RestoreProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) { product { id } userErrors { field message } }
  }`;
const Q_PRODUCT_VARIANT_IDS = `#graphql
  query RestoreVariantIds($id: ID!, $cursor: String) {
    product(id: $id) {
      id
      variants(first: 250, after: $cursor) { pageInfo { hasNextPage endCursor } edges { node { id } } }
    }
  }`;
const M_VARIANTS_UPDATE = `#graphql
  mutation RestoreVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
  }`;
const M_COLLECTION_UPDATE = `#graphql
  mutation RestoreCollection($collection: CollectionUpdateInput!) {
    collectionUpdate(collection: $collection) { collection { id } userErrors { field message } }
  }`;
const Q_COLLECTION_SOURCES = `#graphql
  query RestoreColSources($id: ID!) {
    collection(id: $id) {
      id
      sources { id ... on CollectionConditionsSource { inclusion { conditions { __typename } } } }
    }
  }`;
const Q_SHOP_UNITS = `#graphql
  query RestoreShopUnits { shop { currencyCode weightUnit } }`;
const M_PAGE_UPDATE = `#graphql
  mutation RestorePage($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) { page { id } userErrors { field message } }
  }`;
const M_METAFIELDS_SET = `#graphql
  mutation RestoreMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;
const M_METAFIELDS_DELETE = `#graphql
  mutation RestoreMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { userErrors { field message } }
  }`;

const GONE = /not found|does not exist|doesn't exist|can't be found|invalid id/i;
const errs = (list) =>
  (list || []).map((e) => (e.field ? `${[].concat(e.field).join(".")}: ${e.message}` : e.message)).join(" | ").slice(0, 300);

async function restoreMetafields(admin, { set, remove }) {
  const problems = [];
  for (let i = 0; i < set.length; i += 25) {
    const d = await gql(admin, M_METAFIELDS_SET, { metafields: set.slice(i, i + 25) });
    if (d?.metafieldsSet?.userErrors?.length) problems.push(errs(d.metafieldsSet.userErrors));
  }
  for (let i = 0; i < remove.length; i += 25) {
    const d = await gql(admin, M_METAFIELDS_DELETE, { metafields: remove.slice(i, i + 25) });
    if (d?.metafieldsDelete?.userErrors?.length) problems.push(errs(d.metafieldsDelete.userErrors));
  }
  return problems;
}

// → { ok, error?, note? }
export async function restoreOne(admin, row, ctx = {}) {
  const snap = decodeSnapshot(row.data);
  if (row.kind === "product") {
    let cursor = null;
    const ids = [];
    for (let page = 0; page < 20; page++) {
      const d = await gql(admin, Q_PRODUCT_VARIANT_IDS, { id: row.gid, cursor });
      if (!d?.product) return { ok: false, error: "no longer on this store" };
      ids.push(...d.product.variants.edges.map((e) => e.node.id));
      cursor = d.product.variants.pageInfo.hasNextPage ? d.product.variants.pageInfo.endCursor : null;
      if (!cursor) break;
    }
    const { product, variants, metafields } = productRestoreInputs(row.gid, snap, ids);
    const d = await gql(admin, M_PRODUCT_UPDATE, { product });
    if (d?.productUpdate?.userErrors?.length) return { ok: false, error: errs(d.productUpdate.userErrors) };
    const problems = [];
    for (let i = 0; i < variants.length; i += 250) {
      const v = await gql(admin, M_VARIANTS_UPDATE, { productId: row.gid, variants: variants.slice(i, i + 250) });
      if (v?.productVariantsBulkUpdate?.userErrors?.length) problems.push(errs(v.productVariantsBulkUpdate.userErrors));
    }
    problems.push(...(await restoreMetafields(admin, metafields)));
    const added = ids.length - variants.length;
    return {
      ok: !problems.length,
      error: problems.join(" | ") || undefined,
      note: added > 0 ? `${added} variant(s) added since the backup were left in place` : undefined,
    };
  }
  if (row.kind === "collection") {
    const { collection, metafields } = collectionRestoreInput(row.gid, snap);
    let note;
    if (snap.ruleSet?.rules?.length) {
      if (!ctx.units) {
        const u = await gql(admin, Q_SHOP_UNITS);
        ctx.units = { currencyCode: u?.shop?.currencyCode || "USD", weightUnit: u?.shop?.weightUnit || "KILOGRAMS" };
      }
      const built = sourcesFromRuleSet(snap.ruleSet, snap.title, ctx.units);
      if (built.skip) {
        note = `rules not restored: ${built.skip}`;
      } else {
        const cs = await gql(admin, Q_COLLECTION_SOURCES, { id: row.gid });
        if (!cs?.collection) return { ok: false, error: "no longer on this store" };
        collection.sourcesToDelete = (cs.collection.sources || [])
          .filter((x) => x.inclusion?.conditions?.length)
          .map((x) => x.id);
        collection.sourcesToCreate = built.sources;
      }
    }
    const d = await gql(admin, M_COLLECTION_UPDATE, { collection });
    if (d?.collectionUpdate?.userErrors?.length) return { ok: false, error: errs(d.collectionUpdate.userErrors) };
    const problems = await restoreMetafields(admin, metafields);
    return { ok: !problems.length, error: problems.join(" | ") || undefined, note };
  }
  if (row.kind === "page") {
    const { id, page, metafields } = pageRestoreInput(row.gid, snap);
    const d = await gql(admin, M_PAGE_UPDATE, { id, page });
    if (d?.pageUpdate?.userErrors?.length) return { ok: false, error: errs(d.pageUpdate.userErrors) };
    const problems = await restoreMetafields(admin, metafields);
    return { ok: !problems.length, error: problems.join(" | ") || undefined };
  }
  return { ok: false, error: "unknown backup kind" };
}

// Returns { jobId } or { error } (shown through t()).
export async function startRestoreJob(shop, jobId) {
  const target = await db.migrationJob.findFirst({ where: { id: jobId, shop } });
  if (!target || target.status === "running") return { error: "This run can't be restored." };
  const count = await db.syncBackup.count({ where: { jobId, shop, restoredAt: null } });
  if (!count) return { error: "This run has no backups left to restore." };

  let job;
  try {
    job = await db.migrationJob.create({
      data: {
        shop,
        sourceShop: target.sourceShop,
        targetShop: shop,
        mode: "restore",
        dataTypes: "",
        status: "running",
        startedAt: new Date(),
        restoreOfJobId: jobId,
      },
    });
  } catch (err) {
    if (err?.code === "P2002") {
      return { error: "A migration or sync is already running for this store. Wait for it to finish (see History)." };
    }
    throw err;
  }
  runRestore(job.id, jobId, shop).catch((err) => console.error(`Restore job ${job.id} crashed:`, err));
  return { jobId: job.id };
}

async function runRestore(restoreJobId, targetJobId, shop) {
  const logs = [];
  const log = (msg) => logs.push(`[${new Date().toISOString().slice(11, 19)}] ${redactPII(msg)}`);
  let restored = 0;
  let failed = 0;
  let stopped = false;
  try {
    const { admin } = await unauthenticated.admin(shop);
    // The newest backup of an item wins if a run touched it twice; restore
    // oldest-first so that is what is left.
    const rows = await db.syncBackup.findMany({
      where: { jobId: targetJobId, shop, restoredAt: null },
      orderBy: { createdAt: "asc" },
    });
    log(`Putting back ${rows.length} item(s) as they were before this run…`);
    const ctx = {};
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (i % 10 === 0) {
        const cur = await db.migrationJob.findUnique({ where: { id: restoreJobId }, select: { cancelRequested: true } });
        if (cur?.cancelRequested) {
          stopped = true;
          break;
        }
        await db.migrationJob.updateMany({
          where: { id: restoreJobId, status: "running" },
          data: { logJson: safeLogsJson(logs) },
        });
      }
      const label = `${row.kind} ${row.label || row.gid.split("/").pop()}`;
      try {
        const r = await restoreOne(admin, row, ctx);
        if (r.ok) {
          restored++;
          await db.syncBackup.update({ where: { id: row.id }, data: { restoredAt: new Date() } });
          log(`↻ Restored ${label}`);
        } else if (GONE.test(r.error || "")) {
          failed++;
          log(`✕ Not restored: ${label} — it's no longer on this store`);
        } else {
          failed++;
          log(`✕ Not restored: ${label} — ${r.error}`);
        }
        if (r.note) log(`  ⚠ ${label}: ${r.note}`);
      } catch (err) {
        failed++;
        log(`✕ Not restored: ${label} — ${String(err?.message || err).slice(0, 160)}`);
      }
      await sleep(200);
    }
    if (stopped) log("Stopped — items not restored yet can still be restored.");
    await db.migrationJob.update({
      where: { id: restoreJobId },
      data: {
        status: stopped ? "stopped" : failed ? "partial" : "completed",
        itemCount: restored + failed,
        updatedCount: restored,
        failedCount: failed,
        summary: `${restored} restored · ${failed} not restored`,
        logJson: safeLogsJson(logs),
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    await db.migrationJob
      .update({
        where: { id: restoreJobId },
        data: {
          status: "failed",
          error: String(err?.message || err).slice(0, 500),
          logJson: safeLogsJson(logs),
          finishedAt: new Date(),
        },
      })
      .catch(() => {});
  }
}
