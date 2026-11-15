// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — read a whole product, not just its first page
//
//  The products list query reads the first 100 variants, 50 media and 50
//  metafields of each product. Shopify allows 2,048 variants, so anything past
//  the first page used to be dropped without a word. completeProduct() keeps
//  asking for the next page of each connection until there is none.
//
//  `fetchPage(field, productId, cursor)` returns that connection
//  ({ pageInfo, edges }) for one product; injected so this file stays pure
//  and testable.
// ═════════════════════════════════════════════════════════════════════════════

export const MAX_VARIANTS = 2048;
// generous ceilings so a broken cursor can never loop forever
const MAX_PAGES = { variants: 40, media: 40, metafields: 40 };

async function drain(product, field, fetchPage) {
  const conn = product[field];
  if (!conn?.pageInfo?.hasNextPage) return 0;
  let cursor = conn.pageInfo.endCursor;
  let pages = 0;
  let added = 0;
  while (cursor && pages < MAX_PAGES[field]) {
    pages++;
    const next = await fetchPage(field, product.id, cursor);
    const edges = next?.edges || [];
    conn.edges.push(...edges);
    added += edges.length;
    cursor = next?.pageInfo?.hasNextPage ? next.pageInfo.endCursor : null;
  }
  conn.pageInfo = { hasNextPage: !!cursor, endCursor: cursor };
  return added;
}

// Mutates and returns `product`, with every variant, media item and metafield.
// → { variants, media, metafields } = how many extra were read.
export async function completeProduct(product, fetchPage) {
  const extra = { variants: 0, media: 0, metafields: 0 };
  for (const field of ["variants", "media", "metafields"]) {
    extra[field] = await drain(product, field, fetchPage);
  }
  return extra;
}

// Split product media into what can be copied by URL and what can't.
//  - images (MediaImage) and YouTube/Vimeo links (ExternalVideo) copy by URL
//  - Shopify-hosted videos and 3D models have to be uploaded again by hand:
//    Shopify refuses another store's CDN URL for them
export function mediaInputs(product) {
  const copy = [];
  const manual = { videos: 0, models: 0 };
  for (const e of product.media?.edges || []) {
    const m = e.node || {};
    const alt = m.alt || "";
    if (m.mediaContentType === "IMAGE") {
      const url = m.image?.url;
      if (url) copy.push({ originalSource: url, alt, mediaContentType: "IMAGE" });
    } else if (m.mediaContentType === "EXTERNAL_VIDEO") {
      if (m.originUrl) copy.push({ originalSource: m.originUrl, alt, mediaContentType: "EXTERNAL_VIDEO" });
    } else if (m.mediaContentType === "VIDEO") {
      manual.videos++;
    } else if (m.mediaContentType === "MODEL_3D") {
      manual.models++;
    }
  }
  return { copy, manual };
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
