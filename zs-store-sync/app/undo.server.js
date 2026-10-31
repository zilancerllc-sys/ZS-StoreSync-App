// ═══════════════════════════════════════
//  ZS StoreSync — undo a run
//
//  Every run records the gid of each item it created (JobCreatedItem). Undo
//  deletes exactly those from the target store. Items a run updated or skipped
//  were not recorded, so they can't be touched. Only ids are stored, in keeping
//  with the app not holding store data.
// ═══════════════════════════════════════
import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { gql, sleep } from "./migrator.server";
import { redactPII } from "./redact.server";
import { safeLogsJson } from "./jobs.server";

export const UNDO_DAYS = 30;
const UNDO_MS = UNDO_DAYS * 24 * 60 * 60 * 1000;

const M_DEL_PRODUCT = `#graphql
  mutation UndoProduct($input: ProductDeleteInput!) {
    productDelete(input: $input, synchronous: true) {
      deletedProductId
      userErrors { field message }
    }
  }`;
const M_DEL_COLLECTION = `#graphql
  mutation UndoCollection($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) {
      deletedCollectionId
      userErrors { field message }
    }
  }`;
const M_DEL_PAGE = `#graphql
  mutation UndoPage($id: ID!) {
    pageDelete(id: $id) {
      deletedPageId
      userErrors { field message }
    }
  }`;
const M_DEL_ARTICLE = `#graphql
  mutation UndoArticle($id: ID!) {
    articleDelete(id: $id) {
      deletedArticleId
      userErrors { field message }
    }
  }`;
const M_DEL_FILE = `#graphql
  mutation UndoFile($fileIds: [ID!]!) {
    fileDelete(fileIds: $fileIds) {
      deletedFileIds
      userErrors { field message }
    }
  }`;
const M_DEL_METAOBJECT = `#graphql
  mutation UndoMetaobject($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors { field message }
    }
  }`;
const M_DEL_CUSTOMER = `#graphql
  mutation UndoCustomer($input: CustomerDeleteInput!) {
    customerDelete(input: $input) {
      deletedCustomerId
      userErrors { field message }
    }
  }`;
const M_DEL_ORDER = `#graphql
  mutation UndoOrder($orderId: ID!) {
    orderDelete(orderId: $orderId) {
      deletedId
      userErrors { field message }
    }
  }`;
const M_DEL_DRAFT = `#graphql
  mutation UndoDraft($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }`;
const M_DEL_REDIRECT = `#graphql
  mutation UndoRedirect($id: ID!) {
    urlRedirectDelete(id: $id) {
      deletedUrlRedirectId
      userErrors { field message }
    }
  }`;
const M_DEL_MENU = `#graphql
  mutation UndoMenu($id: ID!) {
    menuDelete(id: $id) {
      deletedMenuId
      userErrors { field message }
    }
  }`;
const M_DEL_CODE_DISCOUNT = `#graphql
  mutation UndoCodeDiscount($id: ID!) {
    discountCodeDelete(id: $id) {
      deletedCodeDiscountId
      userErrors { field message }
    }
  }`;
const M_DEL_AUTO_DISCOUNT = `#graphql
  mutation UndoAutoDiscount($id: ID!) {
    discountAutomaticDelete(id: $id) {
      deletedAutomaticDiscountId
      userErrors { field message }
    }
  }`;

const byId = (id) => ({ id });
const byInputId = (id) => ({ input: { id } });
const fileDelete = [M_DEL_FILE, "fileDelete", (id) => ({ fileIds: [id] })];

// gid type → [mutation, payload root, variables]
const DELETERS = {
  Product: [M_DEL_PRODUCT, "productDelete", byInputId],
  Collection: [M_DEL_COLLECTION, "collectionDelete", byInputId],
  Page: [M_DEL_PAGE, "pageDelete", byId],
  Article: [M_DEL_ARTICLE, "articleDelete", byId],
  MediaImage: fileDelete,
  GenericFile: fileDelete,
  Video: fileDelete,
  Metaobject: [M_DEL_METAOBJECT, "metaobjectDelete", byId],
  Customer: [M_DEL_CUSTOMER, "customerDelete", byInputId],
  Order: [M_DEL_ORDER, "orderDelete", (orderId) => ({ orderId })],
  DraftOrder: [M_DEL_DRAFT, "draftOrderDelete", byInputId],
  UrlRedirect: [M_DEL_REDIRECT, "urlRedirectDelete", byId],
  Menu: [M_DEL_MENU, "menuDelete", byId],
  DiscountCodeNode: [M_DEL_CODE_DISCOUNT, "discountCodeDelete", byId],
  DiscountAutomaticNode: [M_DEL_AUTO_DISCOUNT, "discountAutomaticDelete", byId],
};

