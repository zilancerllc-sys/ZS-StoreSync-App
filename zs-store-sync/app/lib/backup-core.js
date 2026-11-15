// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — backup before sync: snapshots, diffs, restore inputs
//
//  A sync overwrites items that already exist on this store. Before it does, the
//  fields it is about to write are read from this store and kept (compressed)
//  for 30 days, so the run can be put back with one click. Pure apart from
//  zlib; the database side is backup.server.js.
//
//  Only what a sync writes is kept, and only when it would actually change:
//    product    title, handle, description, vendor, type, tags, status,
//               template, SEO, the metafields the sync writes, and every
//               variant's price, compare-at, SKU, barcode, weight
//    collection title, handle, description, template, SEO, image, the
//               metafields the sync writes, smart-collection rules
//    page       title, handle, body, published, template, the metafields the
//               sync writes
// ═════════════════════════════════════════════════════════════════════════════
import { Buffer } from "node:buffer";
import { deflateSync, inflateSync } from "node:zlib";

export const BACKUP_DAYS = 30;
export const BACKUP_MAX_ROWS_PER_SHOP = 20000;

export function encodeSnapshot(obj) {
  return deflateSync(Buffer.from(JSON.stringify(obj), "utf8"));
}

export function decodeSnapshot(buf) {
  return JSON.parse(inflateSync(Buffer.from(buf)).toString("utf8"));
}

const mfKey = (m) => `${m.namespace}.${m.key}`;

// metafields the sync is about to write → current values on this store.
// A key that isn't set on this store is recorded as absent, so restore can
// remove the value the sync added.
export function metafieldBefore(written = [], current = []) {
  const cur = new Map((current || []).map((m) => [mfKey(m), m]));
  return (written || []).map((m) => {
    const c = cur.get(mfKey(m));
    return c
      ? { namespace: m.namespace, key: m.key, type: c.type || m.type, value: c.value }
      : { namespace: m.namespace, key: m.key, absent: true };
  });
}

function metafieldsDiffer(written = [], before = []) {
  const b = new Map(before.map((m) => [mfKey(m), m]));
  return written.some((m) => {
    const was = b.get(mfKey(m));
    return !was || was.absent || String(was.value) !== String(m.value);
  });
}

const norm = (v) => (v == null ? "" : String(v));
const sortedTags = (t) => [...(t || [])].map(String).sort().join("\u0001");
const money = (v) => (v == null || v === "" ? "" : Number(v).toFixed(2));

// target product (as read by Q_BACKUP_PRODUCT) + metafields the sync writes
export function productSnapshot(tp, writtenMetafields) {
  return {
    title: tp.title,
    handle: tp.handle,
    descriptionHtml: tp.descriptionHtml,
    vendor: tp.vendor,
    productType: tp.productType,
    tags: tp.tags || [],
    status: tp.status,
    templateSuffix: tp.templateSuffix || null,
    seo: { title: tp.seo?.title || null, description: tp.seo?.description || null },
    metafields: metafieldBefore(writtenMetafields, (tp.metafields?.edges || []).map((e) => e.node)),
    variants: (tp.variants?.edges || []).map(({ node: v }) => ({
      id: v.id,
      price: v.price,
      compareAtPrice: v.compareAtPrice ?? null,
      sku: v.sku || "",
      barcode: v.barcode || "",
      weight: v.inventoryItem?.measurement?.weight || null,
    })),
  };
}

// Would the sync change anything? `input` is the productUpdate input, and
// `variantFields` the price/SKU/barcode each source variant will be written
// with (after price rules). Over-reporting only costs a little storage;
// under-reporting would lose a backup, so any doubt counts as a change.
export function productWouldChange(snap, input, variantFields = []) {
  const coreFields = ["title", "handle", "descriptionHtml", "vendor", "productType", "status"];
  for (const f of coreFields) {
    if (input[f] !== undefined && norm(input[f]) !== norm(snap[f])) return true;
  }
  if (input.templateSuffix !== undefined && norm(input.templateSuffix) !== norm(snap.templateSuffix)) return true;
  if (input.tags !== undefined && sortedTags(input.tags) !== sortedTags(snap.tags)) return true;
  if (input.seo) {
    if (input.seo.title !== undefined && norm(input.seo.title) !== norm(snap.seo?.title)) return true;
    if (input.seo.description !== undefined && norm(input.seo.description) !== norm(snap.seo?.description)) return true;
  }
  if (metafieldsDiffer(input.metafields, snap.metafields)) return true;

  if (variantFields.length !== snap.variants.length) return true;
  const have = new Set(
    snap.variants.map((v) => [money(v.price), money(v.compareAtPrice), norm(v.sku), norm(v.barcode)].join("|")),
  );
  for (const f of variantFields) {
    const key = [
      f.price === undefined ? null : money(f.price),
      f.compareAtPrice === undefined ? null : money(f.compareAtPrice),
      norm(f.sku),
      norm(f.barcode),
    ];
    // a field the sync won't send can't change: match it against anything
    const hit = [...have].some((h) => {
      const p = h.split("|");
      return key.every((k, i) => k === null || k === p[i]);
    });
    if (!hit) return true;
  }
  return false;
}

