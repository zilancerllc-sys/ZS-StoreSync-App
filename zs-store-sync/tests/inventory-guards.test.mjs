import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planInventoryWrites,
  pickTargetVariant,
  defaultLocationMap,
  cleanLocationMap,
  normalizeGuards,
} from "../app/lib/inventory-guards.js";

const map = { S1: "T1", S2: "T1", S3: "" };
const item = (label, levels, target = { inventoryItemId: "I1", levels: { T1: 5 } }) => ({
  label,
  sourceLevels: levels,
  target,
});

test("writes the changed quantity, summing locations sent to one place", () => {
  const plan = planInventoryWrites(
    [item("A", [{ locationId: "S1", available: 3 }, { locationId: "S2", available: 4 }, { locationId: "S3", available: 100 }])],
    map,
  );
  assert.equal(plan.pause, null);
  assert.deepEqual(plan.writes, [{ inventoryItemId: "I1", locationId: "T1", quantity: 7, from: 5, label: "A" }]);
});

test("never writes a negative quantity", () => {
  const plan = planInventoryWrites([item("A", [{ locationId: "S1", available: -4 }])], map);
  assert.equal(plan.writes[0].quantity, 0);
});

test("a source error or a missing quantity is skipped, never written as 0", () => {
  const plan = planInventoryWrites(
    [item("A", null), item("B", [{ locationId: "S1", available: null }]), item("C", [{ locationId: "S1", available: "NaN" }])],
    map,
  );
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.skipped.length, 3);
});

test("unchanged quantities are not written", () => {
  const plan = planInventoryWrites([item("A", [{ locationId: "S1", available: 5 }])], map);
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.unchanged, 1);
});

test("unmatched, unmapped and pre-skipped items are skipped", () => {
  const plan = planInventoryWrites(
    [
      item("A", [{ locationId: "S1", available: 1 }], null),
      item("B", [{ locationId: "S3", available: 1 }]),
      { label: "C", skip: "no SKU or barcode to match by" },
    ],
    map,
  );
  assert.equal(plan.writes.length, 0);
  assert.deepEqual(plan.skipped.map((s) => s.label), ["A", "B", "C"]);
});

test("a location not stocked yet on the target is written with from = null", () => {
  const plan = planInventoryWrites(
    [item("A", [{ locationId: "S1", available: 2 }], { inventoryItemId: "I1", levels: {} })],
    map,
  );
  assert.equal(plan.writes[0].from, null);
  assert.equal(plan.writes[0].quantity, 2);
});

test("safety: too many variants dropping to 0 pauses and writes nothing", () => {
  const items = Array.from({ length: 21 }, (_, i) =>
    item(`V${i}`, [{ locationId: "S1", available: 0 }], { inventoryItemId: `I${i}`, levels: { T1: 10 } }),
  );
  const plan = planInventoryWrites(items, map, { maxZeroPerBatch: 20, maxUnitChange: 1000 });
  assert.ok(plan.pause);
  assert.match(plan.pause, /21 variants would drop to 0/);
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.blocked, 21);
  // exactly at the limit is allowed
  const ok = planInventoryWrites(items.slice(0, 20), map, { maxZeroPerBatch: 20, maxUnitChange: 1000 });
  assert.equal(ok.pause, null);
  assert.equal(ok.writes.length, 20);
});

test("safety: one huge change pauses the whole batch", () => {
  const plan = planInventoryWrites(
    [
      item("Small", [{ locationId: "S1", available: 6 }]),
      item("Huge", [{ locationId: "S1", available: 5000 }], { inventoryItemId: "I2", levels: { T1: 5 } }),
    ],
    map,
    { maxZeroPerBatch: 20, maxUnitChange: 1000 },
  );
  assert.match(plan.pause, /Huge would change by 4995 units/);
  assert.equal(plan.writes.length, 0);
});

test("going from 0 to 0 or 0 to more never counts as zeroing", () => {
  const items = Array.from({ length: 30 }, (_, i) =>
    item(`V${i}`, [{ locationId: "S1", available: 1 }], { inventoryItemId: `I${i}`, levels: { T1: 0 } }),
  );
  assert.equal(planInventoryWrites(items, map).pause, null);
});

test("guards are clamped to sane values", () => {
  assert.deepEqual(normalizeGuards({ maxZeroPerBatch: "0", maxUnitChange: "abc" }), { maxZeroPerBatch: 1, maxUnitChange: 1000 });
  assert.deepEqual(normalizeGuards({}), { maxZeroPerBatch: 20, maxUnitChange: 1000 });
});

test("variant matching: SKU first, then barcode; ambiguity is skipped", () => {
  const a = { id: "a", sku: "X", barcode: "1" };
  const b = { id: "b", sku: "X", barcode: "2" };
  const c = { id: "c", sku: "XL", barcode: "3" };
  assert.equal(pickTargetVariant({ sku: "X", candidatesBySku: [a, c] }).match.id, "a");
  assert.match(pickTargetVariant({ sku: "X", candidatesBySku: [a, b] }).skip, /2 variants/);
  // search returned a prefix match only → falls back to barcode
  assert.equal(pickTargetVariant({ sku: "X", barcode: "3", candidatesBySku: [c], candidatesByBarcode: [c] }).match.id, "c");
  assert.match(pickTargetVariant({ sku: "", barcode: "" }).skip, /no SKU or barcode/);
  assert.match(pickTargetVariant({ sku: "Q", barcode: "9" }).skip, /no variant/);
});

test("default and cleaned location maps", () => {
  const src = [{ id: "S1", name: "Warehouse" }, { id: "S2", name: "Shop" }];
  assert.deepEqual(defaultLocationMap(src, [{ id: "T1", name: "warehouse " }, { id: "T2", name: "Other" }]), { S1: "T1", S2: "" });
  assert.deepEqual(defaultLocationMap(src, [{ id: "T9", name: "Only" }]), { S1: "T9", S2: "T9" });
  assert.deepEqual(cleanLocationMap({ S1: "T1", S2: "BAD", ZZ: "T1" }, src, [{ id: "T1" }]), { S1: "T1", S2: "" });
});
