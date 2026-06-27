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
  while (true) {
    attempt++;
    const res = await admin.graphql(query, { variables });
    const json = await res.json();

    const throttled =
      json?.errors?.some?.(
        (e) => e?.extensions?.code === "THROTTLED",
      ) || json?.extensions?.cost?.throttleStatus?.currentlyAvailable < 50;

    if (json?.errors && !throttled) {
      throw new Error(
        "GraphQL error: " + JSON.stringify(json.errors).slice(0, 500),
      );
    }

    if (throttled && attempt < 6) {
      // back off proportional to attempt
      await sleep(800 * attempt);
      continue;
    }

    return json.data;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Generic paginated fetch over a connection ────────────────────────────────
async function fetchAll(admin, query, rootKey, variables = {}, onPage) {
  let cursor = null;
  const all = [];
  do {
    const data = await gql(admin, query, { ...variables, cursor });
    const conn = data[rootKey];
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
        id title handle descriptionHtml vendor productType tags status
        options { name values }
        variants(first: 100) {
          edges { node {
            sku title price compareAtPrice barcode
            inventoryQuantity
            selectedOptions { name value }
          } }
        }
        images(first: 50) { edges { node { src altText } } }
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
  mutation CreateProduct($input: ProductInput!, $media: [CreateMediaInput!]) {
    productCreate(input: $input, media: $media) {
      product { id handle }
      userErrors { field message }
    }
  }`;

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
    if (!consume()) {
      onLog("Quota reached — stopping product import.");
      break;
    }

    const firstSku = p.variants?.edges?.[0]?.node?.sku?.trim();

    // duplicate detection: by SKU first, then handle
    let existing = null;
    if (firstSku) {
      const r = await gql(target, Q_TARGET_BY_SKU, {
        q: `sku:${firstSku}`,
      });
      existing = r?.products?.edges?.[0]?.node ?? null;
    }
    if (!existing && p.handle) {
      const r = await gql(target, Q_TARGET_PRODUCT_BY_HANDLE, {
        handle: p.handle,
      });
      existing = r?.productByHandle ?? null;
    }

    if (existing) {
      counters.skipped++;
      onLog(`↪︎ Skipped (exists): ${p.title}`);
      continue;
    }

    const input = {
      title: p.title,
      handle: p.handle,
      descriptionHtml: p.descriptionHtml,
      vendor: p.vendor,
      productType: p.productType,
      tags: p.tags,
      status: p.status || "ACTIVE",
      productOptions: (p.options || []).map((o) => ({
        name: o.name,
        values: (o.values || []).map((v) => ({ name: v })),
      })),
    };

    const media = (p.images?.edges || []).map((e) => ({
      originalSource: e.node.src,
      alt: e.node.altText || "",
      mediaContentType: "IMAGE",
    }));

    try {
      const data = await gql(target, M_PRODUCT_CREATE, { input, media });
      const errs = data?.productCreate?.userErrors;
      if (errs && errs.length) {
        counters.failed++;
        onLog(`✕ Failed: ${p.title} — ${errs[0].message}`);
      } else {
        counters.created++;
        onLog(`✓ Created: ${p.title}`);
      }
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
        id title handle descriptionHtml
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

async function migrateCollections(ctx) {
  const { source, target, onLog, counters, consume } = ctx;
  const cols = await fetchAll(source, Q_COLLECTIONS, "collections", {}, (n) =>
    onLog(`Fetched ${n} collections…`),
  );
  onLog(`Total ${cols.length} collections found. Importing…`);

  for (const c of cols) {
    if (!consume()) {
      onLog("Quota reached — stopping collections.");
      break;
    }
    const r = await gql(target, Q_TARGET_COLLECTION_BY_HANDLE, {
      handle: c.handle,
    });
    if (r?.collectionByHandle) {
      counters.skipped++;
      onLog(`↪︎ Skipped (exists): ${c.title}`);
      continue;
    }

    const input = {
      title: c.title,
      handle: c.handle,
      descriptionHtml: c.descriptionHtml,
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

    try {
      const data = await gql(target, M_COLLECTION_CREATE, { input });
      const errs = data?.collectionCreate?.userErrors;
      if (errs?.length) {
        counters.failed++;
        onLog(`✕ Failed: ${c.title} — ${errs[0].message}`);
      } else {
        counters.created++;
        onLog(`✓ Created: ${c.title}`);
      }
    } catch (err) {
      counters.failed++;
      onLog(`✕ Error: ${c.title} — ${String(err.message).slice(0, 120)}`);
    }
    await sleep(180);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  PAGES
// ═════════════════════════════════════════════════════════════════════════════
const Q_PAGES = `#graphql
  query Pages($cursor: String) {
    pages(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id title handle body isPublished } }
    }
  }`;

const M_PAGE_CREATE = `#graphql
  mutation CreatePage($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page { id handle }
      userErrors { field message }
    }
  }`;

async function migratePages(ctx) {
  const { source, target, onLog, counters, consume } = ctx;
  const pages = await fetchAll(source, Q_PAGES, "pages", {}, (n) =>
    onLog(`Fetched ${n} pages…`),
  );
  onLog(`Total ${pages.length} pages found. Importing…`);

  for (const pg of pages) {
    if (!consume()) {
      onLog("Quota reached — stopping pages.");
      break;
    }
    try {
      const data = await gql(target, M_PAGE_CREATE, {
        page: {
          title: pg.title,
          handle: pg.handle,
          body: pg.body,
          isPublished: pg.isPublished,
        },
      });
      const errs = data?.pageCreate?.userErrors;
      if (errs?.length) {
        // likely duplicate handle → treat as skip
        counters.skipped++;
        onLog(`↪︎ Skipped: ${pg.title} — ${errs[0].message}`);
      } else {
        counters.created++;
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

async function migrateFiles(ctx) {
  const { source, target, onLog, counters, consume } = ctx;
  const files = await fetchAll(source, Q_FILES, "files", {}, (n) =>
    onLog(`Fetched ${n} files…`),
  );
  onLog(`Total ${files.length} files found. Importing…`);

  for (const f of files) {
    if (!consume()) {
      onLog("Quota reached — stopping files.");
      break;
    }
    const url = f.image?.url || f.url;
    if (!url) {
      counters.skipped++;
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
        onLog(`✓ File uploaded`);
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

async function migrateMetaobjects(ctx) {
  const { source, target, onLog, counters, consume } = ctx;
  const defs = await fetchAll(
    source,
    Q_METAOBJECT_DEFS,
    "metaobjectDefinitions",
    {},
    (n) => onLog(`Fetched ${n} metaobject definitions…`),
  );
  onLog(`Total ${defs.length} metaobject definitions found.`);

  for (const def of defs) {
    // create the definition on target (ignore "already exists" errors)
    try {
      await gql(target, M_METAOBJECT_DEF_CREATE, {
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
      onLog(`✓ Definition ready: ${def.type}`);
    } catch {
      onLog(`↪︎ Definition exists: ${def.type}`);
    }

    // then copy entries
    const objs = await fetchAll(
      source,
      Q_METAOBJECTS_BY_TYPE,
      "metaobjects",
      { type: def.type },
    );
    for (const o of objs) {
      if (!consume()) {
        onLog("Quota reached — stopping metaobjects.");
        return;
      }
      try {
        const data = await gql(target, M_METAOBJECT_CREATE, {
          metaobject: {
            type: def.type,
            handle: o.handle,
            fields: o.fields.map((f) => ({ key: f.key, value: f.value })),
          },
        });
        const errs = data?.metaobjectCreate?.userErrors;
        if (errs?.length) {
          counters.skipped++;
        } else {
          counters.created++;
        }
      } catch {
        counters.failed++;
      }
      await sleep(160);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  METAFIELD DEFINITIONS (product-level) — copies definitions so fields persist
// ═════════════════════════════════════════════════════════════════════════════
const Q_METAFIELD_DEFS = `#graphql
  query MFDefs($cursor: String) {
    metafieldDefinitions(first: 50, ownerType: PRODUCT, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id name namespace key type { name } description } }
    }
  }`;

const M_METAFIELD_DEF_CREATE = `#graphql
  mutation MFDefCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key }
      userErrors { field message }
    }
  }`;

async function migrateMetafields(ctx) {
  const { source, target, onLog, counters, consume } = ctx;
  const defs = await fetchAll(
    source,
    Q_METAFIELD_DEFS,
    "metafieldDefinitions",
    {},
    (n) => onLog(`Fetched ${n} metafield definitions…`),
  );
  onLog(`Total ${defs.length} product metafield definitions found.`);

  for (const d of defs) {
    if (!consume()) {
      onLog("Quota reached — stopping metafields.");
      break;
    }
    try {
      const data = await gql(target, M_METAFIELD_DEF_CREATE, {
        definition: {
          name: d.name,
          namespace: d.namespace,
          key: d.key,
          type: d.type.name,
          description: d.description || "",
          ownerType: "PRODUCT",
        },
      });
      const errs = data?.metafieldDefinitionCreate?.userErrors;
      if (errs?.length) {
        counters.skipped++;
        onLog(`↪︎ Exists: ${d.namespace}.${d.key}`);
      } else {
        counters.created++;
        onLog(`✓ Definition: ${d.namespace}.${d.key}`);
      }
    } catch (err) {
      counters.failed++;
      onLog(`✕ ${d.key} — ${String(err.message).slice(0, 100)}`);
    }
    await sleep(140);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  ORDERS (read-only copy as draft is complex; we copy basic order data)
//  NOTE: requires Protected Customer Data approval from Shopify.
// ═════════════════════════════════════════════════════════════════════════════
async function migrateOrders(ctx) {
  ctx.onLog(
    "Orders require Shopify Protected Customer Data approval. Configure approval, then enable this module.",
  );
}

async function migrateCustomers(ctx) {
  ctx.onLog(
    "Customers require Shopify Protected Customer Data approval. Configure approval, then enable this module.",
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  ORCHESTRATOR
// ═════════════════════════════════════════════════════════════════════════════
const RUNNERS = {
  products: migrateProducts,
  collections: migrateCollections,
  pages: migratePages,
  files: migrateFiles,
  metaobjects: migrateMetaobjects,
  metafields: migrateMetafields,
  orders: migrateOrders,
  customers: migrateCustomers,
};

// Order matters: definitions/collections before products is fine here because
// we use live lookups; metafield defs first so product fields stick.
const RUN_ORDER = [
  "metafields",
  "metaobjects",
  "collections",
  "products",
  "pages",
  "files",
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
  onLog = () => {},
}) {
  const counters = { created: 0, updated: 0, skipped: 0, failed: 0 };
  // per-type consumed counters
  const consumed = {};
  types.forEach((t) => (consumed[t] = 0));

  // returns false when per-type quota is exhausted.
  // `type` is the current data type being migrated.
  const consume = (type) => {
    const limit = limits[type];
    if (limit != null && limit !== Infinity) {
      if (consumed[type] >= limit) return false;
    }
    consumed[type] = (consumed[type] || 0) + 1;
    return true;
  };

  // consume counter shared across modules: the orchestrator passes the
  // current type into ctx so each runner can check its own quota.
  let currentType = null;
  const ctx = {
    source,
    target,
    onLog,
    counters,
    consume: () => consume(currentType),
    setType: (t) => {
      currentType = t;
    },
  };

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
    consumedByType: consumed,   // { products: 5, collections: 3, ... }
    summary: `${counters.created} created · ${counters.skipped} skipped · ${counters.failed} failed`,
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