export const gidType = (gid) => /^gid:\/\/shopify\/([^/]+)\//.exec(String(gid))?.[1] || "";

// The merchant or another app may already have removed the item, which is the
// outcome undo wants, so it counts as done rather than as a failure.
const GONE = /not found|does not exist|doesn't exist|can't be found|no longer exists|invalid id/i;

// → { ok: true } or { ok: false, error }
export async function deleteCreatedItem(admin, gid) {
  const spec = DELETERS[gidType(gid)];
  if (!spec) return { ok: false, error: "this kind of item can't be undone" };
  const [mutation, root, variables] = spec;
  try {
    const data = await gql(admin, mutation, variables(gid));
    const errs = data?.[root]?.userErrors || [];
    const text = errs.map((e) => e.message).join("; ");
    return !errs.length || GONE.test(text) ? { ok: true } : { ok: false, error: text };
  } catch (err) {
    const text = String(err?.message || err).slice(0, 160);
    return GONE.test(text) ? { ok: true } : { ok: false, error: text };
  }
}

// Newest first: a menu or order created late in a run can point at an item
// created earlier, so it goes before what it points at.
function undoOrder(items) {
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}

// Ids are only useful while undo is offered.
export async function purgeExpiredItems(shop) {
  await db.jobCreatedItem.deleteMany({
    where: { shop, createdAt: { lt: new Date(Date.now() - UNDO_MS) } },
  });
}

// { jobId: items still undoable } for the given shop's jobs
export async function undoableCounts(shop, jobIds) {
  const rows = await db.jobCreatedItem.groupBy({
    by: ["jobId"],
    where: { shop, jobId: { in: jobIds } },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.jobId, r._count._all]));
}

// Returns { jobId } or { error }. The error strings are shown through t().
export async function startUndoJob(shop, jobId) {
  const target = await db.migrationJob.findFirst({ where: { id: jobId, shop } });
  if (!target) return { error: "This run can't be undone." };
  if (target.mode === "undo" || target.status === "running") {
    return { error: "This run can't be undone." };
  }
  if (Date.now() - target.createdAt.getTime() > UNDO_MS) {
    return { error: "Undo is only available for 30 days after a run." };
  }
  const items = await db.jobCreatedItem.count({ where: { jobId, shop } });
  if (!items) return { error: "This run has nothing left to undo." };

  let job;
  try {
    job = await db.migrationJob.create({
      data: {
        shop,
        sourceShop: target.sourceShop,
        targetShop: shop,
        mode: "undo",
        dataTypes: "",
        status: "running",
        startedAt: new Date(),
        undoOfJobId: jobId,
      },
    });
  } catch (err) {
    // the one-running-job-per-shop index
    if (err?.code === "P2002") {
      return { error: "A migration or sync is already running for this store. Wait for it to finish (see History)." };
    }
    throw err;
  }

  runUndo(job.id, jobId, shop).catch((err) => {
    console.error(`Undo job ${job.id} crashed:`, err);
  });
  return { jobId: job.id };
}

async function runUndo(undoJobId, targetJobId, shop) {
  const logs = [];
  const log = (msg) =>
    logs.push(`[${new Date().toISOString().slice(11, 19)}] ${redactPII(msg)}`);
  let removed = 0;
  let failed = 0;
  let stopped = false;

  try {
    const { admin } = await unauthenticated.admin(shop);
    const items = undoOrder(
      await db.jobCreatedItem.findMany({ where: { jobId: targetJobId, shop } }),
    );
    log(`Removing ${items.length} item(s) this run created…`);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (i % 10 === 0) {
        const current = await db.migrationJob.findUnique({
          where: { id: undoJobId },
          select: { cancelRequested: true },
        });
        if (current?.cancelRequested) {
          stopped = true;
          break;
        }
        await db.migrationJob.updateMany({
          where: { id: undoJobId, status: "running" },
          data: { logJson: safeLogsJson(logs) },
        });
      }
      const label = `${gidType(item.gid)} ${item.gid.split("/").pop()}`;
      const result = await deleteCreatedItem(admin, item.gid);
      if (result.ok) {
        removed++;
        await db.jobCreatedItem.delete({ where: { id: item.id } }).catch(() => {});
        log(`✓ Removed ${label}`);
      } else {
        failed++;
        log(`✕ Kept ${label} — ${result.error}`);
      }
      await sleep(150);
    }

    if (stopped) log("Stopped — items not removed yet can still be undone.");
    await db.migrationJob.update({
      where: { id: undoJobId },
      data: {
        status: stopped ? "stopped" : failed ? "partial" : "completed",
        itemCount: removed + failed,
        failedCount: failed,
        summary: `${removed} removed · ${failed} could not be removed`,
        logJson: safeLogsJson(logs),
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    await db.migrationJob
      .update({
        where: { id: undoJobId },
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
