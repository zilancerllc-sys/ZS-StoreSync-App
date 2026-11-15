// Pure helpers for copying store locations (warehouses, shops) by name.
const lc = (s) => String(s || "").trim().toLowerCase();

// Locations an app can't recreate: those run by a fulfilment service app
// (they belong to that app) and inactive ones.
export function locationSkipReason(loc) {
  if (loc?.isFulfillmentService || loc?.fulfillmentService) return "run by a fulfilment app — install that app on this store";
  if (loc?.isActive === false) return "deactivated on the source store";
  return null;
}

export function findTargetLocation(loc, targetLocations) {
  return (targetLocations || []).find((t) => lc(t.name) === lc(loc?.name)) || null;
}

// → LocationAddInput, or { skip } when the address has no country.
export function locationAddInput(loc, metafields = []) {
  const a = loc?.address || {};
  if (!a.countryCode) return { skip: "no country in its address" };
  const address = { countryCode: a.countryCode };
  for (const k of ["address1", "address2", "city", "phone", "provinceCode", "zip"]) {
    if (a[k]) address[k] = a[k];
  }
  const input = { name: loc.name, address, fulfillsOnlineOrders: !!loc.fulfillsOnlineOrders };
  if (metafields.length) input.metafields = metafields;
  return { input };
}

// Local pickup settings → DeliveryLocationLocalPickupEnableInput (or null).
export function pickupInput(loc, targetLocationId) {
  const s = loc?.localPickupSettingsV2;
  if (!s || !targetLocationId) return null;
  const out = { locationId: targetLocationId, pickupTime: s.pickupTime };
  if (s.instructions) out.instructions = s.instructions;
  return out;
}
