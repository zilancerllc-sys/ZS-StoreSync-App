// ─────────────────────────────────────────────────────────────────────────────
//  ZS StoreSync — Migration engine
//
//  Pulls data from a SOURCE Shopify store and creates/updates it in a TARGET
//  store. Nothing is persisted on our servers (pass-through). Duplicates are
//  detected by querying the target store live (by SKU / handle), so we don't
//  need to keep a mapping database.
//
//  Usage (from an action):
//    import { unauthenticated } from "./shopify.server";
//    const { admin: source } = await unauthenticated.admin(sourceShop);
//    const { admin: target } = await unauthenticated.admin(targetShop);
//    const result = await runMigration({ source, target, types, mode, onLog });
// ─────────────────────────────────────────────────────────────────────────────

// ── GraphQL helper with basic throttle/retry handling ────────────────────────
async function gql(admin, query, variables = {}) {
  let attempt = 0;
  // simple retry loop for THROTTLED / transient errors
  for (;;) {
    attempt++;
    const res = await admin.graphql(query, { variables });
    const json = await res.json();

    const hasThrottledError = json?.errors?.some?.(
      (e) => e?.extensions?.code === "THROTTLED",
    );
    const lowBudget =
      json?.extensions?.cost?.throttleStatus?.currentlyAvailable < 50;

    if (hasThrottledError || lowBudget) {
      if (hasThrottledError && attempt >= 6) {
        // out of retries with no data — surface it instead of returning null
        throw new Error("GraphQL throttled: rate limit not recovering.");
      }
      if (attempt < 6) {
        // back off proportional to attempt
        await sleep(800 * attempt);
        if (hasThrottledError) continue;
      }
      // lowBudget with data present: fall through and return what we have
    }

    if (json?.errors) {
      throw new Error(
        "GraphQL error: " + JSON.stringify(json.errors).slice(0, 500),
      );
    }

    return json.data;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Quote a value for use in a Shopify search query (`sku:"..."`) so spaces,
// quotes and backslashes can't break the query or false-match other fields.
function qv(value) {
  return `"${String(value).replace(/[\\"]/g, "\\$&")}"`;
}

// ── Generic paginated fetch over a connection ────────────────────────────────
async function fetchAll(admin, query, rootKey, variables = {}, onPage) {
  let cursor = null;
  const all = [];
  do {
    const data = await gql(admin, query, { ...variables, cursor });
    const conn = data?.[rootKey];
    const edges = conn?.edges ?? [];
    for (const e of edges) all.push(e.node);
    if (onPage) await onPage(all.length);
    cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    if (cursor) await sleep(250); // gentle pacing
  } while (cursor);
  return all;
}

// ═════════════════════════════════════════════════════════════════════════════
//  PRODUCTS
// ═════════════════════════════════════════════════════════════════════════════
const Q_PRODUCTS = `#graphql
  query Products($cursor: String) {
    products(first: 25, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id title handle descriptionHtml vendor productType tags status templateSuffix
        isGiftCard requiresSellingPlan
        seo { title description }
        options { name values }
        variants(first: 100) {
          edges { node {
            sku title price compareAtPrice barcode
            inventoryQuantity
            inventoryItem { measurement { weight { value unit } } }
            selectedOptions { name value }
          } }
        }
        images(first: 50) { edges { node { src altText } } }
        metafields(first: 50) { edges { node { namespace key value type } } }
      } }
    }
  }`;

const Q_TARGET_PRODUCT_BY_HANDLE = `#graphql
  query ByHandle($handle: String!) {
    productByHandle(handle: $handle) { id handle }
  }`;

// look up a target product by the SKU of its first variant
const Q_TARGET_BY_SKU = `#graphql
  query BySku($q: String!) {
    products(first: 1, query: $q) { edges { node { id handle } } }
  }`;

const M_PRODUCT_CREATE = `#graphql
  mutation CreateProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product {
        id handle
        variants(first: 1) { edges { node { id } } }
      }
      userErrors { field message }
    }
  }`;

const M_PRODUCT_UPDATE = `#graphql
  mutation UpdateProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id handle }
      userErrors { field message }
    }
  }`;

// existing target variants, so a sync can match them to source variants by SKU
const Q_TARGET_PRODUCT_VARIANTS = `#graphql
  query TargetVariants($id: ID!) {
    product(id: $id) {
      variants(first: 100) { edges { node { id sku } } }
    }
  }`;

// ProductUpdateInput is NOT a superset of ProductCreateInput: `giftCard` and
// `productOptions` are create-only, and sending them makes productUpdate fail
// input coercion. Keep only the fields the update input actually accepts.
const PRODUCT_UPDATE_FIELDS = [
  "title",
  "handle",
  "descriptionHtml",
  "vendor",
  "productType",
  "tags",
  "status",
  "templateSuffix",
  "requiresSellingPlan",
  "seo",
  "metafields",
];

function productUpdateInput(product, id) {
  const out = { id };
  for (const k of PRODUCT_UPDATE_FIELDS) {
    if (product[k] !== undefined) out[k] = product[k];
  }
  return out;
}

const M_VARIANTS_BULK_CREATE = `#graphql
  mutation VariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
      productVariants { id }
      userErrors { field message }
    }
  }`;

const M_VARIANTS_BULK_UPDATE = `#graphql
  mutation VariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }`;

// does the source product have real options (vs the implicit Title/Default)?
function hasRealOptions(p) {
  const opts = p.options || [];
  if (opts.length === 0) return false;
  if (opts.length === 1 && opts[0]?.name === "Title") return false;
  return true;
}

// map a source variant to a ProductVariantsBulkInput
function variantBulkInput(v, withOptionValues) {
  const input = {
    price: v.price ?? undefined,
    compareAtPrice: v.compareAtPrice ?? undefined,
    barcode: v.barcode ?? undefined,
  };
  const invItem = {};
  if (v.sku) invItem.sku = v.sku;
  const w = v.inventoryItem?.measurement?.weight;
  if (w?.value != null)
    invItem.measurement = { weight: { value: w.value, unit: w.unit } };
  if (Object.keys(invItem).length) input.inventoryItem = invItem;
  if (withOptionValues) {
    input.optionValues = (v.selectedOptions || []).map((so) => ({
      optionName: so.name,
      name: so.value,
    }));
  }
  return input;
}

// Sync mode: push price / compare-at / barcode / weight onto the variants that
// already exist on the target, matched by SKU. Variants without a SKU can't be
// matched across stores, and variants missing on the target are left alone (we
// never create or delete variants during a sync).
async function syncVariants(ctx, targetProductId, sourceProduct) {
  const { target, onLog } = ctx;
  const sourceVariants = (sourceProduct.variants?.edges || []).map(
    (e) => e.node,
  );
  const bySku = new Map();
  for (const v of sourceVariants) {
    const sku = v.sku?.trim();
    if (sku) bySku.set(sku, v);
  }
  if (!bySku.size) return;

  try {
    const td = await gql(target, Q_TARGET_PRODUCT_VARIANTS, {
      id: targetProductId,
    });
    const updates = [];
    for (const e of td?.product?.variants?.edges || []) {
      const tv = e.node;
      const sku = tv.sku?.trim();
      const sv = sku ? bySku.get(sku) : null;
      if (sv) updates.push({ id: tv.id, ...variantBulkInput(sv, false) });
    }
    if (!updates.length) return;

    const vdata = await gql(target, M_VARIANTS_BULK_UPDATE, {
      productId: targetProductId,
      variants: updates,
    });
    const verrs = vdata?.productVariantsBulkUpdate?.userErrors;
    if (verrs?.length) {
      onLog(`  ⚠ Variant sync partial for ${sourceProduct.title} — ${verrs[0].message}`);
    } else {
      onLog(`  ↻ ${updates.length} variant(s) synced`);
    }
  } catch (err) {
    onLog(
      `  ⚠ Variant sync failed for ${sourceProduct.title} — ${String(err.message).slice(0, 100)}`,
    );
  }
  await sleep(200);
}

async function migrateProducts(ctx) {
  const { source, target, onLog, counters, consume } = ctx;

  const products = await fetchAll(
    source,
    Q_PRODUCTS,
    "products",
    {},
    async (n) => onLog(`Fetched ${n} products from source…`),
  );
  onLog(`Total ${products.length} products found. Importing…`);

  for (const p of products) {
    if (ctx.stopOnQuota()) {
      onLog("Quota reached — stopping product import.");
      break;
    }

    const firstSku = p.variants?.edges?.[0]?.node?.sku?.trim();

    // duplicate detection: by SKU first, then handle
    let existing = null;
    if (firstSku) {
      const r = await gql(target, Q_TARGET_BY_SKU, {
        q: `sku:${qv(firstSku)}`,
      });
      existing = r?.products?.edges?.[0]?.node ?? null;
    }
    if (!existing && p.handle) {
      const r = await gql(target, Q_TARGET_PRODUCT_BY_HANDLE, {
        handle: p.handle,
      });
      existing = r?.productByHandle ?? null;
    }

    const realOptions = hasRealOptions(p);
    const product = {
      title: p.title,
      handle: p.handle,
      descriptionHtml: p.descriptionHtml,
      vendor: p.vendor,
      productType: p.productType,
      tags: p.tags,
      status: p.status || "ACTIVE",
      templateSuffix: p.templateSuffix || null,
      giftCard: !!p.isGiftCard,
      requiresSellingPlan: !!p.requiresSellingPlan,
      seo:
        p.seo && (p.seo.title || p.seo.description)
          ? {
              title: p.seo.title || undefined,
              description: p.seo.description || undefined,
            }
          : undefined,
      metafields: metafieldsInput(p),
    };
    if (realOptions) {
      product.productOptions = (p.options || []).map((o) => ({
        name: o.name,
        values: (o.values || []).map((v) => ({ name: v })),
      }));
    }

    const media = (p.images?.edges || []).map((e) => ({
      originalSource: e.node.src,
      alt: e.node.altText || "",
      mediaContentType: "IMAGE",
    }));

    // EXISTING item: sync mode updates it (overwrite), migrate mode skips it.
    if (existing) {
      if (ctx.mode !== "sync") {
        counters.skipped++;
        onLog(`↪︎ Skipped (exists): ${p.title}`);
        continue;
      }
      try {
        const upd = await gql(target, M_PRODUCT_UPDATE, {
          product: productUpdateInput(product, existing.id),
        });
        const uerrs = upd?.productUpdate?.userErrors;
        if (uerrs?.length) {
          counters.failed++;
          onLog(`✕ Update failed: ${p.title} — ${uerrs[0].message}`);
        } else {
          counters.updated++;
          onLog(`↻ Updated: ${p.title}`);
          await syncVariants(ctx, existing.id, p);
        }
      } catch (err) {
        counters.failed++;
        onLog(
          `✕ Update error: ${p.title} — ${String(err.message).slice(0, 120)}`,
        );
      }
      await sleep(200);
      continue;
    }

    if (!ctx.canCreate()) {
      counters.skipped++;
      onLog(`↪︎ Skipped (quota reached, not created): ${p.title}`);
      continue;
    }

    try {
      const data = await gql(target, M_PRODUCT_CREATE, { product, media });
      const errs = data?.productCreate?.userErrors;
      if (errs && errs.length) {
        counters.failed++;
        onLog(`✕ Failed: ${p.title} — ${errs[0].message}`);
        await sleep(200);
        continue;
      }

      const newProduct = data?.productCreate?.product;
      const sourceVariants = (p.variants?.edges || []).map((e) => e.node);

      // recreate variants with price / SKU / barcode (inventory levels are
      // per-location and can't be mapped across stores — logged as skipped)
      if (newProduct?.id && sourceVariants.length) {
        try {
          if (realOptions) {
            const vdata = await gql(target, M_VARIANTS_BULK_CREATE, {
              productId: newProduct.id,
              variants: sourceVariants.map((v) => variantBulkInput(v, true)),
              strategy: "REMOVE_STANDALONE_VARIANT",
            });
            const verrs = vdata?.productVariantsBulkCreate?.userErrors;
            if (verrs?.length) {
              onLog(
                `  ⚠ Variants partial for ${p.title} — ${verrs[0].message}`,
              );
            }
          } else {
            // single default variant: update it in place with price / SKU
            const defaultVariantId = newProduct.variants?.edges?.[0]?.node?.id;
            if (defaultVariantId) {
              const vdata = await gql(target, M_VARIANTS_BULK_UPDATE, {
                productId: newProduct.id,
                variants: [
                  {
                    id: defaultVariantId,
                    ...variantBulkInput(sourceVariants[0], false),
                  },
                ],
              });
              const verrs = vdata?.productVariantsBulkUpdate?.userErrors;
              if (verrs?.length) {
                onLog(
                  `  ⚠ Variant update failed for ${p.title} — ${verrs[0].message}`,
                );
              }
            }
          }
        } catch (verr) {
          onLog(
            `  ⚠ Variants failed for ${p.title} — ${String(verr.message).slice(0, 100)}`,
          );
        }
      }

      counters.created++;
      consume();
      onLog(
        `✓ Created: ${p.title} (${sourceVariants.length} variant${sourceVariants.length === 1 ? "" : "s"})`,
      );
    } catch (err) {
      counters.failed++;
      onLog(`✕ Error: ${p.title} — ${String(err.message).slice(0, 120)}`);
    }

    await sleep(200); // pace writes
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  COLLECTIONS (custom / manual)
// ═════════════════════════════════════════════════════════════════════════════
const Q_COLLECTIONS = `#graphql
  query Collections($cursor: String) {
    collections(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id title handle descriptionHtml templateSuffix
        seo { title description }
        metafields(first: 50) { edges { node { namespace key value type } } }
        image { src altText }
        ruleSet { appliedDisjunctively rules { column relation condition } }
      } }
    }
  }`;

const Q_TARGET_COLLECTION_BY_HANDLE = `#graphql
  query ColByHandle($handle: String!) {
    collectionByHandle(handle: $handle) { id }
  }`;

const M_COLLECTION_CREATE = `#graphql
  mutation CreateCollection($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id handle }
      userErrors { field message }
    }
  }`;

// #7 — manual collection membership (matched by product handle across stores)
const Q_COLLECTION_PRODUCTS = `#graphql
  query ColProducts($id: ID!, $cursor: String) {
    collection(id: $id) {
      products(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges { node { handle } }
      }
    }
  }`;

const Q_TARGET_PRODUCT_ID_BY_HANDLE = `#graphql
  query TPByHandle($handle: String!) {
    productByHandle(handle: $handle) { id }
  }`;

const M_COLLECTION_ADD_PRODUCTS = `#graphql
  mutation AddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection { id }
      userErrors { field message }
    }
  }`;

const M_COLLECTION_UPDATE = `#graphql
  mutation UpdateCollection($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id handle }
      userErrors { field message }
    }
  }`;

// #7 — copy a manual collection's product membership, matching products by
// handle across stores. Additive: products already in the target collection are
// left in place (collectionAddProducts never removes), so this is safe to re-run.
async function linkCollectionProducts(ctx, collectionId, sourceCollection) {
  const { source, target, onLog } = ctx;

  let cur = null;
  const handles = [];
  do {
    const pd = await gql(source, Q_COLLECTION_PRODUCTS, {
      id: sourceCollection.id,
      cursor: cur,
    });
    const conn = pd?.collection?.products;
    for (const e of conn?.edges ?? []) handles.push(e.node.handle);
    cur = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    if (cur) await sleep(250);
  } while (cur);

  const ids = [];
  for (const h of handles) {
    try {
      const tp = await gql(target, Q_TARGET_PRODUCT_ID_BY_HANDLE, {
        handle: h,
      });
      if (tp?.productByHandle?.id) ids.push(tp.productByHandle.id);
    } catch {
      /* product not on target — skip */
    }
  }

  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    if (!batch.length) continue;
    try {
      await gql(target, M_COLLECTION_ADD_PRODUCTS, {
        id: collectionId,
        productIds: batch,
      });
    } catch {
      onLog(`  ⚠ Could not add some products to ${sourceCollection.title}`);
    }
    await sleep(200);
  }
  if (handles.length) {
    onLog(
      `  → linked ${ids.length}/${handles.length} products to ${sourceCollection.title}`,
    );
  }
}

async function migrateCollections(ctx) {
  const { source, target, onLog, counters, consume } = ctx;
  const cols = await fetchAll(source, Q_COLLECTIONS, "collections", {}, (n) =>
    onLog(`Fetched ${n} collections…`),
  );
  onLog(`Total ${cols.length} collections found. Importing…`);

  for (const c of cols) {
    if (ctx.stopOnQuota()) {
      onLog("Quota reached — stopping collections.");
      break;
    }
    const r = await gql(target, Q_TARGET_COLLECTION_BY_HANDLE, {
      handle: c.handle,
    });
    const existingCol = r?.collectionByHandle || null;

    const input = {
      title: c.title,
      handle: c.handle,
      descriptionHtml: c.descriptionHtml,
      templateSuffix: c.templateSuffix || null,
      seo:
        c.seo && (c.seo.title || c.seo.description)
          ? {
              title: c.seo.title || undefined,
              description: c.seo.description || undefined,
            }
          : undefined,
      metafields: metafieldsInput(c),
    };
    if (c.ruleSet) {
      input.ruleSet = {
        appliedDisjunctively: c.ruleSet.appliedDisjunctively,
        rules: c.ruleSet.rules.map((rule) => ({
          column: rule.column,
          relation: rule.relation,
          condition: rule.condition,
        })),
      };
    }
    if (c.image?.src) {
      input.image = { src: c.image.src, altText: c.image.altText || "" };
    }

    // EXISTING collection: sync updates it, migrate skips it.
    if (existingCol) {
      if (ctx.mode !== "sync") {
        counters.skipped++;
        onLog(`↪︎ Skipped (exists): ${c.title}`);
        continue;
      }
      try {
        const upd = await gql(target, M_COLLECTION_UPDATE, {
          input: { ...input, id: existingCol.id },
        });
        const uerrs = upd?.collectionUpdate?.userErrors;
        if (uerrs?.length) {
          counters.failed++;
          onLog(`✕ Update failed: ${c.title} — ${uerrs[0].message}`);
        } else {
          counters.updated++;
          onLog(`↻ Updated: ${c.title}`);
          if (!c.ruleSet) {
            await linkCollectionProducts(ctx, existingCol.id, c);
          }
        }
      } catch (err) {
        counters.failed++;
        onLog(
          `✕ Update error: ${c.title} — ${String(err.message).slice(0, 120)}`,
        );
      }
      await sleep(180);
      continue;
    }

    if (!ctx.canCreate()) {
      counters.skipped++;
      onLog(`↪︎ Skipped (quota reached, not created): ${c.title}`);
      continue;
    }

    try {
      const data = await gql(target, M_COLLECTION_CREATE, { input });
      const errs = data?.collectionCreate?.userErrors;
      if (errs?.length) {
        counters.failed++;
        onLog(`✕ Failed: ${c.title} — ${errs[0].message}`);
      } else {
        counters.created++;
        consume();
        onLog(`✓ Created: ${c.title}`);

        // #7 — manual collection: copy product membership by handle
        const newCollectionId = data?.collectionCreate?.collection?.id || null;
        if (!c.ruleSet && newCollectionId) {
          await linkCollectionProducts(ctx, newCollectionId, c);
        }
      }
    } catch (err) {
      counters.failed++;
      onLog(`✕ Error: ${c.title} — ${String(err.message).slice(0, 120)}`);
    }
    await sleep(180);
  }
}

// Metafields we can safely recreate on the target, preserving the exact
// namespace/key/value/type. Two kinds are dropped:
//   • app-reserved namespaces ("app", "app--…") — only the owning app may write
//     them, so the target would reject the whole payload;
//   • *_reference types — their values are gids pointing at SOURCE-store
//     resources, which would be broken references on the target.
// Everything else passes through, including the reserved SEO keys
// global.title_tag / global.description_tag. That is how Page and Article SEO
// migrates at all: neither type has an `seo` field in the Admin API.
function metafieldsInput(node) {
  return (node?.metafields?.edges || [])
    .map((e) => e.node)
    .filter(
      (m) =>
        m.namespace !== "app" &&
        !String(m.namespace || "").startsWith("app--") &&
        !/_reference$/.test(m.type || ""),
    )
    .map((m) => ({
      namespace: m.namespace,
      key: m.key,
      value: m.value,
      type: m.type,
    }));
}

// ═════════════════════════════════════════════════════════════════════════════
//  PAGES
// ═════════════════════════════════════════════════════════════════════════════
const Q_PAGES = `#graphql
  query Pages($cursor: String) {
    pages(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id title handle body isPublished publishedAt templateSuffix
        metafields(first: 50) { edges { node { namespace key value type } } }
      } }
    }
  }`;

const M_PAGE_CREATE = `#graphql
  mutation CreatePage($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page { id handle }
      userErrors { field message }
    }
  }`;

const M_PAGE_UPDATE = `#graphql
  mutation UpdatePage($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page { id handle }
      userErrors { field message }
    }
  }`;

const Q_TARGET_PAGES_ALL = `#graphql
  query TargetPages($cursor: String) {
    pages(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id handle } }
    }
  }`;

async function migratePages(ctx) {
  const { source, target, onLog, counters, consume } = ctx;
  const pages = await fetchAll(source, Q_PAGES, "pages", {}, (n) =>
    onLog(`Fetched ${n} pages…`),
  );
  onLog(`Total ${pages.length} pages found. Importing…`);

  // Build a handle → id map of EXISTING target pages (reliable exact match,
  // unlike the search `query:` filter which can miss on exact handles).
  const targetPageMap = {};
  {
    let cur = null;
    do {
      const td = await gql(target, Q_TARGET_PAGES_ALL, { cursor: cur });
      const conn = td?.pages;
      for (const e of conn?.edges ?? [])
        targetPageMap[e.node.handle] = e.node.id;
      cur = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
      if (cur) await sleep(200);
    } while (cur);
  }

  for (const pg of pages) {
    if (ctx.stopOnQuota()) {
      onLog("Quota reached — stopping pages.");
      break;
    }
    const pageMf = metafieldsInput(pg);
    const pageBody = {
      title: pg.title,
      handle: pg.handle,
      body: pg.body,
      isPublished: pg.isPublished,
      publishDate: pg.publishedAt || undefined,
      templateSuffix: pg.templateSuffix || null,
      ...(pageMf.length ? { metafields: pageMf } : {}),
    };

    // find existing page by exact handle (in-memory map)
    const existingPageId = targetPageMap[pg.handle] || null;

    if (existingPageId) {
      if (ctx.mode !== "sync") {
        counters.skipped++;
        onLog(`↪︎ Skipped (exists): ${pg.title}`);
        await sleep(160);
        continue;
      }
      try {
        const upd = await gql(target, M_PAGE_UPDATE, {
          id: existingPageId,
          page: pageBody,
        });
        const uerrs = upd?.pageUpdate?.userErrors;
        if (uerrs?.length) {
          counters.failed++;
          onLog(`✕ Update failed: ${pg.title} — ${uerrs[0].message}`);
        } else {
          counters.updated++;
          onLog(`↻ Updated: ${pg.title}`);
        }
      } catch (err) {
        counters.failed++;
        onLog(
          `✕ Update error: ${pg.title} — ${String(err.message).slice(0, 120)}`,
        );
      }
      await sleep(160);
      continue;
    }

    if (!ctx.canCreate()) {
      counters.skipped++;
      onLog(`↪︎ Skipped (quota reached, not created): ${pg.title}`);
      continue;
    }

    try {
      const data = await gql(target, M_PAGE_CREATE, { page: pageBody });
      const errs = data?.pageCreate?.userErrors;
      if (errs?.length) {
        counters.skipped++;
        onLog(`↪︎ Skipped: ${pg.title} — ${errs[0].message}`);
      } else {
        counters.created++;
        consume();
        onLog(`✓ Created: ${pg.title}`);
      }
    } catch (err) {
      counters.failed++;
      onLog(`✕ Error: ${pg.title} — ${String(err.message).slice(0, 120)}`);
    }
    await sleep(160);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  FILES (media library) — re-upload by original URL
// ═════════════════════════════════════════════════════════════════════════════
const Q_FILES = `#graphql
  query Files($cursor: String) {
    files(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        alt
        ... on MediaImage { id image { url } }
        ... on GenericFile { id url }
        ... on Video { id }
      } }
    }
  }`;

const M_FILE_CREATE = `#graphql
  mutation CreateFiles($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id }
      userErrors { field message }
    }
  }`;

// Shopify exposes no filename on File, so dedupe on the CDN url's basename
// ("…/files/hero.jpg?v=1" → "hero.jpg"), which Shopify preserves on re-upload.
function fileKeyFromUrl(url) {
  try {
    return new URL(url).pathname.split("/").pop() || null;
  } catch {
    return String(url).split("?")[0].split("/").pop() || null;
  }
}

async function migrateFiles(ctx) {
  const { source, target, onLog, counters, hasQuota, consume } = ctx;
  const files = await fetchAll(source, Q_FILES, "files", {}, (n) =>
    onLog(`Fetched ${n} files…`),
  );
  onLog(`Total ${files.length} files found. Importing…`);

  // existing target files, so a re-run doesn't duplicate the media library
  const existingKeys = new Set();
  try {
    const tfiles = await fetchAll(target, Q_FILES, "files");
    for (const tf of tfiles) {
      const k = fileKeyFromUrl(tf.image?.url || tf.url || "");
      if (k) existingKeys.add(k);
    }
    onLog(`${existingKeys.size} file(s) already on target.`);
  } catch {
    /* couldn't list target files — fall through and attempt every upload */
  }

  for (const f of files) {
    if (!hasQuota()) {
      onLog("Quota reached — stopping files.");
      break;
    }
    const url = f.image?.url || f.url;
    if (!url) {
      // videos and other media without a public URL can't be re-uploaded
      counters.skipped++;
      onLog("↪︎ Skipped file (no downloadable URL — e.g. hosted video)");
      continue;
    }
    const key = fileKeyFromUrl(url);
    if (key && existingKeys.has(key)) {
      counters.skipped++;
      onLog(`↪︎ Skipped (exists): ${key}`);
      continue;
    }
    try {
      const data = await gql(target, M_FILE_CREATE, {
        files: [
          {
            originalSource: url,
            alt: f.alt || "",
            contentType: f.image ? "IMAGE" : "FILE",
          },
        ],
      });
      const errs = data?.fileCreate?.userErrors;
      if (errs?.length) {
        counters.failed++;
        onLog(`✕ File failed — ${errs[0].message}`);
      } else {
        counters.created++;
        consume();
        if (key) existingKeys.add(key);
        onLog(`✓ File uploaded${key ? `: ${key}` : ""}`);
      }
    } catch (err) {
      counters.failed++;
      onLog(`✕ File error — ${String(err.message).slice(0, 120)}`);
    }
    await sleep(220);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  METAOBJECTS
// ═════════════════════════════════════════════════════════════════════════════
const Q_METAOBJECT_DEFS = `#graphql
  query Defs($cursor: String) {
    metaobjectDefinitions(first: 25, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id type name
        fieldDefinitions { key name type { name } required }
      } }
    }
  }`;

const Q_METAOBJECTS_BY_TYPE = `#graphql
  query Objs($type: String!, $cursor: String) {
    metaobjects(type: $type, first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id handle fields { key value } } }
    }
  }`;

const M_METAOBJECT_DEF_CREATE = `#graphql
  mutation DefCreate($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition { id type }
      userErrors { field message }
    }
  }`;

const M_METAOBJECT_CREATE = `#graphql
  mutation ObjCreate($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message }
    }
  }`;

// A metaobject field value references another store resource if it is a bare
// gid ("gid://…") or a JSON array of gids ('["gid://…", …]', as list-reference
// fields store them). Those gids don't map across stores, so the field is
// dropped instead of writing a broken reference.
function hasCrossStoreGid(value) {
  const s = String(value || "").trim();
  if (/^gid:\/\//.test(s)) return true;
  if (s.startsWith("[") && s.includes("gid://")) {
    try {
      const arr = JSON.parse(s);
      return (
        Array.isArray(arr) && arr.some((v) => /^gid:\/\//.test(String(v || "")))
      );
    } catch {
      return true; // looks like a gid array but won't parse — safest to drop
    }
  }
  return false;
}

async function migrateMetaobjects(ctx) {
  const { source, target, onLog, counters, hasQuota, consume } = ctx;
  const defs = await fetchAll(
    source,
    Q_METAOBJECT_DEFS,
    "metaobjectDefinitions",
    {},
    (n) => onLog(`Fetched ${n} metaobject definitions…`),
  );
  onLog(`Total ${defs.length} metaobject definitions found.`);

  for (const def of defs) {
    // create the definition on target ("taken" = already exists → fine)
    try {
      const ddata = await gql(target, M_METAOBJECT_DEF_CREATE, {
        definition: {
          type: def.type,
          name: def.name,
          fieldDefinitions: def.fieldDefinitions.map((fd) => ({
            key: fd.key,
            name: fd.name,
            type: fd.type.name,
            required: fd.required,
          })),
        },
      });
      const derrs = ddata?.metaobjectDefinitionCreate?.userErrors;
      if (derrs?.length) {
        const msg = derrs[0].message || "";
        if (/taken|exists|in use/i.test(msg)) {
          onLog(`↪︎ Definition exists: ${def.type}`);
        } else {
          onLog(`✕ Definition failed: ${def.type} — ${msg}`);
          continue; // entries would all fail without the definition
        }
      } else {
        onLog(`✓ Definition ready: ${def.type}`);
      }
    } catch (err) {
      onLog(
        `✕ Definition error: ${def.type} — ${String(err.message).slice(0, 100)}`,
      );
      continue;
    }

    // then copy entries
    const objs = await fetchAll(source, Q_METAOBJECTS_BY_TYPE, "metaobjects", {
      type: def.type,
    });
    for (const o of objs) {
      if (!hasQuota()) {
        onLog("Quota reached — stopping metaobjects.");
        return;
      }
      try {
        const data = await gql(target, M_METAOBJECT_CREATE, {
          metaobject: {
            type: def.type,
            handle: o.handle,
            fields: o.fields
              .filter((f) => !hasCrossStoreGid(f.value))
              .map((f) => ({ key: f.key, value: f.value })),
          },
        });
        const errs = data?.metaobjectCreate?.userErrors;
        if (errs?.length) {
          counters.skipped++;
        } else {
          counters.created++;
          consume();
        }
      } catch {
        counters.failed++;
      }
      await sleep(160);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  METAFIELD DEFINITIONS — copies definitions so migrated metafield VALUES show
//  up in the target admin (and validate) instead of being invisible orphans.
//  Covers every owner type this app migrates data for, not just products.
// ═════════════════════════════════════════════════════════════════════════════
const Q_METAFIELD_DEFS = `#graphql
  query MFDefs($ownerType: MetafieldOwnerType!, $cursor: String) {
    metafieldDefinitions(first: 50, ownerType: $ownerType, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id name namespace key description
        type { name }
        validations { name value }
      } }
    }
  }`;

// owner types worth copying — one per resource kind the migrator handles
const METAFIELD_OWNER_TYPES = [
  "PRODUCT",
  "PRODUCTVARIANT",
  "COLLECTION",
  "PAGE",
  "ARTICLE",
  "BLOG",
  "CUSTOMER",
  "ORDER",
  "DRAFTORDER",
];

const M_METAFIELD_DEF_CREATE = `#graphql
  mutation MFDefCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key }
      userErrors { field message }
    }
  }`;

async function migrateMetafields(ctx) {
  const { source, target, onLog, counters, hasQuota, consume } = ctx;

  for (const ownerType of METAFIELD_OWNER_TYPES) {
    if (!hasQuota()) {
      onLog("Quota reached — stopping metafields.");
      return;
    }

    let defs = [];
    try {
      defs = await fetchAll(source, Q_METAFIELD_DEFS, "metafieldDefinitions", {
        ownerType,
      });
    } catch (err) {
      // one unreadable owner type (missing scope, etc.) must not kill the rest
      onLog(`✕ ${ownerType} definitions — ${String(err.message).slice(0, 100)}`);
      continue;
    }

    // app-reserved namespaces can't be recreated, and reserved SEO keys already
    // have definitions on every store — attempting either is a guaranteed error
    const copyable = defs.filter(
      (d) =>
        d.namespace !== "app" &&
        !String(d.namespace || "").startsWith("app--") &&
        d.namespace !== "global",
    );
    if (!copyable.length) continue;
    onLog(`${copyable.length} ${ownerType} definition(s)…`);

    for (const d of copyable) {
      if (!hasQuota()) {
        onLog("Quota reached — stopping metafields.");
        return;
      }
      try {
        const data = await gql(target, M_METAFIELD_DEF_CREATE, {
          definition: {
            name: d.name,
            namespace: d.namespace,
            key: d.key,
            type: d.type.name,
            description: d.description || "",
            ownerType,
            validations: (d.validations || []).map((v) => ({
              name: v.name,
              value: v.value,
            })),
          },
        });
        const errs = data?.metafieldDefinitionCreate?.userErrors;
        if (errs?.length) {
          counters.skipped++;
          onLog(`↪︎ Exists: ${ownerType} ${d.namespace}.${d.key}`);
        } else {
          counters.created++;
          consume();
          onLog(`✓ Definition: ${ownerType} ${d.namespace}.${d.key}`);
        }
      } catch (err) {
        counters.failed++;
        onLog(
          `✕ ${ownerType} ${d.key} — ${String(err.message).slice(0, 100)}`,
        );
      }
      await sleep(140);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  CUSTOMERS
//  NOTE: requires Shopify Protected Customer Data approval + read_customers /
//  write_customers scopes. Until approval is granted the source query throws and
//  the module is skipped (logged), but the code below runs once access is live.
// ═════════════════════════════════════════════════════════════════════════════
const Q_CUSTOMERS = `#graphql
  query Customers($cursor: String) {
    customers(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id firstName lastName email phone note tags
        addresses {
          address1 address2 city provinceCode countryCodeV2 zip phone
          firstName lastName company
        }
      } }
    }
  }`;

const Q_TARGET_CUSTOMER_BY_EMAIL = `#graphql
  query CustomerByEmail($q: String!) {
    customers(first: 1, query: $q) { edges { node { id } } }
  }`;

const M_CUSTOMER_CREATE = `#graphql
  mutation CustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }`;

// map a source address to a MailingAddressInput
function mapAddress(a) {
  if (!a) return null;
  return {
    address1: a.address1 || undefined,
    address2: a.address2 || undefined,
    city: a.city || undefined,
    provinceCode: a.provinceCode || undefined,
    countryCode: a.countryCodeV2 || undefined,
    zip: a.zip || undefined,
    phone: a.phone || undefined,
    firstName: a.firstName || undefined,
    lastName: a.lastName || undefined,
    company: a.company || undefined,
  };
}

async function migrateCustomers(ctx) {
  const { source, target, onLog, counters, hasQuota, consume } = ctx;
  const customers = await fetchAll(source, Q_CUSTOMERS, "customers", {}, (n) =>
    onLog(`Fetched ${n} customers…`),
  );
  onLog(`Total ${customers.length} customers found. Importing…`);

  for (const c of customers) {
    if (!hasQuota()) {
      onLog("Quota reached — stopping customers.");
      break;
    }
    // duplicate detection by email
    if (c.email) {
      try {
        const r = await gql(target, Q_TARGET_CUSTOMER_BY_EMAIL, {
          q: `email:${qv(c.email)}`,
        });
        if (r?.customers?.edges?.length) {
          counters.skipped++;
          onLog(`↪︎ Skipped (exists): ${c.email}`);
          continue;
        }
      } catch {
        /* ignore lookup errors, attempt create */
      }
    }

    const input = {
      firstName: c.firstName || undefined,
      lastName: c.lastName || undefined,
      email: c.email || undefined,
      phone: c.phone || undefined,
      note: c.note || undefined,
      tags: c.tags || [],
    };
    const addresses = (c.addresses || []).map(mapAddress).filter(Boolean);
    if (addresses.length) input.addresses = addresses;

    try {
      const data = await gql(target, M_CUSTOMER_CREATE, { input });
      const errs = data?.customerCreate?.userErrors;
      if (errs?.length) {
        counters.skipped++;
        onLog(`↪︎ Skipped: ${c.email || c.id} — ${errs[0].message}`);
      } else {
        counters.created++;
        consume();
        onLog(`✓ Customer: ${c.email || `${c.firstName} ${c.lastName}`}`);
      }
    } catch (err) {
      counters.failed++;
      onLog(
        `✕ Customer error: ${c.email || c.id} — ${String(err.message).slice(0, 120)}`,
      );
    }
    await sleep(200);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  ORDERS
//  NOTE: requires Protected Customer Data approval + read_orders / write_orders.
//  read_orders only exposes the last 60 days; full history needs the separately
//  approved read_all_orders scope. Best-effort: recreates
//  orders with their line items (as titled custom items), addresses, note, tags
//  and financial status. Inventory is bypassed and no emails are sent.
// ═════════════════════════════════════════════════════════════════════════════
const Q_ORDERS = `#graphql
  query Orders($cursor: String) {
    orders(first: 25, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id name email note tags currencyCode displayFinancialStatus
        lineItems(first: 50) {
          edges { node {
            title quantity sku
            originalUnitPriceSet { shopMoney { amount currencyCode } }
          } }
        }
        shippingAddress {
          address1 address2 city provinceCode countryCodeV2 zip phone
          firstName lastName company
        }
        billingAddress {
          address1 address2 city provinceCode countryCodeV2 zip phone
          firstName lastName company
        }
      } }
    }
  }`;

const Q_TARGET_ORDER_BY_NAME = `#graphql
  query OrderByName($q: String!) {
    orders(first: 1, query: $q) { edges { node { id name } } }
  }`;

const M_ORDER_CREATE = `#graphql
  mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order { id name }
      userErrors { field message }
    }
  }`;

// financial statuses accepted by OrderCreateOrderInput
const ORDER_FIN_STATUS = new Set([
  "PENDING",
  "AUTHORIZED",
  "PARTIALLY_PAID",
  "PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "VOIDED",
]);

async function migrateOrders(ctx) {
  const { source, target, onLog, counters, hasQuota, consume } = ctx;
  const orders = await fetchAll(source, Q_ORDERS, "orders", {}, (n) =>
    onLog(`Fetched ${n} orders…`),
  );
  onLog(`Total ${orders.length} orders found. Importing…`);

  for (const o of orders) {
    if (!hasQuota()) {
      onLog("Quota reached — stopping orders.");
      break;
    }
    // duplicate detection by order name (e.g. "#1001")
    try {
      const r = await gql(target, Q_TARGET_ORDER_BY_NAME, {
        q: `name:${qv(o.name)}`,
      });
      if (r?.orders?.edges?.length) {
        counters.skipped++;
        onLog(`↪︎ Skipped (exists): ${o.name}`);
        continue;
      }
    } catch {
      /* ignore lookup errors, attempt create */
    }

    const lineItems = (o.lineItems?.edges || []).map((e) => {
      const li = e.node;
      const item = { title: li.title || "Item", quantity: li.quantity || 1 };
      const money = li.originalUnitPriceSet?.shopMoney;
      if (money?.amount) {
        item.priceSet = {
          shopMoney: {
            amount: money.amount,
            currencyCode: money.currencyCode || o.currencyCode,
          },
        };
      }
      return item;
    });

    if (lineItems.length === 0) {
      counters.skipped++;
      onLog(`↪︎ Skipped (no line items): ${o.name}`);
      continue;
    }

    const order = {
      email: o.email || undefined,
      note: o.note || undefined,
      tags: o.tags || [],
      currency: o.currencyCode || undefined,
      lineItems,
    };
    if (ORDER_FIN_STATUS.has(o.displayFinancialStatus)) {
      order.financialStatus = o.displayFinancialStatus;
    }
    const ship = mapAddress(o.shippingAddress);
    const bill = mapAddress(o.billingAddress);
    if (ship) order.shippingAddress = ship;
    if (bill) order.billingAddress = bill;

    try {
      const data = await gql(target, M_ORDER_CREATE, {
        order,
        options: {
          sendReceipt: false,
          sendFulfillmentReceipt: false,
          inventoryBehaviour: "BYPASS",
        },
      });
      const errs = data?.orderCreate?.userErrors;
      if (errs?.length) {
        counters.skipped++;
        onLog(`↪︎ Skipped: ${o.name} — ${errs[0].message}`);
      } else {
        counters.created++;
        consume();
        onLog(`✓ Order: ${o.name}`);
      }
    } catch (err) {
      counters.failed++;
      onLog(`✕ Order error: ${o.name} — ${String(err.message).slice(0, 120)}`);
    }
    await sleep(250);
  }

  // Draft orders are migrated as part of the orders module — they share the
  // same per-plan quota (consume() below still checks the "orders" limit).
  await migrateDraftOrders(ctx);
}

// ═════════════════════════════════════════════════════════════════════════════
//  DRAFT ORDERS (part of the ORDERS module — shares the "orders" quota)
//  Recreates open draft orders with their line items (as titled custom items),
//  addresses, note and tags. Customer email/address still fall under Protected
//  Customer Data, so the source query is skipped (logged) until access is live.
// ═════════════════════════════════════════════════════════════════════════════
const Q_DRAFT_ORDERS = `#graphql
  query DraftOrders($cursor: String) {
    draftOrders(first: 25, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id name email note2 tags
        lineItems(first: 50) {
          edges { node {
            title quantity sku
            originalUnitPriceSet { shopMoney { amount currencyCode } }
          } }
        }
        shippingAddress {
          address1 address2 city provinceCode countryCodeV2 zip phone
          firstName lastName company
        }
        billingAddress {
          address1 address2 city provinceCode countryCodeV2 zip phone
          firstName lastName company
        }
      } }
    }
  }`;

const Q_TARGET_DRAFT_BY_NAME = `#graphql
  query DraftByName($q: String!) {
    draftOrders(first: 1, query: $q) { edges { node { id name } } }
  }`;

const M_DRAFT_ORDER_CREATE = `#graphql
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name }
      userErrors { field message }
    }
  }`;

async function migrateDraftOrders(ctx) {
  const { source, target, onLog, counters, hasQuota, consume } = ctx;
  onLog("Draft orders…");
  const drafts = await fetchAll(
    source,
    Q_DRAFT_ORDERS,
    "draftOrders",
    {},
    (n) => onLog(`Fetched ${n} draft orders…`),
  );
  onLog(`Total ${drafts.length} draft orders found. Importing…`);

  for (const o of drafts) {
    if (!hasQuota()) {
      onLog("Quota reached — stopping draft orders.");
      break;
    }
    // duplicate detection by draft order name (e.g. "#D1")
    if (o.name) {
      try {
        const r = await gql(target, Q_TARGET_DRAFT_BY_NAME, {
          q: `name:${qv(o.name)}`,
        });
        if (r?.draftOrders?.edges?.length) {
          counters.skipped++;
          onLog(`↪︎ Skipped (exists): ${o.name}`);
          continue;
        }
      } catch {
        /* ignore lookup errors, attempt create */
      }
    }

    const lineItems = (o.lineItems?.edges || []).map((e) => {
      const li = e.node;
      const item = { title: li.title || "Item", quantity: li.quantity || 1 };
      const money = li.originalUnitPriceSet?.shopMoney;
      if (money?.amount != null) {
        item.originalUnitPriceWithCurrency = {
          amount: String(money.amount),
          currencyCode: money.currencyCode,
        };
      }
      return item;
    });

    if (lineItems.length === 0) {
      counters.skipped++;
      onLog(`↪︎ Skipped (no line items): ${o.name}`);
      continue;
    }

    const input = {
      email: o.email || undefined,
      note: o.note2 || undefined,
      tags: o.tags || [],
      lineItems,
    };
    const ship = mapAddress(o.shippingAddress);
    const bill = mapAddress(o.billingAddress);
    if (ship) input.shippingAddress = ship;
    if (bill) input.billingAddress = bill;

    try {
      const data = await gql(target, M_DRAFT_ORDER_CREATE, { input });
      const errs = data?.draftOrderCreate?.userErrors;
      if (errs?.length) {
        counters.skipped++;
        onLog(`↪︎ Skipped: ${o.name} — ${errs[0].message}`);
      } else {
        counters.created++;
        consume();
        onLog(`✓ Draft order: ${o.name}`);
      }
    } catch (err) {
      counters.failed++;
      onLog(
        `✕ Draft order error: ${o.name} — ${String(err.message).slice(0, 120)}`,
      );
    }
    await sleep(250);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  URL REDIRECTS
// ═════════════════════════════════════════════════════════════════════════════
const Q_REDIRECTS = `#graphql
  query Redirects($cursor: String) {
    urlRedirects(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id path target } }
    }
  }`;

const M_REDIRECT_CREATE = `#graphql
  mutation CreateRedirect($redirect: UrlRedirectInput!) {
    urlRedirectCreate(urlRedirect: $redirect) {
      urlRedirect { id }
      userErrors { field message }
    }
  }`;

const M_REDIRECT_UPDATE = `#graphql
  mutation UpdateRedirect($id: ID!, $redirect: UrlRedirectInput!) {
    urlRedirectUpdate(id: $id, urlRedirect: $redirect) {
      urlRedirect { id }
      userErrors { field message }
    }
  }`;

const Q_TARGET_REDIRECT_BY_PATH = `#graphql
  query RedirectByPath($q: String!) {
    urlRedirects(first: 1, query: $q) { edges { node { id path } } }
  }`;

async function migrateRedirects(ctx) {
  const { source, target, onLog, counters, consume } = ctx;
  const redirects = await fetchAll(
    source,
    Q_REDIRECTS,
    "urlRedirects",
    {},
    (n) => onLog(`Fetched ${n} URL redirects…`),
  );
  onLog(`Total ${redirects.length} redirects found. Importing…`);

  for (const r of redirects) {
    if (ctx.stopOnQuota()) {
      onLog("Quota reached — stopping redirects.");
      break;
    }
    // find existing redirect by path
    let existingRedirect = null;
    try {
      const rr = await gql(target, Q_TARGET_REDIRECT_BY_PATH, {
        q: `path:${qv(r.path)}`,
      });
      existingRedirect = rr?.urlRedirects?.edges?.[0]?.node || null;
    } catch {
      /* ignore */
    }

    if (existingRedirect) {
      if (ctx.mode !== "sync") {
        counters.skipped++;
        onLog(`↪︎ Skipped (exists): ${r.path}`);
        await sleep(120);
        continue;
      }
      try {
        const upd = await gql(target, M_REDIRECT_UPDATE, {
          id: existingRedirect.id,
          redirect: { path: r.path, target: r.target },
        });
        const uerrs = upd?.urlRedirectUpdate?.userErrors;
        if (uerrs?.length) {
          counters.failed++;
          onLog(`✕ Update failed: ${r.path} — ${uerrs[0].message}`);
        } else {
          counters.updated++;
          onLog(`↻ Updated: ${r.path} → ${r.target}`);
        }
      } catch (err) {
        counters.failed++;
        onLog(
          `✕ Update error: ${r.path} — ${String(err.message).slice(0, 120)}`,
        );
      }
      await sleep(120);
      continue;
    }

    if (!ctx.canCreate()) {
      counters.skipped++;
      onLog(`↪︎ Skipped (quota reached, not created): ${r.path}`);
      continue;
    }

    try {
      const data = await gql(target, M_REDIRECT_CREATE, {
        redirect: { path: r.path, target: r.target },
      });
      const errs = data?.urlRedirectCreate?.userErrors;
      if (errs?.length) {
        counters.skipped++;
        onLog(`↪︎ Skipped: ${r.path} — ${errs[0].message}`);
      } else {
        counters.created++;
        consume();
        onLog(`✓ Redirect: ${r.path} → ${r.target}`);
      }
    } catch (err) {
      counters.failed++;
      onLog(
        `✕ Redirect error: ${r.path} — ${String(err.message).slice(0, 120)}`,
      );
    }
    await sleep(120);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  BLOG POSTS (blogs + articles)
// ═════════════════════════════════════════════════════════════════════════════
const Q_BLOGS = `#graphql
  query Blogs($cursor: String) {
    blogs(first: 25, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id title handle } }
    }
  }`;

// articles are paginated separately so blogs with 100+ posts migrate fully
const Q_BLOG_ARTICLES = `#graphql
  query BlogArticles($id: ID!, $cursor: String) {
    blog(id: $id) {
      articles(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id title handle body summary tags isPublished publishedAt templateSuffix
          author { name }
          image { url altText }
          metafields(first: 50) { edges { node { namespace key value type } } }
        } }
      }
    }
  }`;

const Q_TARGET_BLOG_BY_HANDLE = `#graphql
  query BlogByHandle($q: String!) {
    blogs(first: 1, query: $q) { edges { node { id handle } } }
  }`;

const M_BLOG_CREATE = `#graphql
  mutation CreateBlog($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) {
      blog { id handle }
      userErrors { field message }
    }
  }`;

const M_ARTICLE_CREATE = `#graphql
  mutation CreateArticle($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article { id handle }
      userErrors { field message }
    }
  }`;

// fetch every article of a source blog, following pagination
async function fetchAllArticles(source, blogId) {
  let cursor = null;
  const all = [];
  do {
    const data = await gql(source, Q_BLOG_ARTICLES, { id: blogId, cursor });
    const conn = data?.blog?.articles;
    for (const e of conn?.edges ?? []) all.push(e.node);
    cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    if (cursor) await sleep(250);
  } while (cursor);
  return all;
}

const M_ARTICLE_UPDATE = `#graphql
  mutation UpdateArticle($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article { id handle }
      userErrors { field message }
    }
  }`;

const Q_TARGET_ARTICLE = `#graphql
  query TargetArticle($id: ID!, $cursor: String) {
    blog(id: $id) {
      articles(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges { node { id handle } }
      }
    }
  }`;

async function migrateBlogPosts(ctx) {
  const { source, target, onLog, counters, consume } = ctx;
  const blogs = await fetchAll(source, Q_BLOGS, "blogs", {}, (n) =>
    onLog(`Fetched ${n} blogs…`),
  );
  onLog(`Total ${blogs.length} blogs found. Importing articles…`);

  for (const blog of blogs) {
    // ensure a blog with this handle exists on the target
    let targetBlogId = null;
    try {
      const found = await gql(target, Q_TARGET_BLOG_BY_HANDLE, {
        q: `handle:${qv(blog.handle)}`,
      });
      targetBlogId = found?.blogs?.edges?.[0]?.node?.id ?? null;
    } catch {
      /* ignore lookup errors */
    }

    if (!targetBlogId) {
      try {
        const created = await gql(target, M_BLOG_CREATE, {
          blog: { title: blog.title, handle: blog.handle },
        });
        targetBlogId = created?.blogCreate?.blog?.id ?? null;
        if (targetBlogId) onLog(`✓ Blog ready: ${blog.title}`);
      } catch (err) {
        onLog(
          `✕ Blog failed: ${blog.title} — ${String(err.message).slice(0, 100)}`,
        );
      }
    } else {
      onLog(`↪︎ Blog exists: ${blog.title}`);
    }
    if (!targetBlogId) continue;

    // a failure reading one blog's articles must not abort the whole module
    let articles = [];
    try {
      articles = await fetchAllArticles(source, blog.id);
    } catch (err) {
      onLog(
        `✕ Could not read articles of ${blog.title} — ${String(err.message).slice(0, 120)}`,
      );
      continue;
    }
    onLog(`${articles.length} article(s) in ${blog.title}…`);

    // map existing target articles by handle (for sync updates)
    const targetArticles = {};
    try {
      let acur = null;
      do {
        const ad = await gql(target, Q_TARGET_ARTICLE, {
          id: targetBlogId,
          cursor: acur,
        });
        const aconn = ad?.blog?.articles;
        for (const e of aconn?.edges ?? [])
          targetArticles[e.node.handle] = e.node.id;
        acur = aconn?.pageInfo?.hasNextPage ? aconn.pageInfo.endCursor : null;
        if (acur) await sleep(200);
      } while (acur);
    } catch {
      /* ignore */
    }
    for (const a of articles) {
      if (ctx.stopOnQuota()) {
        onLog("Quota reached — stopping blog posts.");
        return;
      }
      const articleMf = metafieldsInput(a);
      const article = {
        blogId: targetBlogId,
        title: a.title,
        handle: a.handle,
        body: a.body,
        summary: a.summary || undefined,
        tags: a.tags || [],
        isPublished: a.isPublished,
        templateSuffix: a.templateSuffix || null,
        publishDate: a.publishedAt || undefined,
        author: a.author?.name ? { name: a.author.name } : undefined,
      };
      if (articleMf.length) article.metafields = articleMf;
      if (a.image?.url) {
        article.image = { url: a.image.url, altText: a.image.altText || "" };
      }
      const existingArticleId = targetArticles[a.handle];
      if (existingArticleId) {
        if (ctx.mode !== "sync") {
          counters.skipped++;
          onLog(`↪︎ Skipped (exists): ${a.title}`);
          await sleep(160);
          continue;
        }
        try {
          // articleUpdate doesn't take blogId; drop it from the payload
          const articleNoBlog = { ...article };
          delete articleNoBlog.blogId;
          const upd = await gql(target, M_ARTICLE_UPDATE, {
            id: existingArticleId,
            article: articleNoBlog,
          });
          const uerrs = upd?.articleUpdate?.userErrors;
          if (uerrs?.length) {
            counters.failed++;
            onLog(`✕ Update failed: ${a.title} — ${uerrs[0].message}`);
          } else {
            counters.updated++;
            onLog(`↻ Updated: ${a.title}`);
          }
        } catch (err) {
          counters.failed++;
          onLog(
            `✕ Update error: ${a.title} — ${String(err.message).slice(0, 120)}`,
          );
        }
        await sleep(160);
        continue;
      }

      if (!ctx.canCreate()) {
        counters.skipped++;
        onLog(`↪︎ Skipped (quota reached, not created): ${a.title}`);
        await sleep(160);
        continue;
      }

      try {
        const data = await gql(target, M_ARTICLE_CREATE, { article });
        const errs = data?.articleCreate?.userErrors;
        if (errs?.length) {
          counters.skipped++;
          onLog(`↪︎ Skipped article: ${a.title} — ${errs[0].message}`);
        } else {
          counters.created++;
          consume();
          onLog(`✓ Article: ${a.title}`);
        }
      } catch (err) {
        counters.failed++;
        onLog(
          `✕ Article error: ${a.title} — ${String(err.message).slice(0, 120)}`,
        );
      }
      await sleep(160);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  MENUS (online store navigation)
//
//  Resource-bound items (collection/product/page links) reference gids that
//  differ between stores, so those are recreated as plain URL (HTTP) links —
//  the path usually still resolves when handles match. Front-page / search /
//  http items copy across directly.
// ═════════════════════════════════════════════════════════════════════════════
const Q_MENUS = `#graphql
  query Menus($cursor: String) {
    menus(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id title handle
        items { id title type url tags
          items { id title type url tags
            items { id title type url tags
              items { id title type url tags }
            }
          }
        }
      } }
    }
  }`;

const Q_TARGET_MENU_BY_HANDLE = `#graphql
  query MenuByHandle($q: String!) {
    menus(first: 1, query: $q) { edges { node { id handle } } }
  }`;

const M_MENU_CREATE = `#graphql
  mutation CreateMenu($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
    menuCreate(title: $title, handle: $handle, items: $items) {
      menu { id handle }
      userErrors { field message }
    }
  }`;

// types that need a resourceId we can't map across stores → fall back to URL
const RESOURCE_MENU_TYPES = new Set([
  "COLLECTION",
  "PRODUCT",
  "PAGE",
  "BLOG",
  "ARTICLE",
  "CATALOG",
  "SHOP_POLICY",
]);

// Resource-bound item urls are absolute and point at the SOURCE store
// (https://source.myshopify.com/collections/x). Strip the origin so the link
// resolves against the TARGET storefront instead of sending shoppers back to
// the source. External HTTP links the merchant authored are left untouched.
function relativizeUrl(url) {
  if (!url) return "/";
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return url.startsWith("/") ? url : "/";
  }
}

function mapMenuItem(item) {
  const isResource = RESOURCE_MENU_TYPES.has(item.type);
  const node = {
    title: item.title,
    type: isResource ? "HTTP" : item.type,
    tags: item.tags || [],
  };
  // FRONTPAGE / SEARCH don't take a url; everything else uses the source url
  if (node.type !== "FRONTPAGE" && node.type !== "SEARCH") {
    node.url = isResource ? relativizeUrl(item.url) : item.url || "/";
  }
  if (item.items?.length) {
    node.items = item.items.map(mapMenuItem);
  }
  return node;
}

async function migrateMenus(ctx) {
  const { source, target, onLog, counters, hasQuota, consume } = ctx;
  const menus = await fetchAll(source, Q_MENUS, "menus", {}, (n) =>
    onLog(`Fetched ${n} menus…`),
  );
  onLog(`Total ${menus.length} menus found. Importing…`);

  for (const m of menus) {
    if (!hasQuota()) {
      onLog("Quota reached — stopping menus.");
      break;
    }
    try {
      const found = await gql(target, Q_TARGET_MENU_BY_HANDLE, {
        q: `handle:${qv(m.handle)}`,
      });
      if (found?.menus?.edges?.length) {
        counters.skipped++;
        onLog(`↪︎ Skipped (exists): ${m.title}`);
        continue;
      }
    } catch {
      /* ignore lookup errors, attempt create */
    }

    try {
      const data = await gql(target, M_MENU_CREATE, {
        title: m.title,
        handle: m.handle,
        items: (m.items || []).map(mapMenuItem),
      });
      const errs = data?.menuCreate?.userErrors;
      if (errs?.length) {
        counters.failed++;
        onLog(`✕ Failed: ${m.title} — ${errs[0].message}`);
      } else {
        counters.created++;
        consume();
        onLog(`✓ Menu: ${m.title}`);
      }
    } catch (err) {
      counters.failed++;
      onLog(`✕ Menu error: ${m.title} — ${String(err.message).slice(0, 120)}`);
    }
    await sleep(180);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  DISCOUNTS
//
//  Best-effort: recreates basic code discounts and basic automatic discounts
//  (percentage or fixed-amount off, applied to all items). Other discount
//  classes (BxGy, free shipping, app discounts) are logged and skipped.
// ═════════════════════════════════════════════════════════════════════════════
const Q_DISCOUNTS = `#graphql
  query Discounts($cursor: String) {
    discountNodes(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id
        discount {
          __typename
          ... on DiscountCodeBasic {
            title status startsAt endsAt appliesOncePerCustomer
            codes(first: 1) { edges { node { code } } }
            customerGets {
              value {
                __typename
                ... on DiscountPercentage { percentage }
                ... on DiscountAmount { amount { amount } }
              }
            }
          }
          ... on DiscountAutomaticBasic {
            title status startsAt endsAt
            customerGets {
              value {
                __typename
                ... on DiscountPercentage { percentage }
                ... on DiscountAmount { amount { amount } }
              }
            }
          }
          ... on DiscountCodeFreeShipping {
            title status startsAt endsAt appliesOncePerCustomer
            codes(first: 1) { edges { node { code } } }
          }
          ... on DiscountAutomaticFreeShipping {
            title status startsAt endsAt
          }
          ... on DiscountCodeBxgy {
            title status startsAt endsAt usesPerOrderLimit appliesOncePerCustomer
            codes(first: 1) { edges { node { code } } }
            customerBuys {
              value {
                __typename
                ... on DiscountQuantity { quantity }
                ... on DiscountPurchaseAmount { amount }
              }
            }
            customerGets {
              value {
                __typename
                ... on DiscountOnQuantity {
                  quantity { quantity }
                  effect {
                    __typename
                    ... on DiscountPercentage { percentage }
                  }
                }
                ... on DiscountPercentage { percentage }
              }
            }
          }
          ... on DiscountAutomaticBxgy {
            title status startsAt endsAt
            customerBuys {
              value {
                __typename
                ... on DiscountQuantity { quantity }
                ... on DiscountPurchaseAmount { amount }
              }
            }
            customerGets {
              value {
                __typename
                ... on DiscountOnQuantity {
                  quantity { quantity }
                  effect {
                    __typename
                    ... on DiscountPercentage { percentage }
                  }
                }
                ... on DiscountPercentage { percentage }
              }
            }
          }
        }
      } }
    }
  }`;

const M_DISCOUNT_CODE_BASIC_CREATE = `#graphql
  mutation CreateCodeDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }`;

const M_DISCOUNT_AUTO_BASIC_CREATE = `#graphql
  mutation CreateAutoDiscount($automaticBasicDiscount: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
      automaticDiscountNode { id }
      userErrors { field message }
    }
  }`;

const M_DISCOUNT_CODE_FREE_SHIPPING_CREATE = `#graphql
  mutation CreateCodeFreeShipping($freeShippingCodeDiscount: DiscountCodeFreeShippingInput!) {
    discountCodeFreeShippingCreate(freeShippingCodeDiscount: $freeShippingCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }`;

const M_DISCOUNT_AUTO_FREE_SHIPPING_CREATE = `#graphql
  mutation CreateAutoFreeShipping($freeShippingAutomaticDiscount: DiscountAutomaticFreeShippingInput!) {
    discountAutomaticFreeShippingCreate(freeShippingAutomaticDiscount: $freeShippingAutomaticDiscount) {
      automaticDiscountNode { id }
      userErrors { field message }
    }
  }`;

const M_DISCOUNT_CODE_BXGY_CREATE = `#graphql
  mutation CreateCodeBxgy($bxgyCodeDiscount: DiscountCodeBxgyInput!) {
    discountCodeBxgyCreate(bxgyCodeDiscount: $bxgyCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }`;

const M_DISCOUNT_AUTO_BXGY_CREATE = `#graphql
  mutation CreateAutoBxgy($automaticBxgyDiscount: DiscountAutomaticBxgyInput!) {
    discountAutomaticBxgyCreate(automaticBxgyDiscount: $automaticBxgyDiscount) {
      automaticDiscountNode { id }
      userErrors { field message }
    }
  }`;

// Build the customerBuys input (the "Buy X" half of a BxGy discount).
// Items reference product/variant/collection gids that don't map across stores,
// so the prerequisite is recreated against ALL items — a documented best-effort.
function bxgyCustomerBuysInput(customerBuys) {
  const v = customerBuys?.value;
  if (!v) return null;
  if (v.__typename === "DiscountQuantity" && v.quantity != null) {
    return { value: { quantity: String(v.quantity) }, items: { all: true } };
  }
  if (v.__typename === "DiscountPurchaseAmount" && v.amount != null) {
    return { value: { amount: String(v.amount) }, items: { all: true } };
  }
  return null;
}

// Build the customerGets input (the "Get Y" half of a BxGy discount). Only
// percentage effects (incl. 100% = free) are supported; fixed-amount effects
// vary by store and are reported as unsupported by the caller.
function bxgyCustomerGetsInput(customerGets) {
  const v = customerGets?.value;
  if (!v) return null;
  if (v.__typename === "DiscountOnQuantity") {
    if (v.effect?.__typename !== "DiscountPercentage") return null;
    return {
      value: {
        discountOnQuantity: {
          quantity: String(v.quantity?.quantity ?? "1"),
          effect: { percentage: v.effect.percentage ?? 1 },
        },
      },
      items: { all: true },
    };
  }
  if (v.__typename === "DiscountPercentage") {
    return { value: { percentage: v.percentage ?? 0 }, items: { all: true } };
  }
  return null;
}

// build the customerGets.value input from a source discount value
function discountValueInput(value) {
  if (!value) return null;
  if (value.__typename === "DiscountPercentage") {
    // Shopify expects a 0–1 fraction for percentage
    return { percentage: value.percentage ?? 0 };
  }
  if (value.__typename === "DiscountAmount") {
    return {
      discountAmount: {
        amount: value.amount?.amount ?? "0",
        appliesOnEachItem: false,
      },
    };
  }
  return null;
}

async function migrateDiscounts(ctx) {
  const { source, target, onLog, counters, hasQuota, consume } = ctx;
  const nodes = await fetchAll(source, Q_DISCOUNTS, "discountNodes", {}, (n) =>
    onLog(`Fetched ${n} discounts…`),
  );
  onLog(`Total ${nodes.length} discounts found. Importing…`);

  for (const n of nodes) {
    if (!hasQuota()) {
      onLog("Quota reached — stopping discounts.");
      break;
    }
    const d = n.discount;
    const kind = d?.__typename;

    try {
      if (kind === "DiscountCodeBasic") {
        const value = discountValueInput(d.customerGets?.value);
        if (!value) {
          counters.skipped++;
          onLog(`↪︎ Skipped (unsupported value): ${d.title}`);
          continue;
        }
        const code = d.codes?.edges?.[0]?.node?.code || d.title;
        const data = await gql(target, M_DISCOUNT_CODE_BASIC_CREATE, {
          basicCodeDiscount: {
            title: d.title,
            code,
            startsAt: d.startsAt,
            endsAt: d.endsAt || null,
            appliesOncePerCustomer: !!d.appliesOncePerCustomer,
            customerSelection: { all: true },
            customerGets: { value, items: { all: true } },
          },
        });
        const errs = data?.discountCodeBasicCreate?.userErrors;
        if (errs?.length) {
          counters.skipped++;
          onLog(`↪︎ Skipped: ${d.title} — ${errs[0].message}`);
        } else {
          counters.created++;
          consume();
          onLog(`✓ Code discount: ${d.title}`);
        }
      } else if (kind === "DiscountAutomaticBasic") {
        const value = discountValueInput(d.customerGets?.value);
        if (!value) {
          counters.skipped++;
          onLog(`↪︎ Skipped (unsupported value): ${d.title}`);
          continue;
        }
        const data = await gql(target, M_DISCOUNT_AUTO_BASIC_CREATE, {
          automaticBasicDiscount: {
            title: d.title,
            startsAt: d.startsAt,
            endsAt: d.endsAt || null,
            customerGets: { value, items: { all: true } },
            minimumRequirement: {
              quantity: { greaterThanOrEqualToQuantity: "1" },
            },
          },
        });
        const errs = data?.discountAutomaticBasicCreate?.userErrors;
        if (errs?.length) {
          counters.skipped++;
          onLog(`↪︎ Skipped: ${d.title} — ${errs[0].message}`);
        } else {
          counters.created++;
          consume();
          onLog(`✓ Automatic discount: ${d.title}`);
        }
      } else if (kind === "DiscountCodeFreeShipping") {
        const code = d.codes?.edges?.[0]?.node?.code || d.title;
        const data = await gql(target, M_DISCOUNT_CODE_FREE_SHIPPING_CREATE, {
          freeShippingCodeDiscount: {
            title: d.title,
            code,
            startsAt: d.startsAt,
            endsAt: d.endsAt || null,
            appliesOncePerCustomer: !!d.appliesOncePerCustomer,
            customerSelection: { all: true },
            destination: { all: true },
          },
        });
        const errs = data?.discountCodeFreeShippingCreate?.userErrors;
        if (errs?.length) {
          counters.skipped++;
          onLog(`↪︎ Skipped: ${d.title} — ${errs[0].message}`);
        } else {
          counters.created++;
          consume();
          onLog(`✓ Free-shipping code discount: ${d.title}`);
        }
      } else if (kind === "DiscountAutomaticFreeShipping") {
        const data = await gql(target, M_DISCOUNT_AUTO_FREE_SHIPPING_CREATE, {
          freeShippingAutomaticDiscount: {
            title: d.title,
            startsAt: d.startsAt,
            endsAt: d.endsAt || null,
            destination: { all: true },
          },
        });
        const errs = data?.discountAutomaticFreeShippingCreate?.userErrors;
        if (errs?.length) {
          counters.skipped++;
          onLog(`↪︎ Skipped: ${d.title} — ${errs[0].message}`);
        } else {
          counters.created++;
          consume();
          onLog(`✓ Automatic free-shipping discount: ${d.title}`);
        }
      } else if (kind === "DiscountCodeBxgy") {
        const customerBuys = bxgyCustomerBuysInput(d.customerBuys);
        const customerGets = bxgyCustomerGetsInput(d.customerGets);
        if (!customerBuys || !customerGets) {
          counters.skipped++;
          onLog(`↪︎ Skipped (unsupported Buy X Get Y shape): ${d.title}`);
          continue;
        }
        const code = d.codes?.edges?.[0]?.node?.code || d.title;
        const data = await gql(target, M_DISCOUNT_CODE_BXGY_CREATE, {
          bxgyCodeDiscount: {
            title: d.title,
            code,
            startsAt: d.startsAt,
            endsAt: d.endsAt || null,
            usesPerOrderLimit: d.usesPerOrderLimit ?? null,
            appliesOncePerCustomer: !!d.appliesOncePerCustomer,
            customerSelection: { all: true },
            customerBuys,
            customerGets,
          },
        });
        const errs = data?.discountCodeBxgyCreate?.userErrors;
        if (errs?.length) {
          counters.skipped++;
          onLog(`↪︎ Skipped: ${d.title} — ${errs[0].message}`);
        } else {
          counters.created++;
          consume();
          onLog(`✓ Buy X Get Y code discount: ${d.title}`);
        }
      } else if (kind === "DiscountAutomaticBxgy") {
        const customerBuys = bxgyCustomerBuysInput(d.customerBuys);
        const customerGets = bxgyCustomerGetsInput(d.customerGets);
        if (!customerBuys || !customerGets) {
          counters.skipped++;
          onLog(`↪︎ Skipped (unsupported Buy X Get Y shape): ${d.title}`);
          continue;
        }
        const data = await gql(target, M_DISCOUNT_AUTO_BXGY_CREATE, {
          automaticBxgyDiscount: {
            title: d.title,
            startsAt: d.startsAt,
            endsAt: d.endsAt || null,
            customerBuys,
            customerGets,
          },
        });
        const errs = data?.discountAutomaticBxgyCreate?.userErrors;
        if (errs?.length) {
          counters.skipped++;
          onLog(`↪︎ Skipped: ${d.title} — ${errs[0].message}`);
        } else {
          counters.created++;
          consume();
          onLog(`✓ Automatic Buy X Get Y discount: ${d.title}`);
        }
      } else {
        counters.skipped++;
        onLog(`↪︎ Skipped (unsupported type ${kind || "unknown"})`);
      }
    } catch (err) {
      counters.failed++;
      onLog(
        `✕ Discount error: ${d?.title || "?"} — ${String(err.message).slice(0, 120)}`,
      );
    }
    await sleep(220);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  THEME (published theme → new UNPUBLISHED theme on target)
//
//  Copies the source store's live/published theme — all Liquid/JSON templates,
//  sections, snippets, config, locales and assets — so templateSuffix references
//  copied with products/collections/pages/articles actually resolve on target.
//
//  Shopify has no "create empty theme" API: themeCreate REQUIRES a source zip.
//  So we bootstrap the target theme from Dawn's public zip, overwrite every file
//  with the SOURCE theme's files, then delete any bootstrap-only leftovers — the
//  final theme equals the source. It is left UNPUBLISHED; the merchant reviews
//  and publishes it, so the target store's live storefront is never touched.
//
//  This is an always-on bundled step (not a credited migration type).
// ═════════════════════════════════════════════════════════════════════════════
const THEME_BOOTSTRAP_ZIP =
  "https://github.com/Shopify/dawn/archive/refs/heads/main.zip";

const Q_SOURCE_MAIN_THEME = `#graphql
  query MainTheme {
    themes(first: 1, roles: [MAIN]) {
      nodes { id name }
    }
  }`;

const Q_TARGET_THEMES = `#graphql
  query TargetThemes($cursor: String) {
    themes(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id name role }
    }
  }`;

const Q_THEME_PROCESSING = `#graphql
  query ThemeProcessing($id: ID!) {
    theme(id: $id) { id processing }
  }`;

// full file bodies (for reading the SOURCE theme)
const Q_THEME_FILES = `#graphql
  query ThemeFiles($id: ID!, $cursor: String) {
    theme(id: $id) {
      files(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          filename
          body {
            __typename
            ... on OnlineStoreThemeFileBodyText { content }
            ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
            ... on OnlineStoreThemeFileBodyUrl { url }
          }
        }
      }
    }
  }`;

// filenames only (for finding bootstrap leftovers to delete on TARGET)
const Q_THEME_FILENAMES = `#graphql
  query ThemeFilenames($id: ID!, $cursor: String) {
    theme(id: $id) {
      files(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { filename }
      }
    }
  }`;

const M_THEME_CREATE = `#graphql
  mutation ThemeCreate($name: String!, $source: URL!) {
    themeCreate(name: $name, source: $source) {
      theme { id name }
      userErrors { field message }
    }
  }`;

const M_THEME_FILES_UPSERT = `#graphql
  mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      userErrors { field message code }
    }
  }`;

const M_THEME_FILES_DELETE = `#graphql
  mutation ThemeFilesDelete($themeId: ID!, $files: [String!]!) {
    themeFilesDelete(themeId: $themeId, files: $files) {
      userErrors { field message code }
    }
  }`;

// map a source OnlineStoreThemeFile to an upsert input; URL-bodied assets are
// re-fetched by Shopify from the source CDN (pass-through, no download here)
function themeFileUpsertInput(node) {
  const b = node?.body;
  if (!b || !node.filename) return null;
  if (b.__typename === "OnlineStoreThemeFileBodyText" && b.content != null) {
    return { filename: node.filename, body: { type: "TEXT", value: b.content } };
  }
  if (b.__typename === "OnlineStoreThemeFileBodyBase64" && b.contentBase64 != null) {
    return {
      filename: node.filename,
      body: { type: "BASE64", value: b.contentBase64 },
    };
  }
  if (b.__typename === "OnlineStoreThemeFileBodyUrl" && b.url != null) {
    return { filename: node.filename, body: { type: "URL", value: b.url } };
  }
  return null;
}

// wait out the async bootstrap import so upserts don't race theme processing
async function waitForThemeReady(admin, themeId, onLog) {
  for (let i = 0; i < 30; i++) {
    try {
      const d = await gql(admin, Q_THEME_PROCESSING, { id: themeId });
      if (d?.theme && d.theme.processing === false) return;
    } catch {
      /* transient — retry */
    }
    await sleep(2000);
  }
  onLog("  ⚠ Theme still processing after wait — continuing anyway.");
}

async function migrateThemes(ctx) {
  const { source, target, onLog, counters } = ctx;

  // 1. source published theme
  let src = null;
  try {
    const d = await gql(source, Q_SOURCE_MAIN_THEME);
    src = d?.themes?.nodes?.[0] || null;
  } catch (err) {
    onLog(
      `✕ Theme: could not read source theme — ${String(err.message).slice(0, 120)}`,
    );
    return;
  }
  if (!src) {
    onLog("↪︎ Theme: no published theme on source — skipped.");
    return;
  }

  const targetName = `${src.name} (migrated)`;

  // 2. idempotency — skip if we already created this theme on the target
  try {
    let cursor = null;
    do {
      const d = await gql(target, Q_TARGET_THEMES, { cursor });
      const conn = d?.themes;
      for (const t of conn?.nodes ?? []) {
        if (t.name === targetName) {
          onLog(`↪︎ Theme exists on target: "${targetName}" — skipped.`);
          return;
        }
      }
      cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);
  } catch {
    /* couldn't list — fall through and attempt create */
  }

  // 3. create target theme (unpublished) from the bootstrap zip
  let newThemeId = null;
  try {
    const d = await gql(target, M_THEME_CREATE, {
      name: targetName,
      source: THEME_BOOTSTRAP_ZIP,
    });
    const errs = d?.themeCreate?.userErrors;
    if (errs?.length) {
      onLog(`✕ Theme create failed — ${errs[0].message}`);
      return;
    }
    newThemeId = d?.themeCreate?.theme?.id || null;
  } catch (err) {
    onLog(`✕ Theme create error — ${String(err.message).slice(0, 140)}`);
    return;
  }
  if (!newThemeId) {
    onLog("✕ Theme create returned no id — skipped.");
    return;
  }
  onLog(`✓ Theme created (unpublished): "${targetName}" — copying files…`);

  // 4. wait for the bootstrap import to finish processing
  await waitForThemeReady(target, newThemeId, onLog);

  // 5. read every file from the source theme
  const srcFiles = [];
  try {
    let cursor = null;
    do {
      const d = await gql(source, Q_THEME_FILES, { id: src.id, cursor });
      const conn = d?.theme?.files;
      for (const n of conn?.nodes ?? []) srcFiles.push(n);
      cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
      if (cursor) await sleep(250);
    } while (cursor);
  } catch (err) {
    onLog(
      `✕ Theme: reading source files failed — ${String(err.message).slice(0, 120)}`,
    );
    return;
  }

  const inputs = srcFiles.map(themeFileUpsertInput).filter(Boolean);
  const sourceFilenames = new Set(inputs.map((f) => f.filename));
  onLog(`  ${inputs.length} source theme files to copy…`);

  // 6. overwrite the bootstrap files with the source files (small batches)
  let upserted = 0;
  let fileIssues = 0;
  for (let i = 0; i < inputs.length; i += 5) {
    const batch = inputs.slice(i, i + 5);
    try {
      const d = await gql(target, M_THEME_FILES_UPSERT, {
        themeId: newThemeId,
        files: batch,
      });
      const errs = d?.themeFilesUpsert?.userErrors;
      if (errs?.length) {
        fileIssues += batch.length;
        onLog(`  ⚠ Some theme files failed — ${errs[0].message}`);
      } else {
        upserted += batch.length;
      }
    } catch (err) {
      fileIssues += batch.length;
      onLog(`  ⚠ Theme file batch error — ${String(err.message).slice(0, 100)}`);
    }
    await sleep(400);
  }
  onLog(
    `  copied ${upserted} files${fileIssues ? `, ${fileIssues} had issues` : ""}.`,
  );

  // 7. delete bootstrap-only leftovers (files on target not present in source)
  try {
    const targetFilenames = [];
    let cursor = null;
    do {
      const d = await gql(target, Q_THEME_FILENAMES, {
        id: newThemeId,
        cursor,
      });
      const conn = d?.theme?.files;
      for (const n of conn?.nodes ?? []) targetFilenames.push(n.filename);
      cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
      if (cursor) await sleep(250);
    } while (cursor);

    const leftovers = targetFilenames.filter((f) => !sourceFilenames.has(f));
    for (let i = 0; i < leftovers.length; i += 10) {
      const batch = leftovers.slice(i, i + 10);
      try {
        await gql(target, M_THEME_FILES_DELETE, {
          themeId: newThemeId,
          files: batch,
        });
      } catch {
        /* best-effort cleanup */
      }
      await sleep(300);
    }
    if (leftovers.length) {
      onLog(`  removed ${leftovers.length} bootstrap file(s) not in source.`);
    }
  } catch {
    /* cleanup is best-effort — leftover base files don't break the theme */
  }

  counters.created++;
  onLog(
    `✓ Theme sync complete: "${targetName}" — review and publish it in the target admin.`,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  ORCHESTRATOR
// ═════════════════════════════════════════════════════════════════════════════
const RUNNERS = {
  products: migrateProducts,
  collections: migrateCollections,
  pages: migratePages,
  discounts: migrateDiscounts,
  files: migrateFiles,
  menus: migrateMenus,
  redirects: migrateRedirects,
  metaobjects: migrateMetaobjects,
  blogPosts: migrateBlogPosts,
  metafields: migrateMetafields,
  orders: migrateOrders,
  customers: migrateCustomers,
};

// Order matters: metafield/metaobject definitions first so product fields
// stick; products before collections so manual-collection membership (#7) can
// resolve its members by handle on the target; menus after the resources they
// link to. All cross-references use live handle/SKU lookups, not stored maps.
const RUN_ORDER = [
  "metafields",
  "metaobjects",
  "products",
  "collections",
  "pages",
  "blogPosts",
  "files",
  "discounts",
  "redirects",
  // menus link to collections/pages/blogs by handle — run after them
  "menus",
  "orders",
  "customers",
];

/**
 * @param {object}   opts
 * @param {object}   opts.source   admin client for source shop
 * @param {object}   opts.target   admin client for target shop
 * @param {string[]} opts.types    data types to migrate
 * @param {object}   opts.limits   per-type hard limits { products: 500, ... }
 * @param {function} opts.onLog    (msg:string) => void
 */
export async function runMigration({
  source,
  target,
  types,
  limits = {},
  mode = "migrate",
  onLog = () => {},
}) {
  const counters = { created: 0, updated: 0, skipped: 0, failed: 0 };
  // per-type consumed counters — only items actually CREATED consume quota;
  // duplicates that are skipped and failed attempts cost nothing.
  const consumed = {};
  types.forEach((t) => (consumed[t] = 0));

  // true while the current type still has quota left
  const hasQuota = (type) => {
    const limit = limits[type];
    if (limit == null || limit === Infinity) return true;
    return (consumed[type] || 0) < limit;
  };
  // record one successfully created item of the current type
  const consume = (type) => {
    consumed[type] = (consumed[type] || 0) + 1;
  };

  // the orchestrator tracks the current type so each runner checks its own quota
  let currentType = null;
  const ctx = {
    source,
    target,
    onLog,
    counters,
    mode,
    hasQuota: () => hasQuota(currentType),
    // In migrate mode, exhausting quota ends the module — there is nothing left
    // to do. In sync mode updates cost nothing, so keep scanning the remaining
    // source items to update the ones that already exist; only creates are
    // withheld (guard the create path with canCreate()).
    stopOnQuota: () => !hasQuota(currentType) && mode !== "sync",
    canCreate: () => hasQuota(currentType),
    consume: () => consume(currentType),
    setType: (t) => {
      currentType = t;
    },
  };

  // Themes are an always-on bundled step (not a credited type): copy the
  // source's published theme into a new UNPUBLISHED theme on the target BEFORE
  // other data, so templateSuffix references resolve. Never publishes and never
  // edits the target's live theme. Skips cheaply if already copied.
  currentType = "themes";
  onLog("── THEME ──");
  try {
    await migrateThemes(ctx);
  } catch (err) {
    onLog(`✕ theme module failed: ${String(err.message).slice(0, 160)}`);
  }

  const ordered = RUN_ORDER.filter((t) => types.includes(t));
  for (const t of ordered) {
    currentType = t;
    onLog(`── ${t.toUpperCase()} ──`);
    try {
      await RUNNERS[t](ctx);
    } catch (err) {
      onLog(`✕ ${t} module failed: ${String(err.message).slice(0, 160)}`);
    }
  }

  const total =
    counters.created + counters.updated + counters.skipped + counters.failed;

  const consumedTotal = Object.values(consumed).reduce((a, b) => a + b, 0);

  return {
    ...counters,
    total,
    consumed: consumedTotal,
    consumedByType: consumed, // { products: 5, collections: 3, ... }
    summary: `${counters.created} created · ${counters.updated} updated · ${counters.skipped} skipped · ${counters.failed} failed`,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  PREVIEW (counts only — no writes)
// ═════════════════════════════════════════════════════════════════════════════
const COUNT_QUERIES = {
  products: `#graphql { productsCount { count } }`,
  collections: `#graphql { collectionsCount { count } }`,
  // pages / files don't expose a count field uniformly; fetch first page size
};

export async function previewCounts({ source, target, types }) {
  const result = {};
  for (const t of types) {
    if (COUNT_QUERIES[t]) {
      try {
        const s = await gql(source, COUNT_QUERIES[t]);
        const key = Object.keys(s)[0];
        const tg = await gql(target, COUNT_QUERIES[t]);
        result[t] = {
          source: s[key]?.count ?? 0,
          target: tg[key]?.count ?? 0,
        };
      } catch {
        result[t] = { source: "—", target: "—" };
      }
    } else {
      result[t] = { source: "—", target: "—" };
    }
  }
  return result;
}