export function collectionSnapshot(tc, writtenMetafields) {
  return {
    title: tc.title,
    handle: tc.handle,
    descriptionHtml: tc.descriptionHtml,
    templateSuffix: tc.templateSuffix || null,
    seo: { title: tc.seo?.title || null, description: tc.seo?.description || null },
    image: tc.image?.url ? { src: tc.image.url, altText: tc.image.altText || "" } : null,
    ruleSet: tc.ruleSet || null,
    metafields: metafieldBefore(writtenMetafields, (tc.metafields?.edges || []).map((e) => e.node)),
  };
}

export function collectionWouldChange(snap, input, newRuleSet) {
  for (const f of ["title", "handle", "descriptionHtml"]) {
    if (input[f] !== undefined && norm(input[f]) !== norm(snap[f])) return true;
  }
  if (norm(input.templateSuffix) !== norm(snap.templateSuffix)) return true;
  if (input.seo) {
    if (norm(input.seo.title) !== norm(snap.seo?.title)) return true;
    if (norm(input.seo.description) !== norm(snap.seo?.description)) return true;
  }
  // an image is re-sent on every sync; compare by file name, the CDN url's
  // query string changes
  const file = (u) => norm(u).split("?")[0].split("/").pop();
  if (input.image && file(input.image.src) !== file(snap.image?.src)) return true;
  if (metafieldsDiffer(input.metafields, snap.metafields)) return true;
  if (newRuleSet && JSON.stringify(newRuleSet.rules || []) !== JSON.stringify(snap.ruleSet?.rules || [])) return true;
  return false;
}

export function pageSnapshot(tp, writtenMetafields) {
  return {
    title: tp.title,
    handle: tp.handle,
    body: tp.body,
    isPublished: !!tp.isPublished,
    templateSuffix: tp.templateSuffix || null,
    metafields: metafieldBefore(writtenMetafields, (tp.metafields?.edges || []).map((e) => e.node)),
  };
}

export function pageWouldChange(snap, input) {
  for (const f of ["title", "handle", "body"]) {
    if (input[f] !== undefined && norm(input[f]) !== norm(snap[f])) return true;
  }
  if (input.isPublished !== undefined && !!input.isPublished !== snap.isPublished) return true;
  if (norm(input.templateSuffix) !== norm(snap.templateSuffix)) return true;
  return metafieldsDiffer(input.metafields, snap.metafields);
}

// Metafields to put back: values that existed are set again, keys the sync
// added are removed.
export function metafieldRestore(ownerId, before = []) {
  const set = [];
  const remove = [];
  for (const m of before) {
    if (m.absent) remove.push({ ownerId, namespace: m.namespace, key: m.key });
    else set.push({ ownerId, namespace: m.namespace, key: m.key, type: m.type, value: m.value });
  }
  return { set, remove };
}

// → inputs for productUpdate, productVariantsBulkUpdate and the metafields
export function productRestoreInputs(gid, snap, currentVariantIds = null) {
  const product = {
    id: gid,
    title: snap.title,
    handle: snap.handle,
    descriptionHtml: snap.descriptionHtml,
    vendor: snap.vendor,
    productType: snap.productType,
    tags: snap.tags,
    status: snap.status,
    templateSuffix: snap.templateSuffix,
    seo: { title: snap.seo?.title || "", description: snap.seo?.description || "" },
  };
  const alive = currentVariantIds ? new Set(currentVariantIds) : null;
  const variants = snap.variants
    .filter((v) => !alive || alive.has(v.id))
    .map((v) => {
      const out = {
        id: v.id,
        price: v.price,
        compareAtPrice: v.compareAtPrice ?? null,
        barcode: v.barcode || null,
        inventoryItem: { sku: v.sku || null },
      };
      if (v.weight?.value != null) {
        out.inventoryItem.measurement = { weight: { value: v.weight.value, unit: v.weight.unit } };
      }
      return out;
    });
  return { product, variants, metafields: metafieldRestore(gid, snap.metafields) };
}

export function collectionRestoreInput(gid, snap) {
  const collection = {
    id: gid,
    title: snap.title,
    handle: snap.handle,
    descriptionHtml: snap.descriptionHtml,
    templateSuffix: snap.templateSuffix,
    seo: { title: snap.seo?.title || "", description: snap.seo?.description || "" },
  };
  if (snap.image?.src) collection.image = { src: snap.image.src, altText: snap.image.altText || "" };
  return { collection, metafields: metafieldRestore(gid, snap.metafields) };
}

export function pageRestoreInput(gid, snap) {
  return {
    id: gid,
    page: {
      title: snap.title,
      handle: snap.handle,
      body: snap.body,
      isPublished: snap.isPublished,
      templateSuffix: snap.templateSuffix,
    },
    metafields: metafieldRestore(gid, snap.metafields),
  };
}
