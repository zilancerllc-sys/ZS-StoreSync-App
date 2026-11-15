// Pure helpers for copying shipping (delivery profiles, zones, rates) between
// stores. No API calls here, so every mapping can be unit tested.
//
// Shapes read from the source store (Admin API 2026-10):
//   zone   { name, countries: [{ code: { countryCode, restOfWorld }, provinces: [{ code }] }] }
//   method { name, description, active, rateProvider, methodConditions }
//     rateProvider: { __typename: "DeliveryRateDefinition", price: { amount, currencyCode } }
//                 | { __typename: "DeliveryParticipant", carrierService: { id, name, formattedName },
//                     fixedFee, percentageOfRateFee, adaptToNewServicesFlag, participantServices }
//     methodConditions: [{ field: TOTAL_PRICE|TOTAL_WEIGHT, operator, conditionCriteria }]

const lc = (s) => String(s || "").trim().toLowerCase();

// Zone countries → DeliveryCountryInput[]. A country with no listed provinces
// covers all of them.
export function countriesInput(countries) {
  const out = [];
  for (const c of countries || []) {
    if (c?.code?.restOfWorld) {
      out.push({ restOfWorld: true });
      continue;
    }
    const code = c?.code?.countryCode;
    if (!code) continue;
    const provinces = (c.provinces || []).map((p) => p.code).filter(Boolean);
    out.push(
      provinces.length
        ? { code, provinces: provinces.map((p) => ({ code: p })) }
        : { code, includeAllProvinces: true },
    );
  }
  return out;
}

const money = (m) => (m && m.amount != null ? { amount: String(m.amount), currencyCode: m.currencyCode } : null);

// Price / weight conditions ("orders over $50", "up to 2 kg").
export function conditionsInput(conditions) {
  const price = [];
  const weight = [];
  for (const c of conditions || []) {
    const crit = c?.conditionCriteria || {};
    if (c.field === "TOTAL_PRICE" && crit.amount != null) {
      price.push({ operator: c.operator, criteria: money(crit) });
    } else if (c.field === "TOTAL_WEIGHT" && crit.value != null) {
      weight.push({ operator: c.operator, criteria: { unit: crit.unit, value: Number(crit.value) } });
    }
  }
  return { price, weight };
}

// carrier service name → target carrier service id
export function carrierKey(cs) {
  return lc(cs?.formattedName || cs?.name);
}

// One method definition → DeliveryMethodDefinitionInput, or { skip: reason }.
export function methodInput(m, { carriers = new Map() } = {}) {
  if (!m?.name) return { skip: "no name" };
  const base = { name: m.name, active: m.active !== false };
  if (m.description) base.description = m.description;
  const { price, weight } = conditionsInput(m.methodConditions);
  if (price.length) base.priceConditionsToCreate = price;
  if (weight.length) base.weightConditionsToCreate = weight;
  const rp = m.rateProvider || {};
  if (rp.__typename === "DeliveryRateDefinition") {
    const p = money(rp.price);
    if (!p) return { skip: "no price" };
    return { input: { ...base, rateDefinition: { price: p } } };
  }
  if (rp.__typename === "DeliveryParticipant") {
    const id = carriers.get(carrierKey(rp.carrierService));
    if (!id) {
      return { skip: `carrier "${rp.carrierService?.formattedName || rp.carrierService?.name || "?"}" isn't on this store` };
    }
    const participant = {
      carrierServiceId: id,
      adaptToNewServices: !!rp.adaptToNewServicesFlag,
      percentageOfRateFee: Number(rp.percentageOfRateFee || 0),
      participantServices: (rp.participantServices || []).map((s) => ({ name: s.name, active: !!s.active })),
    };
    const fee = money(rp.fixedFee);
    if (fee) participant.fixedFee = fee;
    return { input: { ...base, participant } };
  }
  return { skip: "unknown rate type" };
}

// A whole zone → DeliveryLocationGroupZoneInput, with the methods that could
// not be copied listed separately.
export function zoneInput(zone, methods, opts = {}) {
  const skipped = [];
  const methodDefinitionsToCreate = [];
  for (const m of methods || []) {
    const r = methodInput(m, opts);
    if (r.input) methodDefinitionsToCreate.push(r.input);
    else skipped.push(`${m?.name || "?"}: ${r.skip}`);
  }
  return {
    input: { name: zone.name, countries: countriesInput(zone.countries), methodDefinitionsToCreate },
    skipped,
  };
}

// Source location names → target location ids. Two single-location stores map
// to each other whatever they are called (same rule as stock levels).
export function mapLocationIds(sourceNames, targetLocations, { oneToOne = false } = {}) {
  const byName = new Map((targetLocations || []).map((l) => [lc(l.name), l.id]));
  const ids = [];
  const missing = [];
  for (const n of sourceNames || []) {
    const id = byName.get(lc(n)) || (oneToOne ? targetLocations[0]?.id : null);
    if (id) {
      if (!ids.includes(id)) ids.push(id);
    } else missing.push(n);
  }
  return { ids, missing };
}

// Zone names already in a target location group (so re-runs skip them).
export function existingZoneNames(group) {
  return new Set((group?.zones || []).map((z) => lc(z.name)));
}

export function isSameZone(a, b) {
  return lc(a) === lc(b);
}

// A variant's cross-store key: product handle + variant title, SKU fallback.
export function variantKeys(v) {
  const keys = [];
  if (v?.product?.handle) keys.push(`h:${v.product.handle}|${v.title}`);
  if (v?.sku) keys.push(`s:${v.sku}`);
  return keys;
}
