// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — live stock sync: what to write, and when to refuse
//
//  Pure, so every guard is unit-tested. The server side (live-inventory.server)
//  reads the source and target and hands both here; only the returned writes
//  are sent to Shopify.
//
//  Guards (a stock app that zeroes a store is the worst outcome in this
//  category, so they err on the side of writing nothing):
//    - a source item that errored or returned no quantity is skipped, never
//      treated as 0
//    - a negative source quantity (oversold) is written as 0, never negative
//    - an unmatched or ambiguous variant (same SKU twice) is skipped
//    - unchanged quantities are not written (also stops sync loops)
//    - if one batch would set more than `maxZeroPerBatch` variants from >0 to
//      0, or change any one level by more than `maxUnitChange` units, NOTHING
//      in the batch is written and the sync pauses until the merchant looks
// ═════════════════════════════════════════════════════════════════════════════

export const DEFAULT_GUARDS = { maxZeroPerBatch: 20, maxUnitChange: 1000 };

export function normalizeGuards(input = {}) {
  const int = (v, d, min, max) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  return {
    maxZeroPerBatch: int(input.maxZeroPerBatch, DEFAULT_GUARDS.maxZeroPerBatch, 1, 10000),
    maxUnitChange: int(input.maxUnitChange, DEFAULT_GUARDS.maxUnitChange, 1, 1000000),
  };
}

// Pick the target variant for a source item: SKU first, then barcode.
// candidatesBySku / candidatesByBarcode: arrays of target variants found.
// → { match } | { skip: reason }
export function pickTargetVariant({ sku, barcode, candidatesBySku = [], candidatesByBarcode = [] }) {
  const s = String(sku || "").trim();
  const b = String(barcode || "").trim();
  if (s) {
    const exact = candidatesBySku.filter((v) => String(v.sku || "").trim() === s);
    if (exact.length === 1) return { match: exact[0] };
    if (exact.length > 1) return { skip: `SKU ${s} is on ${exact.length} variants on this store` };
  }
  if (b) {
    const exact = candidatesByBarcode.filter((v) => String(v.barcode || "").trim() === b);
    if (exact.length === 1) return { match: exact[0] };
    if (exact.length > 1) return { skip: `barcode ${b} is on ${exact.length} variants on this store` };
  }
  if (!s && !b) return { skip: "no SKU or barcode to match by" };
  return { skip: "no variant with this SKU or barcode on this store" };
}

// items: [{
//   label,
//   sourceLevels: [{ locationId, available }] | null   (null = source errored)
//   target: { inventoryItemId, levels: { [locationId]: quantity } } | null
//   skip?: reason                                      (already decided)
// }]
// locationMap: { [sourceLocationId]: targetLocationId | "" }
// → { writes: [{ inventoryItemId, locationId, quantity, from, label }],
//     skipped: [{ label, reason }], unchanged, pause: reason | null }
export function planInventoryWrites(items, locationMap, guards = DEFAULT_GUARDS) {
  const g = normalizeGuards(guards);
  const writes = [];
  const skipped = [];
  let unchanged = 0;
  let zeroing = 0;
  let pause = null;

  for (const item of items) {
    const label = item.label || "variant";
    if (item.skip) {
      skipped.push({ label, reason: item.skip });
      continue;
    }
    if (!Array.isArray(item.sourceLevels)) {
      skipped.push({ label, reason: "the source store didn't answer — nothing written" });
      continue;
    }
    if (!item.target?.inventoryItemId) {
      skipped.push({ label, reason: "not on this store" });
      continue;
    }

    // Sum source levels per mapped target location.
    const desired = new Map();
    let bad = false;
    for (const lvl of item.sourceLevels) {
      const to = locationMap?.[lvl.locationId];
      if (!to) continue; // location not synced
      if (lvl.available == null || !Number.isFinite(Number(lvl.available))) {
        bad = true;
        break;
      }
      desired.set(to, (desired.get(to) || 0) + Number(lvl.available));
    }
    if (bad) {
      skipped.push({ label, reason: "the source store returned no quantity — nothing written" });
      continue;
    }
    if (!desired.size) {
      skipped.push({ label, reason: "none of its source locations are mapped" });
      continue;
    }

    for (const [locationId, rawQty] of desired) {
      const quantity = Math.max(0, Math.trunc(rawQty));
      const fromRaw = item.target.levels?.[locationId];
      const from = Number.isFinite(Number(fromRaw)) ? Number(fromRaw) : null;
      if (from === quantity) {
        unchanged++;
        continue;
      }
      const change = Math.abs(quantity - (from ?? 0));
      if (change > g.maxUnitChange && !pause) {
        pause = `${label} would change by ${change} units (your limit is ${g.maxUnitChange})`;
      }
      if ((from ?? 0) > 0 && quantity === 0) zeroing++;
      writes.push({ inventoryItemId: item.target.inventoryItemId, locationId, quantity, from, label });
    }
  }

  if (!pause && zeroing > g.maxZeroPerBatch) {
    pause = `${zeroing} variants would drop to 0 at once (your limit is ${g.maxZeroPerBatch})`;
  }
  if (pause) return { writes: [], skipped, unchanged, pause, blocked: writes.length };
  return { writes, skipped, unchanged, pause: null, blocked: 0 };
}

// Default location mapping: same name, else a single target location takes
// everything. → { [sourceLocationId]: targetLocationId | "" }
export function defaultLocationMap(sourceLocations, targetLocations) {
  const byName = new Map(targetLocations.map((l) => [String(l.name).trim().toLowerCase(), l.id]));
  const single = targetLocations.length === 1 ? targetLocations[0].id : "";
  const map = {};
  for (const s of sourceLocations) {
    map[s.id] = byName.get(String(s.name).trim().toLowerCase()) || single || "";
  }
  return map;
}

// Keep only mappings that point at real locations on both sides.
export function cleanLocationMap(map, sourceLocations, targetLocations) {
  const src = new Set(sourceLocations.map((l) => l.id));
  const tgt = new Set(targetLocations.map((l) => l.id));
  const out = {};
  for (const [s, t] of Object.entries(map || {})) {
    if (src.has(s)) out[s] = tgt.has(t) ? t : "";
  }
  return out;
}
