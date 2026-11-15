import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeSnapshot,
  decodeSnapshot,
  metafieldBefore,
  productSnapshot,
  productWouldChange,
  productRestoreInputs,
  collectionSnapshot,
  collectionWouldChange,
  collectionRestoreInput,
  pageSnapshot,
  pageWouldChange,
  pageRestoreInput,
} from "../app/lib/backup-core.js";

const target = {
  title: "Shirt",
  handle: "shirt",
  descriptionHtml: "<p>Old</p>",
  vendor: "Acme",
  productType: "Tops",
  tags: ["b", "a"],
  status: "ACTIVE",
  templateSuffix: null,
  seo: { title: "S", description: null },
  metafields: { edges: [{ node: { namespace: "custom", key: "fit", type: "single_line_text_field", value: "slim" } }] },
  variants: {
    edges: [
      { node: { id: "V1", price: "10.00", compareAtPrice: null, sku: "S-1", barcode: "111", inventoryItem: { measurement: { weight: { value: 1, unit: "KILOGRAMS" } } } } },
      { node: { id: "V2", price: "12.00", compareAtPrice: "15.00", sku: "S-2", barcode: "", inventoryItem: null } },
    ],
  },
};
const written = [
  { namespace: "custom", key: "fit", type: "single_line_text_field", value: "slim" },
  { namespace: "custom", key: "care", type: "single_line_text_field", value: "wash" },
];

test("snapshots survive compression", () => {
  const snap = productSnapshot(target, written);
  const back = decodeSnapshot(encodeSnapshot(snap));
  assert.deepEqual(back, snap);
  assert.ok(encodeSnapshot({ big: "x".repeat(10000) }).length < 200);
});

test("metafields the sync adds are recorded as absent", () => {
  const before = metafieldBefore(written, target.metafields.edges.map((e) => e.node));
  assert.deepEqual(before, [
    { namespace: "custom", key: "fit", type: "single_line_text_field", value: "slim" },
    { namespace: "custom", key: "care", absent: true },
  ]);
});

const sameInput = {
  title: "Shirt",
  handle: "shirt",
  descriptionHtml: "<p>Old</p>",
  vendor: "Acme",
  productType: "Tops",
  tags: ["a", "b"],
  status: "ACTIVE",
  templateSuffix: null,
  seo: { title: "S" },
  metafields: [written[0]],
};
const sameVariants = [
  { price: "10.00", compareAtPrice: undefined, sku: "S-1", barcode: "111" },
  { price: "12.00", compareAtPrice: "15.00", sku: "S-2", barcode: "" },
];

test("an identical sync is not backed up", () => {
  const snap = productSnapshot(target, sameInput.metafields);
  assert.equal(productWouldChange(snap, sameInput, sameVariants), false);
});

test("any changed field, metafield or variant is backed up", () => {
  const snap = productSnapshot(target, written);
  assert.equal(productWouldChange(snap, { ...sameInput, metafields: written }, sameVariants), true); // adds "care"
  const snap1 = productSnapshot(target, sameInput.metafields);
  assert.equal(productWouldChange(snap1, { ...sameInput, title: "Shirt 2" }, sameVariants), true);
  assert.equal(productWouldChange(snap1, { ...sameInput, tags: ["a"] }, sameVariants), true);
  assert.equal(productWouldChange(snap1, sameInput, [{ ...sameVariants[0], price: "11.00" }, sameVariants[1]]), true);
  assert.equal(productWouldChange(snap1, sameInput, [sameVariants[0]]), true); // variant count
  // keep-target-prices sends no price: not a change
  assert.equal(productWouldChange(snap1, sameInput, sameVariants.map(({ price, compareAtPrice, ...r }) => r)), false);
});

test("product restore puts back fields, variants that still exist, and metafields", () => {
  const snap = productSnapshot(target, written);
  const { product, variants, metafields } = productRestoreInputs("P1", snap, ["V1", "V3"]);
  assert.equal(product.id, "P1");
  assert.equal(product.descriptionHtml, "<p>Old</p>");
  assert.deepEqual(product.tags, ["b", "a"]);
  assert.equal(variants.length, 1); // V2 no longer exists
  assert.deepEqual(variants[0], {
    id: "V1",
    price: "10.00",
    compareAtPrice: null,
    barcode: "111",
    inventoryItem: { sku: "S-1", measurement: { weight: { value: 1, unit: "KILOGRAMS" } } },
  });
  assert.deepEqual(metafields.set, [{ ownerId: "P1", namespace: "custom", key: "fit", type: "single_line_text_field", value: "slim" }]);
  assert.deepEqual(metafields.remove, [{ ownerId: "P1", namespace: "custom", key: "care" }]);
});

test("collections: snapshot, change check and restore", () => {
  const tc = {
    title: "Sale",
    handle: "sale",
    descriptionHtml: "",
    templateSuffix: null,
    seo: {},
    image: { url: "https://cdn/files/a.jpg?v=1", altText: "A" },
    ruleSet: { appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: "sale" }] },
    metafields: { edges: [] },
  };
  const snap = collectionSnapshot(tc, []);
  const input = { title: "Sale", handle: "sale", descriptionHtml: "", templateSuffix: null, image: { src: "https://cdn2/files/a.jpg?v=9" } };
  assert.equal(collectionWouldChange(snap, input, tc.ruleSet), false);
  assert.equal(collectionWouldChange(snap, { ...input, title: "Big sale" }, tc.ruleSet), true);
  assert.equal(collectionWouldChange(snap, input, { rules: [] }), true);
  assert.equal(collectionWouldChange(snap, { ...input, image: { src: "https://cdn/b.jpg" } }, null), true);
  const r = collectionRestoreInput("C1", snap);
  assert.deepEqual(r.collection.image, { src: "https://cdn/files/a.jpg?v=1", altText: "A" });
});

test("pages: snapshot, change check and restore", () => {
  const tp = { title: "About", handle: "about", body: "<p>x</p>", isPublished: true, templateSuffix: "", metafields: { edges: [] } };
  const snap = pageSnapshot(tp, []);
  assert.equal(pageWouldChange(snap, { title: "About", handle: "about", body: "<p>x</p>", isPublished: true, templateSuffix: null }), false);
  assert.equal(pageWouldChange(snap, { title: "About", handle: "about", body: "<p>y</p>", isPublished: true }), true);
  assert.equal(pageWouldChange(snap, { title: "About", isPublished: false }), true);
  const r = pageRestoreInput("PG1", snap);
  assert.deepEqual(r, {
    id: "PG1",
    page: { title: "About", handle: "about", body: "<p>x</p>", isPublished: true, templateSuffix: null },
    metafields: { set: [], remove: [] },
  });
});
