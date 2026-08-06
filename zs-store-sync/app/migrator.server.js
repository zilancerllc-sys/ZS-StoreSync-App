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

import { customerRef } from "./redact.server";

// Namespaces (metafields) and types (metaobjects) that Shopify or another app
// owns. They already exist on every store and creating them is always refused
// — "Not authorized. This type is reserved for use by another application."
// Attempting them turned otherwise-clean runs into "partial" and put errors in
// the log that no merchant can act on.
//   app / app--*      another app's private namespace
//   global            legacy reserved namespace (SEO keys live here)
//   shopify / shopify--*  Shopify's own standard definitions, e.g.
//                     shopify--color-pattern, shopify--flavor
function isReservedNamespace(value) {
  const s = String(value || "");
  return (
    s === "app" ||
    s.startsWith("app--") ||
    s === "global" ||
    s === "shopify" ||
    s.startsWith("shopify--")
  );
}

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

// Render EVERY userError with its field path. Logging only errors[0].message
// hid which field Shopify actually objected to, which made "not syncing"
// reports impossible to diagnose from the job log.
function errText(errs) {
  return (errs || [])
    .slice(0, 4)
    .map((e) => {
      const f = Array.isArray(e.field) ? e.field.join(".") : e.field;
      return f ? `${f}: ${e.message}` : e.message;
    })
    .join(" | ")
    .slice(0, 400);
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
            metafields(first: 50) { edges { node { namespace key value type } } }
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
      id
      hasOnlyDefaultVariant
      options { id name position values }
      variants(first: 100) { edges { node {
        id sku title
        selectedOptions { name value }
      } } }
    }
  }`;

const M_PRODUCT_OPTIONS_CREATE = `#graphql
  mutation ProductOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!, $variantStrategy: ProductOptionCreateVariantStrategy) {
    productOptionsCreate(productId: $productId, options: $options, variantStrategy: $variantStrategy) {
      product { id }
      userErrors { field message code }
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

// map a source variant to a ProductVariantsBulkInput. `metafields` is passed in
// already remapped, because resolving references is async.
function variantBulkInput(v, withOptionValues, metafields) {
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
  if (metafields?.length) input.metafields = metafields;
  return input;
}

// Identifies a variant across stores when it has no SKU: the sorted set of its
// option values ("Size=48"), falling back to the variant title.
function variantSignature(v) {
  const opts = (v.selectedOptions || [])
    .map((so) => `${so.name}=${so.value}`)
    .sort()
    .join("|");
  return opts || (v.title ? `title:${v.title}` : null);
}

// build variant inputs for a whole product, remapping each variant's metafields
async function variantInputsFor(ctx, sourceVariants, withOptionValues) {
  const out = [];
  for (const v of sourceVariants) {
    const mf = await metafieldsInput(ctx, v, { excludeSeo: true });
    out.push(variantBulkInput(v, withOptionValues, mf));
  }
  return out;
}

// Sync mode variant reconciliation. `productUpdate` cannot touch options or
// variants at all (`productOptions` is create-only), so an existing target
// product that was created without the source's options could never gain them —
// it just sat there with a single default variant. This brings the target's
// variant structure in line with the source:
//   1. add any option the source has and the target lacks;
//   2. if the target still only has the implicit default variant, rebuild the
//      variants from the source and drop that placeholder;
//   3. otherwise update matching variants (by SKU, else option signature) and
//      create the ones the target is missing.
// Variants that exist only on the target are left alone — a sync never deletes
// merchant data beyond the implicit default placeholder in step 2.
async function syncVariants(ctx, targetProductId, sourceProduct) {
  const { target, onLog } = ctx;
  const sourceVariants = (sourceProduct.variants?.edges || []).map(
    (e) => e.node,
  );
  if (!sourceVariants.length) return;

  const label = sourceProduct.title;
  const sourceRealOptions = hasRealOptions(sourceProduct);

  // metafields are async to build, so precompute one input per source variant
  const mfFor = new Map();
  for (const sv of sourceVariants) {
    mfFor.set(sv, await metafieldsInput(ctx, sv, { excludeSeo: true }));
  }

  try {
    let td = await gql(target, Q_TARGET_PRODUCT_VARIANTS, {
      id: targetProductId,
    });
    let tp = td?.product;
    if (!tp) return;

    // ── 1. create options the target is missing ──────────────────────────────
    if (sourceRealOptions) {
      const haveNames = new Set(
        (tp.options || [])
          .filter((o) => o.name !== "Title")
          .map((o) => o.name),
      );
      const missing = (sourceProduct.options || []).filter(
        (o) => !haveNames.has(o.name),
      );
      if (missing.length) {
        const odata = await gql(target, M_PRODUCT_OPTIONS_CREATE, {
          productId: targetProductId,
          options: missing.map((o, i) => ({
            name: o.name,
            position: haveNames.size + i + 1,
            values: (o.values || []).map((v) => ({ name: v })),
          })),
          variantStrategy: "LEAVE_AS_IS",
        });
        const oerrs = odata?.productOptionsCreate?.userErrors;
        if (oerrs?.length) {
          onLog(`  ⚠ Options not added for ${label} — ${errText(oerrs)}`);
        } else {
          onLog(
            `  + ${missing.length} option(s) added to ${label}: ${missing.map((o) => o.name).join(", ")}`,
          );
          td = await gql(target, Q_TARGET_PRODUCT_VARIANTS, {
            id: targetProductId,
          });
          tp = td?.product || tp;
        }
      }
    }

    const targetVariants = (tp.variants?.edges || []).map((e) => e.node);

    // ── 2. target has only the implicit default variant → rebuild from source ─
    if (sourceRealOptions && tp.hasOnlyDefaultVariant) {
      const vdata = await gql(target, M_VARIANTS_BULK_CREATE, {
        productId: targetProductId,
        variants: sourceVariants.map((sv) =>
          variantBulkInput(sv, true, mfFor.get(sv)),
        ),
        strategy: "REMOVE_STANDALONE_VARIANT",
      });
      const verrs = vdata?.productVariantsBulkCreate?.userErrors;
      if (verrs?.length) {
        onLog(`  ⚠ Variant rebuild partial for ${label} — ${errText(verrs)}`);
      } else {
        onLog(`  + ${sourceVariants.length} variant(s) created for ${label}`);
      }
      await sleep(200);
      return;
    }

    // ── 3. match, update, and create what's missing ───────────────────────────
    const tBySku = new Map();
    const tBySig = new Map();
    for (const tv of targetVariants) {
      const sku = tv.sku?.trim();
      if (sku) tBySku.set(sku, tv);
      const sig = variantSignature(tv);
      if (sig && !tBySig.has(sig)) tBySig.set(sig, tv);
    }
    // with one variant on each side and no real options, they correspond
    const singleton =
      !sourceRealOptions &&
      targetVariants.length === 1 &&
      sourceVariants.length === 1;

    const updates = [];
    const creates = [];
    for (const sv of sourceVariants) {
      const sku = sv.sku?.trim();
      let tv = sku ? tBySku.get(sku) : null;
      if (!tv) {
        const sig = variantSignature(sv);
        if (sig) tv = tBySig.get(sig);
      }
      if (!tv && singleton) tv = targetVariants[0];

      if (tv) {
        updates.push({ id: tv.id, ...variantBulkInput(sv, false, mfFor.get(sv)) });
      } else if (sourceRealOptions) {
        // only meaningful with real options — otherwise there's nothing to
        // distinguish a second variant by
        creates.push(variantBulkInput(sv, true, mfFor.get(sv)));
      }
    }

    if (updates.length) {
      const vdata = await gql(target, M_VARIANTS_BULK_UPDATE, {
        productId: targetProductId,
        variants: updates,
      });
      const verrs = vdata?.productVariantsBulkUpdate?.userErrors;
      if (verrs?.length) {
        onLog(`  ⚠ Variant sync partial for ${label} — ${errText(verrs)}`);
      } else {
        onLog(`  ↻ ${updates.length} variant(s) synced`);
      }
    }

    if (creates.length) {
      const cdata = await gql(target, M_VARIANTS_BULK_CREATE, {
        productId: targetProductId,
        variants: creates,
        strategy: "DEFAULT",
      });
      const cerrs = cdata?.productVariantsBulkCreate?.userErrors;
      if (cerrs?.length) {
        onLog(`  ⚠ New variants partial for ${label} — ${errText(cerrs)}`);
      } else {
        onLog(`  + ${creates.length} new variant(s) added to ${label}`);
      }
    }
  } catch (err) {
    onLog(
      `  ⚠ Variant sync failed for ${label} — ${String(err.message).slice(0, 120)}`,
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
    const productMf = await metafieldsInput(ctx, p, { excludeSeo: true });
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
      metafields: productMf,
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
      let updated = false;
      try {
        const input = productUpdateInput(product, existing.id);
        let upd = await gql(target, M_PRODUCT_UPDATE, { product: input });
        let uerrs = upd?.productUpdate?.userErrors;

        // A single bad metafield (type mismatch with an existing target
        // definition, reserved key, …) rejects the whole mutation. Rather than
        // lose the product's core fields too, retry once without metafields.
        if (uerrs?.length && input.metafields?.length) {
          onLog(`  ⚠ ${p.title}: metafields rejected — ${errText(uerrs)}`);
          const { metafields, ...noMf } = input;
          void metafields;
          upd = await gql(target, M_PRODUCT_UPDATE, { product: noMf });
          uerrs = upd?.productUpdate?.userErrors;
        }

        if (uerrs?.length) {
          counters.failed++;
          onLog(`✕ Update failed: ${p.title} — ${errText(uerrs)}`);
        } else {
          updated = true;
          counters.updated++;
          onLog(`↻ Updated: ${p.title}`);
        }
      } catch (err) {
        counters.failed++;
        onLog(
          `✕ Update error: ${p.title} — ${String(err.message).slice(0, 160)}`,
        );
      }

      // Variants are synced independently of the product update: a metafield or
      // core-field problem above must not silently skip them.
      void updated;
      await syncVariants(ctx, existing.id, p);
      await sleep(200);
      continue;
    }

    if (!ctx.canCreate()) {
      counters.skipped++;
      onLog(`↪︎ Skipped (quota reached, not created): ${p.title}`);
      continue;
    }

    try {
      let data = await gql(target, M_PRODUCT_CREATE, { product, media });
      let errs = data?.productCreate?.userErrors;

      // same degradation as the update path: keep the product, drop the
      // metafields Shopify wouldn't accept
      if (errs?.length && product.metafields?.length) {
        onLog(`  ⚠ ${p.title}: metafields rejected — ${errText(errs)}`);
        const { metafields, ...noMf } = product;
        void metafields;
        data = await gql(target, M_PRODUCT_CREATE, { product: noMf, media });
        errs = data?.productCreate?.userErrors;
      }

      if (errs && errs.length) {
        counters.failed++;
        onLog(`✕ Failed: ${p.title} — ${errText(errs)}`);
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
              variants: await variantInputsFor(ctx, sourceVariants, true),
              strategy: "REMOVE_STANDALONE_VARIANT",
            });
            const verrs = vdata?.productVariantsBulkCreate?.userErrors;
            if (verrs?.length) {
              onLog(
                `  ⚠ Variants partial for ${p.title} — ${errText(verrs)}`,
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
                    ...(await variantInputsFor(ctx, [sourceVariants[0]], false))[0],
                  },
                ],
              });
              const verrs = vdata?.productVariantsBulkUpdate?.userErrors;
              if (verrs?.length) {
                onLog(
                  `  ⚠ Variant update failed for ${p.title} — ${errText(verrs)}`,
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

    const collectionMf = await metafieldsInput(ctx, c, { excludeSeo: true });
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
      metafields: collectionMf,
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
          onLog(`✕ Update failed: ${c.title} — ${errText(uerrs)}`);
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
        onLog(`✕ Failed: ${c.title} — ${errText(errs)}`);
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

// ═════════════════════════════════════════════════════════════════════════════
//  CROSS-STORE REFERENCE REMAPPING
//
//  A *_reference metafield stores a gid ("gid://shopify/MediaImage/123"), or a
//  JSON array of them for list.* types. Those ids are meaningless on the target,
//  so instead of dropping the metafield we resolve the SOURCE gid to what it
//  actually points at (a file's name, a product/collection/page handle, a
//  metaobject's type+handle, a variant's SKU) and look up the equivalent on the
//  TARGET. Anything we can't resolve is dropped rather than written broken.
// ═════════════════════════════════════════════════════════════════════════════
const Q_REFERENCED_NODES = `#graphql
  query RefNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on MediaImage { id image { url } }
      ... on GenericFile { id url }
      ... on Video { id filename sources { url format mimeType } }
      ... on Model3d { id filename sources { url format } }
      ... on ExternalVideo { id originUrl }
      ... on Product { id handle }
      ... on Collection { id handle }
      ... on Page { id handle }
      ... on Metaobject { id handle type }
      ... on ProductVariant { id sku }
    }
  }`;

// NB: no `pages(query:"handle:..")` here either — that filter is unreliable for
// exact handles (same class of bug as menus/blogs). Use a full listing.

const Q_TARGET_METAOBJECT_BY_HANDLE = `#graphql
  query TMetaobjectByHandle($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) { id }
  }`;

const Q_TARGET_VARIANT_BY_SKU = `#graphql
  query TVariantBySku($q: String!) {
    productVariants(first: 1, query: $q) { edges { node { id } } }
  }`;

// matches "file_reference" and "list.file_reference" alike
const REFERENCE_TYPE_RE = /(^|\.)[a-z0-9_]+_reference$/;

// filename/basename → target file gid, built once per run and kept warm as new
// files are uploaded (see migrateFiles)
async function getTargetFileIndex(ctx) {
  if (ctx._fileIndex) return ctx._fileIndex;
  const idx = new Map();
  try {
    const tfiles = await fetchAll(ctx.target, Q_FILES, "files");
    for (const tf of tfiles) {
      const { key } = describeFile(tf);
      if (key && tf.id) idx.set(key, tf.id);
    }
  } catch {
    /* no index — references just won't resolve */
  }
  ctx._fileIndex = idx;
  return idx;
}

// handle → target page gid, built once per run and shared with migratePages
async function getTargetPageIndex(ctx) {
  if (ctx._pageIndex) return ctx._pageIndex;
  const idx = new Map();
  try {
    const tpages = await fetchAll(ctx.target, Q_TARGET_PAGES_ALL, "pages");
    for (const tp of tpages) idx.set(tp.handle, tp.id);
  } catch {
    /* no index — page references just won't resolve */
  }
  ctx._pageIndex = idx;
  return idx;
}

// find the target-store equivalent of a resolved source node
async function findOnTarget(ctx, n) {
  const { target } = ctx;
  switch (n.__typename) {
    case "MediaImage":
    case "GenericFile":
    case "Video":
    case "Model3d":
    case "ExternalVideo": {
      const { key } = describeFile(n);
      if (!key) return null;
      const idx = await getTargetFileIndex(ctx);
      return idx.get(key) || null;
    }
    case "Product": {
      if (!n.handle) return null;
      const d = await gql(target, Q_TARGET_PRODUCT_ID_BY_HANDLE, {
        handle: n.handle,
      });
      return d?.productByHandle?.id || null;
    }
    case "Collection": {
      if (!n.handle) return null;
      const d = await gql(target, Q_TARGET_COLLECTION_BY_HANDLE, {
        handle: n.handle,
      });
      return d?.collectionByHandle?.id || null;
    }
    case "Page": {
      if (!n.handle) return null;
      const idx = await getTargetPageIndex(ctx);
      return idx.get(n.handle) || null;
    }
    case "Metaobject": {
      if (!n.type || !n.handle) return null;
      const d = await gql(target, Q_TARGET_METAOBJECT_BY_HANDLE, {
        handle: { type: n.type, handle: n.handle },
      });
      return d?.metaobjectByHandle?.id || null;
    }
    case "ProductVariant": {
      if (!n.sku) return null;
      const d = await gql(target, Q_TARGET_VARIANT_BY_SKU, {
        q: `sku:${qv(n.sku)}`,
      });
      return d?.productVariants?.edges?.[0]?.node?.id || null;
    }
    default:
      return null; // customer/company/order references etc. aren't mappable
  }
}

// source gid → target gid, memoised for the whole run (reference metafields
// repeat heavily across a catalogue)
async function mapGid(ctx, sourceGid) {
  ctx._gidMap = ctx._gidMap || new Map();
  if (ctx._gidMap.has(sourceGid)) return ctx._gidMap.get(sourceGid);
  let out = null;
  try {
    const d = await gql(ctx.source, Q_REFERENCED_NODES, { ids: [sourceGid] });
    const n = d?.nodes?.[0];
    if (n) out = await findOnTarget(ctx, n);
  } catch {
    out = null;
  }
  ctx._gidMap.set(sourceGid, out);
  return out;
}

// remap a whole reference metafield value; returns null if nothing resolved
async function remapReferenceValue(ctx, type, value) {
  const isList = String(type).startsWith("list.");
  let gids;
  if (isList) {
    try {
      gids = JSON.parse(String(value));
    } catch {
      return null;
    }
    if (!Array.isArray(gids)) return null;
  } else {
    gids = [value];
  }
  gids = gids.map((g) => String(g || "")).filter((g) => /^gid:\/\//.test(g));
  if (!gids.length) return null;

  const mapped = [];
  for (const g of gids) {
    const t = await mapGid(ctx, g);
    if (t) mapped.push(t);
  }
  if (!mapped.length) return null;
  return isList ? JSON.stringify(mapped) : mapped[0];
}

// Metafields we can recreate on the target, preserving namespace/key/value/type.
// App-reserved namespaces ("app", "app--…") are dropped — only the owning app
// may write them, and including one makes the target reject the whole payload.
// Reference types are remapped to target gids (above). Everything else passes
// through, including the reserved SEO keys global.title_tag /
// global.description_tag — that is how Page and Article SEO migrates at all,
// since neither type has an `seo` field in the Admin API.
// Reserved legacy SEO metafields. Products and Collections expose a real `seo`
// field which we already set, and writing the same data twice in one mutation
// makes Shopify reject the ENTIRE payload — which used to take the product's
// core fields and its variants down with it. Pages and Articles have no `seo`
// field, so for them these metafields ARE the SEO and must be kept.
function isReservedSeoMetafield(m) {
  return (
    m.namespace === "global" &&
    (m.key === "title_tag" || m.key === "description_tag")
  );
}

async function metafieldsInput(ctx, node, { excludeSeo = false } = {}) {
  const out = [];
  for (const e of node?.metafields?.edges || []) {
    const m = e.node;
    const ns = String(m.namespace || "");
    if (ns === "app" || ns.startsWith("app--")) continue;
    if (excludeSeo && isReservedSeoMetafield(m)) continue;

    const type = m.type || "";
    if (REFERENCE_TYPE_RE.test(type)) {
      const value = await remapReferenceValue(ctx, type, m.value);
      if (!value) continue; // unresolvable on target — drop, don't write broken
      out.push({ namespace: m.namespace, key: m.key, value, type });
      continue;
    }
    out.push({
      namespace: m.namespace,
      key: m.key,
      value: m.value,
      type,
    });
  }
  return out;
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

  // handle → id map of EXISTING target pages (reliable exact match, unlike the
  // search `query:` filter which can miss on exact handles). Shared with the
  // reference remapper so it's only fetched once per run.
  const targetPageMap = await getTargetPageIndex(ctx);

  for (const pg of pages) {
    if (ctx.stopOnQuota()) {
      onLog("Quota reached — stopping pages.");
      break;
    }
    const pageMf = await metafieldsInput(ctx, pg);
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
    const existingPageId = targetPageMap.get(pg.handle) || null;

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
          onLog(`✕ Update failed: ${pg.title} — ${errText(uerrs)}`);
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
        onLog(`↪︎ Skipped: ${pg.title} — ${errText(errs)}`);
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
        ... on Video { id filename sources { url format mimeType } }
        ... on Model3d { id filename sources { url format } }
        ... on ExternalVideo { id originUrl }
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

// MediaImage/GenericFile expose no filename, so dedupe on the CDN url's
// basename ("…/files/hero.jpg?v=1" → "hero.jpg"), which Shopify preserves on
// re-upload. Video/Model3d DO have a filename, which is more reliable.
function fileKeyFromUrl(url) {
  try {
    return new URL(url).pathname.split("/").pop() || null;
  } catch {
    return String(url).split("?")[0].split("/").pop() || null;
  }
}

// Identify a File node for cross-store matching, and describe how to re-upload
// it. Videos and 3D models aren't fetchable from `url` — their downloadable
// bytes live under `sources[].url` — which is why they used to be skipped.
function describeFile(f) {
  if (f.image?.url) {
    return { key: fileKeyFromUrl(f.image.url), source: f.image.url, contentType: "IMAGE" };
  }
  if (f.url) {
    return { key: fileKeyFromUrl(f.url), source: f.url, contentType: "FILE" };
  }
  if (f.sources?.length) {
    // prefer an mp4 for video; otherwise just take the first source
    const pick =
      f.sources.find((s) => /mp4/i.test(s.format || s.mimeType || "")) ||
      f.sources[0];
    const isModel = /glb|usdz/i.test(pick.format || "");
    return {
      key: f.filename || fileKeyFromUrl(pick.url),
      source: pick.url,
      contentType: isModel ? "MODEL_3D" : "VIDEO",
    };
  }
  if (f.originUrl) {
    return { key: f.originUrl, source: f.originUrl, contentType: "EXTERNAL_VIDEO" };
  }
  return { key: null, source: null, contentType: null };
}

async function migrateFiles(ctx) {
  const { source, target, onLog, counters, hasQuota, consume } = ctx;
  const files = await fetchAll(source, Q_FILES, "files", {}, (n) =>
    onLog(`Fetched ${n} files…`),
  );
  onLog(`Total ${files.length} files found. Importing…`);

  // existing target files, so a re-run doesn't duplicate the media library
  const targetIndex = await getTargetFileIndex(ctx);
  const existingKeys = new Set(targetIndex.keys());
  onLog(`${existingKeys.size} file(s) already on target.`);

  for (const f of files) {
    if (!hasQuota()) {
      onLog("Quota reached — stopping files.");
      break;
    }
    const { key, source: url, contentType } = describeFile(f);
    if (!url) {
      counters.skipped++;
      onLog("↪︎ Skipped file (no downloadable source)");
      continue;
    }
    if (key && existingKeys.has(key)) {
      counters.skipped++;
      onLog(`↪︎ Skipped (exists): ${key}`);
      continue;
    }
    // Shopify accepts an IMAGE or generic FILE straight from a URL, but a
    // VIDEO or MODEL_3D has to be pushed through stagedUploadsCreate — handing
    // it another store's CDN URL is always rejected ("Invalid video url").
    // Counting that as a failure told merchants something was broken and left
    // clean runs sitting at "partial"; say what actually has to happen instead.
    // EXTERNAL_VIDEO (YouTube/Vimeo) is just a link, so it still goes through.
    if (contentType === "VIDEO" || contentType === "MODEL_3D") {
      counters.skipped++;
      onLog(
        `↪︎ Skipped ${contentType === "VIDEO" ? "video" : "3D model"}${key ? `: ${key}` : ""} — Shopify does not allow copying these between stores; re-upload it in the target store's Content › Files.`,
      );
      continue;
    }
    try {
      const data = await gql(target, M_FILE_CREATE, {
        files: [
          {
            originalSource: url,
            alt: f.alt || "",
            contentType,
          },
        ],
      });
      const errs = data?.fileCreate?.userErrors;
      if (errs?.length) {
        counters.failed++;
        onLog(`✕ File failed — ${errText(errs)}`);
      } else {
        counters.created++;
        consume();
        const newId = data?.fileCreate?.files?.[0]?.id;
        if (key) {
          existingKeys.add(key);
          if (newId) targetIndex.set(key, newId); // resolvable by later references
        }
        onLog(`✓ File uploaded${key ? `: ${key}` : ""} (${contentType})`);
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
    // Shopify's own standard metaobject types (shopify--color-pattern,
    // shopify--flavor, …) are present on every store and cannot be created by
    // an app. This path had no reserved-type filter at all, so every run
    // carrying them logged an error and finished "partial".
    if (isReservedNamespace(def.type)) {
      onLog(`↪︎ Standard definition (already on every store): ${def.type}`);
      continue;
    }
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
        const msg = errText(derrs) || "";
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
        id name namespace key description pinnedPosition
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
    const copyable = defs.filter((d) => !isReservedNamespace(d.namespace));
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
            // Carry the source's pinned state. Unpinned definitions still hold
            // their values, but Shopify's product/article page only renders
            // PINNED ones — an unpinned copy reads as "No metafields pinned"
            // even though the data is there under "View all".
            pin: d.pinnedPosition != null,
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
          onLog(`↪︎ Skipped (exists): ${customerRef(c)}`);
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
        onLog(`↪︎ Skipped: ${customerRef(c)} — ${errText(errs)}`);
      } else {
        counters.created++;
        consume();
        onLog(`✓ Customer: ${customerRef(c)}`);
      }
    } catch (err) {
      counters.failed++;
      onLog(
        `✕ Customer error: ${customerRef(c)} — ${String(err.message).slice(0, 120)}`,
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
        onLog(`↪︎ Skipped: ${o.name} — ${errText(errs)}`);
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
        onLog(`↪︎ Skipped: ${o.name} — ${errText(errs)}`);
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
          onLog(`✕ Update failed: ${r.path} — ${errText(uerrs)}`);
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
        onLog(`↪︎ Skipped: ${r.path} — ${errText(errs)}`);
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

// Same trap as menus: `blogs(query:)` has no `handle:` term, so the filter was
// ignored and the FIRST blog came back for every source blog — which silently
// filed every article into the wrong blog. Match exactly against a full listing.
const Q_TARGET_BLOGS_ALL = `#graphql
  query TargetBlogs($cursor: String) {
    blogs(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id handle } }
    }
  }`;

const M_BLOG_CREATE = `#graphql
  mutation CreateBlog($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) {
      blog { id handle }
      userErrors { field message }
    }
  }`;

// Shopify fetches an article's featured image itself, from the source store's
// CDN, while the mutation runs. When that fetch times out it rejects the whole
// article — so a slow image silently costs the merchant the entire post. The
// text is worth far more than the picture, so callers retry without the image
// when this is what went wrong.
function isImageFetchError(errs) {
  return (errs || []).some((e) =>
    /image upload failed|failed to download|image .*(timeout|could not be)/i.test(
      String(e?.message || ""),
    ),
  );
}

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

  // handle → id map of existing target blogs (see Q_TARGET_BLOGS_ALL)
  const targetBlogs = new Map();
  try {
    const existing = await fetchAll(target, Q_TARGET_BLOGS_ALL, "blogs");
    for (const tb of existing) targetBlogs.set(tb.handle, tb.id);
  } catch {
    /* couldn't list — blogs will be created below as needed */
  }

  for (const blog of blogs) {
    // ensure a blog with this handle exists on the target (exact match)
    let targetBlogId = targetBlogs.get(blog.handle) ?? null;

    if (!targetBlogId) {
      try {
        const created = await gql(target, M_BLOG_CREATE, {
          blog: { title: blog.title, handle: blog.handle },
        });
        const berrs = created?.blogCreate?.userErrors;
        targetBlogId = created?.blogCreate?.blog?.id ?? null;
        if (targetBlogId) {
          targetBlogs.set(blog.handle, targetBlogId);
          onLog(`✓ Blog ready: ${blog.title}`);
        } else if (berrs?.length) {
          onLog(`✕ Blog failed: ${blog.title} — ${errText(berrs)}`);
        }
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
      const articleMf = await metafieldsInput(ctx, a);
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
          let upd = await gql(target, M_ARTICLE_UPDATE, {
            id: existingArticleId,
            article: articleNoBlog,
          });
          let uerrs = upd?.articleUpdate?.userErrors;

          // Same trade as the create path: keep the post's text up to date
          // even when its image can't be re-fetched.
          if (uerrs?.length && articleNoBlog.image && isImageFetchError(uerrs)) {
            const noImage = { ...articleNoBlog };
            delete noImage.image;
            upd = await gql(target, M_ARTICLE_UPDATE, {
              id: existingArticleId,
              article: noImage,
            });
            uerrs = upd?.articleUpdate?.userErrors;
            if (!uerrs?.length) {
              counters.updated++;
              onLog(
                `↻ Updated: ${a.title} — ⚠ featured image left as it was, Shopify couldn't fetch the new one.`,
              );
              await sleep(160);
              continue;
            }
          }

          if (uerrs?.length) {
            counters.failed++;
            onLog(`✕ Update failed: ${a.title} — ${errText(uerrs)}`);
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
        let data = await gql(target, M_ARTICLE_CREATE, { article });
        let errs = data?.articleCreate?.userErrors;

        // Losing a whole post because its picture was slow to download is the
        // wrong trade. Try again without the image and tell the merchant which
        // posts need one re-attached.
        if (errs?.length && article.image && isImageFetchError(errs)) {
          const articleNoImage = { ...article };
          delete articleNoImage.image;
          data = await gql(target, M_ARTICLE_CREATE, {
            article: articleNoImage,
          });
          errs = data?.articleCreate?.userErrors;
          if (!errs?.length) {
            counters.created++;
            consume();
            onLog(
              `✓ Article: ${a.title} — ⚠ featured image skipped, Shopify couldn't fetch it in time; re-add it in the target store.`,
            );
            await sleep(160);
            continue;
          }
        }

        if (errs?.length) {
          counters.skipped++;
          onLog(`↪︎ Skipped article: ${a.title} — ${errText(errs)}`);
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

// Exact-match handle lookup via a full listing. The `menus(query:)` filter does
// NOT support a `handle:` term — it silently ignores the unsupported term and
// returns the store's FIRST menu, so every source menu looked like it already
// existed on the target and nothing was ever created.
const Q_TARGET_MENUS_ALL = `#graphql
  query TargetMenus($cursor: String) {
    menus(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id handle } }
    }
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

  // handle → id map of existing target menus (exact match; see Q_TARGET_MENUS_ALL)
  const targetMenus = new Map();
  try {
    const existing = await fetchAll(target, Q_TARGET_MENUS_ALL, "menus");
    for (const tm of existing) targetMenus.set(tm.handle, tm.id);
    onLog(`${targetMenus.size} menu(s) already on target.`);
  } catch {
    /* couldn't list — fall through and attempt every create */
  }

  for (const m of menus) {
    if (!hasQuota()) {
      onLog("Quota reached — stopping menus.");
      break;
    }
    if (targetMenus.has(m.handle)) {
      counters.skipped++;
      onLog(`↪︎ Skipped (exists): ${m.title} [${m.handle}]`);
      continue;
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
        onLog(`✕ Failed: ${m.title} — ${errText(errs)}`);
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
          onLog(`↪︎ Skipped: ${d.title} — ${errText(errs)}`);
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
          onLog(`↪︎ Skipped: ${d.title} — ${errText(errs)}`);
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
          onLog(`↪︎ Skipped: ${d.title} — ${errText(errs)}`);
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
          onLog(`↪︎ Skipped: ${d.title} — ${errText(errs)}`);
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
          onLog(`↪︎ Skipped: ${d.title} — ${errText(errs)}`);
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
          onLog(`↪︎ Skipped: ${d.title} — ${errText(errs)}`);
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

// Order matters:
//  • metafield/metaobject definitions first so copied field values stick;
//  • files BEFORE products/collections/pages, so file_reference metafields have
//    something on the target to resolve to (they used to run after, which made
//    every file reference unresolvable);
//  • products before collections so manual-collection membership (#7) can
//    resolve its members by handle on the target;
//  • menus after the resources they link to.
// All cross-references use live handle/SKU/filename lookups, not stored maps.
const RUN_ORDER = [
  "metafields",
  "files",
  "metaobjects",
  "products",
  "collections",
  "pages",
  "blogPosts",
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
  // Fired for every item that consumes quota, as it happens. The caller uses
  // this to bill quota incrementally: a run that dies part-way (machine
  // restart, deploy, crash) must still be charged for what it already created,
  // otherwise the whole run is free.
  onConsume = () => {},
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
    onConsume(type);
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

  // NOTE: theme migration was removed deliberately. It needs the `read_themes`
  // scope, which this app does not request, so every run logged an access-denied
  // error and copied nothing. `templateSuffix` values still migrate with
  // products/collections/pages/articles; they simply resolve against whatever
  // theme the merchant already has on the target.

  const ordered = RUN_ORDER.filter((t) => types.includes(t));
  // Per-type created/updated/skipped/failed, taken as the delta across each
  // module's run. The 88 places that bump `counters` stay untouched: only the
  // orchestrator knows which type is executing, and it already serialises them
  // one module at a time, so before/after subtraction attributes every count
  // correctly without threading a type through every runner.
  const statsByType = {};
  for (const t of ordered) {
    currentType = t;
    onLog(`── ${t.toUpperCase()} ──`);
    const before = { ...counters };
    try {
      await RUNNERS[t](ctx);
    } catch (err) {
      onLog(`✕ ${t} module failed: ${String(err.message).slice(0, 160)}`);
    }
    statsByType[t] = {
      created: counters.created - before.created,
      updated: counters.updated - before.updated,
      skipped: counters.skipped - before.skipped,
      failed: counters.failed - before.failed,
    };
  }

  const total =
    counters.created + counters.updated + counters.skipped + counters.failed;

  const consumedTotal = Object.values(consumed).reduce((a, b) => a + b, 0);

  return {
    ...counters,
    total,
    consumed: consumedTotal,
    consumedByType: consumed, // { products: 5, collections: 3, ... }
    // { products: { created, updated, skipped, failed }, collections: {…} }
    statsByType,
    summary: `${counters.created} created · ${counters.updated} updated · ${counters.skipped} skipped · ${counters.failed} failed`,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  PREVIEW (counts only — no writes)
// ═════════════════════════════════════════════════════════════════════════════
// Only these have a *Count field on QueryRoot (verified against the 2025-10
// schema). files, menus, metaobjects, metafields and blogPosts have none —
// blogsCount exists but counts blogs, not the articles this app migrates — so
// they are reported as "counted during the run" rather than a bogus number.
const COUNT_QUERIES = {
  products: `#graphql { productsCount { count } }`,
  collections: `#graphql { collectionsCount { count } }`,
  pages: `#graphql { pagesCount { count } }`,
  discounts: `#graphql { discountNodesCount { count } }`,
  redirects: `#graphql { urlRedirectsCount { count } }`,
  orders: `#graphql { ordersCount { count } }`,
  customers: `#graphql { customersCount { count } }`,
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
        // Most likely a missing scope (orders/customers need Protected
        // Customer Data approval). Say so instead of showing a bare dash.
        result[t] = { source: null, target: null, note: "unavailable" };
      }
    } else {
      result[t] = { source: null, target: null, note: "counted during run" };
    }
  }
  return result;
}
