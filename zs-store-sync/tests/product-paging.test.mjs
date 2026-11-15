import { test } from "node:test";
import assert from "node:assert/strict";
import { completeProduct, mediaInputs, chunk, MAX_VARIANTS } from "../app/lib/product-paging.js";

// A fake source store: `total` variants, served `page` at a time.
function fakeStore(total, page, field = "variants") {
  const all = Array.from({ length: total }, (_, i) => ({ node: { sku: `SKU-${i}` } }));
  const calls = [];
  const fetchPage = async (f, id, cursor) => {
    calls.push([f, id, cursor]);
    assert.equal(f, field);
    const start = Number(cursor);
    const edges = all.slice(start, start + page);
    const end = start + edges.length;
    return { edges, pageInfo: { hasNextPage: end < total, endCursor: String(end) } };
  };
  const first = all.slice(0, Math.min(100, total));
  return {
    product: {
      id: "gid://shopify/Product/1",
      [field]: { edges: [...first], pageInfo: { hasNextPage: total > 100, endCursor: String(first.length) } },
    },
    fetchPage,
    calls,
    all,
  };
}

test("reads every variant up to 2,048", async () => {
  const s = fakeStore(2048, 100);
  const extra = await completeProduct(s.product, s.fetchPage);
  assert.equal(s.product.variants.edges.length, 2048);
  assert.equal(extra.variants, 1948);
  assert.equal(s.product.variants.edges[2047].node.sku, "SKU-2047");
  assert.equal(new Set(s.product.variants.edges.map((e) => e.node.sku)).size, 2048);
  assert.equal(s.product.variants.pageInfo.hasNextPage, false);
  assert.equal(MAX_VARIANTS, 2048);
});

test("a product with one page makes no extra calls", async () => {
  const s = fakeStore(37, 100);
  await completeProduct(s.product, s.fetchPage);
  assert.equal(s.calls.length, 0);
  assert.equal(s.product.variants.edges.length, 37);
});

test("exactly 100 variants (a full first page, no next page) makes no extra calls", async () => {
  const s = fakeStore(100, 100);
  await completeProduct(s.product, s.fetchPage);
  assert.equal(s.calls.length, 0);
  assert.equal(s.product.variants.edges.length, 100);
});

test("101 variants reads one more page", async () => {
  const s = fakeStore(101, 100);
  await completeProduct(s.product, s.fetchPage);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0][2], "100");
  assert.equal(s.product.variants.edges.length, 101);
});

test("media and metafields page too", async () => {
  const m = fakeStore(260, 100, "media");
  await completeProduct(m.product, m.fetchPage);
  assert.equal(m.product.media.edges.length, 260);
  const mf = fakeStore(130, 100, "metafields");
  await completeProduct(mf.product, mf.fetchPage);
  assert.equal(mf.product.metafields.edges.length, 130);
});

test("a cursor that never ends is cut off instead of looping", async () => {
  const product = {
    id: "p",
    variants: { edges: [], pageInfo: { hasNextPage: true, endCursor: "x" } },
  };
  let n = 0;
  await completeProduct(product, async () => {
    n++;
    return { edges: [{ node: {} }], pageInfo: { hasNextPage: true, endCursor: "x" } };
  });
  assert.ok(n <= 40);
  assert.equal(product.variants.pageInfo.hasNextPage, true);
});

test("an error while paging is thrown, not swallowed", async () => {
  const s = fakeStore(300, 100);
  await assert.rejects(
    completeProduct(s.product, async () => {
      throw new Error("THROTTLED");
    }),
    /THROTTLED/,
  );
});

test("media split: images and external videos copy, hosted videos and models are counted", () => {
  const { copy, manual } = mediaInputs({
    media: {
      edges: [
        { node: { mediaContentType: "IMAGE", alt: "a", image: { url: "https://cdn/x.jpg" } } },
        { node: { mediaContentType: "IMAGE", alt: "", image: null } },
        { node: { mediaContentType: "EXTERNAL_VIDEO", alt: "v", originUrl: "https://youtu.be/1" } },
        { node: { mediaContentType: "VIDEO" } },
        { node: { mediaContentType: "MODEL_3D" } },
        { node: { mediaContentType: "MODEL_3D" } },
      ],
    },
  });
  assert.deepEqual(copy, [
    { originalSource: "https://cdn/x.jpg", alt: "a", mediaContentType: "IMAGE" },
    { originalSource: "https://youtu.be/1", alt: "v", mediaContentType: "EXTERNAL_VIDEO" },
  ]);
  assert.deepEqual(manual, { videos: 1, models: 2 });
});

test("chunk", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
  assert.equal(chunk(Array.from({ length: 2048 }), 250).length, 9);
});
