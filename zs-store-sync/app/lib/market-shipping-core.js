// Pure helpers for copying shipping on stores that use market-driven shipping.
// No API calls here, so every mapping can be unit tested.
//
// Under market-driven shipping (Admin API 2026-07+, ShopFeatures.marketDrivenShipping)
// a merchant's shipping options live on each market (Market.delivery.shipping)
// instead of in merchant-owned delivery profiles; Shopify ignores the zones and
// rates of merchant profiles on those stores at checkout, so they must not be
// read from or written to there.
// https://shopify.dev/docs/apps/build/orders-fulfillment/market-driven-shipping/upgrade-your-app
//
// Source option shape (Admin API 2026-10, DeliveryOptionDefinition):
//   { __typename, id, name?, description, isActive, currency,
//     freeDeliveryMinimumValue { amount currencyCode },
//     rateGroups { nodes: [ group ] } }
//   group (flat):    { conditions, rate { price, transitTimeMinSeconds, transitTimeMaxSeconds } }
//   group (value):   { conditions, rates { nodes: [{ minValue, maxValue, price, transit… }] } }
//   group (weight):  { conditions, rates { nodes: [{ minWeight, maxWeight, price, transit… }] } }
//   group (carrier): { conditions, carrierService { name formattedName }, absoluteAdjustment,
//                      percentageAdjustment, autoIncludeNewServices, serviceConfiguration [{ name status }] }
//   conditions:      { collections { nodes [{ handle }] }, originLocations { nodes [{ name }] } }

import { countriesInput, carrierKey } from "./shipping-core.js";

const lc = (s) => String(s || "").trim().toLowerCase();
const nodes = (conn) => conn?.nodes || [];

export const OPTION_KINDS = {
  DeliveryFlatRateOptionDefinition: "flatRate",
  DeliveryValueBasedOptionDefinition: "valueBased",
  DeliveryWeightBasedOptionDefinition: "weightBased",
  DeliveryCarrierCalculatedOptionDefinition: "carrierCalculated",
};

// Every gid type a market shipping option can come back as (used by Undo).
export const OPTION_GID_TYPES = [...Object.keys(OPTION_KINDS), "DeliveryOptionDefinition"];

const money = (m, currency) =>
  m && m.amount != null ? { amount: String(m.amount), currencyCode: currency || m.currencyCode } : null;

const weight = (w) => (w && w.value != null ? { unit: w.unit, value: Number(w.value) } : null);

function transit(r) {
  const out = {};
  if (r?.transitTimeMinSeconds != null) out.transitTimeMinSeconds = r.transitTimeMinSeconds;
  if (r?.transitTimeMaxSeconds != null) out.transitTimeMaxSeconds = r.transitTimeMaxSeconds;
  return out;
}

// A shipping option's name for re-runs and log lines. Carrier-calculated
// options have no name of their own, so the carrier stands in for it.
export function optionName(opt) {
  if (opt?.name) return opt.name;
  const g = nodes(opt?.rateGroups)[0];
  const cs = g?.carrierService;
  return cs?.formattedName || cs?.name || "Carrier-calculated rates";
}

// Re-run key. Carrier-calculated options are told apart by their carrier.
export function optionKey(opt) {
  const kind = OPTION_KINDS[opt?.__typename] || "?";
  if (kind === "carrierCalculated") return `${kind}:${nodes(opt?.rateGroups)[0]?.carrierService?.id || ""}`;
  return `${kind}:${lc(optionName(opt))}`;
}

// Rate group conditions → DeliveryRateConditionsCreateInput. A condition that
// points at a collection or location this store doesn't have can't be copied:
// dropping it would widen the rate to every product / location, so the whole
// rate group is skipped instead.
export function rateConditionsInput(conditions, { collections = new Map(), locations = new Map() } = {}) {
  const out = {};
  const missing = [];
  const cols = nodes(conditions?.collections);
  if (cols.length) {
    const ids = [];
    for (const c of cols) {
      const id = collections.get(lc(c.handle));
      if (id) ids.push(id);
      else missing.push(`collection "${c.handle}"`);
    }
    if (ids.length) out.collectionsToAdd = ids;
  }
  const locs = nodes(conditions?.originLocations);
  if (locs.length) {
    const ids = [];
    for (const l of locs) {
      const id = locations.get(lc(l.name));
      if (id) {
        if (!ids.includes(id)) ids.push(id);
      } else missing.push(`location "${l.name}"`);
    }
    if (ids.length) out.originLocationsToAdd = ids;
  }
  return { input: out, missing };
}

// One market shipping option → DeliveryOptionDefinitionCreateInput, or
// { skip: reason }. `currency` is this store's currency when it differs from
// the source's (amounts are kept as the same numbers).
export function optionCreateInput(opt, { collections, locations, carriers = new Map(), currency } = {}) {
  const kind = OPTION_KINDS[opt?.__typename];
  if (!kind) return { skip: "unknown shipping option type" };
  const cur = currency || opt.currency;
  const base = { currency: cur };
  if (kind !== "carrierCalculated") {
    if (!opt.name) return { skip: "no name" };
    base.name = opt.name;
  }
  if (opt.description) base.description = opt.description;
  if (opt.isActive != null) base.isActive = !!opt.isActive;
  const free = money(opt.freeDeliveryMinimumValue, currency);
  if (free) base.freeDeliveryMinimumValue = free;

  const skipped = [];
  const rateGroups = [];
  for (const g of nodes(opt.rateGroups)) {
    const cond = rateConditionsInput(g.conditions, { collections, locations });
    if (cond.missing.length) {
      skipped.push(`a rate for ${cond.missing.join(", ")} (not on this store)`);
      continue;
    }
    const conditions = cond.input;
    if (kind === "flatRate") {
      const price = money(g.rate?.price, currency);
      if (!price) continue;
      const group = { rate: { price, ...transit(g.rate) } };
      if (Object.keys(conditions).length) group.conditions = conditions;
      rateGroups.push(group);
    } else if (kind === "valueBased") {
      const rates = [];
      for (const r of nodes(g.rates)) {
        const price = money(r.price, currency);
        const minValue = money(r.minValue, currency);
        if (!price || !minValue) continue;
        const rate = { minValue, price, ...transit(r) };
        const max = money(r.maxValue, currency);
        if (max) rate.maxValue = max;
        rates.push(rate);
      }
      if (rates.length) rateGroups.push({ conditions, rates });
    } else if (kind === "weightBased") {
      const rates = [];
      for (const r of nodes(g.rates)) {
        const price = money(r.price, currency);
        const minWeight = weight(r.minWeight);
        if (!price || !minWeight) continue;
        const rate = { minWeight, price, ...transit(r) };
        const max = weight(r.maxWeight);
        if (max) rate.maxWeight = max;
        rates.push(rate);
      }
      if (rates.length) rateGroups.push({ conditions, rates });
    } else {
      const id = carriers.get(carrierKey(g.carrierService));
      if (!id) {
        skipped.push(`carrier "${g.carrierService?.formattedName || g.carrierService?.name || "?"}" isn't on this store`);
        continue;
      }
      const group = { carrierServiceId: id, autoIncludeNewServices: !!g.autoIncludeNewServices };
      const adj = money(g.absoluteAdjustment, currency);
      if (adj) group.absoluteAdjustment = adj;
      if (g.percentageAdjustment != null) group.percentageAdjustment = g.percentageAdjustment;
      const services = (g.serviceConfiguration || []).filter((s) => s?.name && s?.status);
      if (services.length) group.serviceConfiguration = services.map((s) => ({ name: s.name, status: s.status }));
      if (Object.keys(conditions).length) group.conditions = conditions;
      rateGroups.push(group);
    }
  }
  // weight-based and carrier-calculated options hold exactly one rate group
  if (kind === "weightBased" || kind === "carrierCalculated") rateGroups.splice(1);
  if (!rateGroups.length) return { skip: skipped.length ? skipped.join("; ") : "no rates", skipped };
  return { input: { [kind]: { ...base, rateGroups } }, skipped };
}

// Which target market a source market's shipping belongs to: same handle or
// name, and the stores' home (primary) markets map to each other.
export function findTargetMarket(m, targetMarkets) {
  const list = targetMarkets || [];
  const byKey = list.find((t) => (m?.handle && lc(t.handle) === lc(m.handle)) || lc(t.name) === lc(m?.name));
  if (byKey) return byKey;
  if (m?.primary) return list.find((t) => t.primary) || null;
  return null;
}

export function marketCountryCodes(m) {
  return nodes(m?.conditions?.regionsCondition?.regions)
    .filter((r) => r.__typename === "MarketRegionCountry" && r.code)
    .map((r) => r.code);
}

// ─── legacy profile zone → market shipping (source legacy, this store market-driven)

// Countries a legacy zone covers (rest-of-world zones have no fixed list).
export function zoneCountryCodes(zone) {
  if ((zone?.countries || []).some((c) => c?.code?.restOfWorld)) return null;
  return (zone?.countries || []).map((c) => c?.code?.countryCode).filter(Boolean);
}

// The target market whose countries are exactly the zone's countries.
export function marketForZone(zone, targetMarkets) {
  const codes = zoneCountryCodes(zone);
  if (!codes?.length) return null;
  const want = [...new Set(codes)].sort().join(",");
  return (targetMarkets || []).find((m) => [...new Set(marketCountryCodes(m))].sort().join(",") === want) || null;
}

function bounds(conditions, field) {
  let min = null;
  let max = null;
  for (const c of conditions || []) {
    if (c.field !== field) continue;
    const crit = c.conditionCriteria || {};
    if (/GREATER/.test(c.operator)) min = crit;
    else if (/LESS/.test(c.operator)) max = crit;
  }
  return { min, max };
}

// Legacy zone method definitions → market shipping options. Methods with the
// same name and kind become one option with several tiers, as the market
// model groups them.
export function zoneMethodsToOptions(methods, { carriers = new Map(), currency } = {}) {
  const options = new Map();
  const skipped = [];
  for (const m of methods || []) {
    const rp = m?.rateProvider || {};
    const has = (f) => (m.methodConditions || []).some((c) => c.field === f);
    if (rp.__typename === "DeliveryParticipant") {
      const id = carriers.get(carrierKey(rp.carrierService));
      if (!id) {
        skipped.push(`${m.name || "?"}: carrier "${rp.carrierService?.formattedName || rp.carrierService?.name || "?"}" isn't on this store`);
        continue;
      }
      const group = {
        carrierServiceId: id,
        autoIncludeNewServices: !!rp.adaptToNewServicesFlag,
        serviceConfiguration: (rp.participantServices || []).map((s) => ({ name: s.name, status: s.active ? "INCLUDED" : "EXCLUDED" })),
      };
      const fee = money(rp.fixedFee, currency);
      if (fee) group.absoluteAdjustment = fee;
      if (rp.percentageOfRateFee) group.percentageAdjustment = Math.round(Number(rp.percentageOfRateFee));
      if (!group.serviceConfiguration.length) delete group.serviceConfiguration;
      options.set(`c:${id}`, { carrierCalculated: { currency: currency || fee?.currencyCode, isActive: m.active !== false, rateGroups: [group] } });
      continue;
    }
    if (rp.__typename !== "DeliveryRateDefinition" || !rp.price) {
      skipped.push(`${m?.name || "?"}: unknown rate type`);
      continue;
    }
    const price = money(rp.price, currency);
    const cur = currency || rp.price.currencyCode;
    if (has("TOTAL_WEIGHT")) {
      const { min, max } = bounds(m.methodConditions, "TOTAL_WEIGHT");
      const key = `w:${lc(m.name)}`;
      const opt = options.get(key) || { weightBased: { name: m.name, currency: cur, isActive: m.active !== false, rateGroups: [{ conditions: {}, rates: [] }] } };
      const rate = { minWeight: weight(min) || { unit: max?.unit || "KILOGRAMS", value: 0 }, price };
      if (max) rate.maxWeight = weight(max);
      opt.weightBased.rateGroups[0].rates.push(rate);
      options.set(key, opt);
    } else if (has("TOTAL_PRICE")) {
      const { min, max } = bounds(m.methodConditions, "TOTAL_PRICE");
      const key = `v:${lc(m.name)}`;
      const opt = options.get(key) || { valueBased: { name: m.name, currency: cur, isActive: m.active !== false, rateGroups: [{ conditions: {}, rates: [] }] } };
      const rate = { minValue: money(min, currency) || { amount: "0", currencyCode: cur }, price };
      if (max) rate.maxValue = money(max, currency);
      opt.valueBased.rateGroups[0].rates.push(rate);
      options.set(key, opt);
    } else {
      const key = `f:${lc(m.name)}`;
      if (options.has(key)) continue;
      const opt = { flatRate: { name: m.name, currency: cur, isActive: m.active !== false, rateGroups: [{ rate: { price } }] } };
      if (m.description) opt.flatRate.description = m.description;
      options.set(key, opt);
    }
  }
  return { options: [...options.values()], skipped };
}

// Key of a create input, comparable with optionKey() of an existing option.
export function inputKey(input) {
  const kind = Object.keys(input || {})[0];
  const v = input?.[kind] || {};
  if (kind === "carrierCalculated") return `${kind}:${v.rateGroups?.[0]?.carrierServiceId || ""}`;
  return `${kind}:${lc(v.name || "")}`;
}

// ─── market shipping → legacy zone (source market-driven, this store legacy)

const GTE = "GREATER_THAN_OR_EQUAL_TO";
const LTE = "LESS_THAN_OR_EQUAL_TO";

// A market's shipping options → one DeliveryLocationGroupZoneInput named after
// the market. Rate groups limited to collections or locations have no place in
// a profile zone, so they are listed as not copied.
export function marketToZoneInput(market, options, { carriers = new Map(), currency } = {}) {
  const codes = marketCountryCodes(market);
  const skipped = [];
  if (!codes.length) return { skip: "the market has no countries", skipped };
  const methodDefinitionsToCreate = [];
  for (const opt of options || []) {
    const kind = OPTION_KINDS[opt?.__typename];
    const name = optionName(opt);
    const active = opt.isActive !== false;
    for (const g of nodes(opt.rateGroups)) {
      if (nodes(g.conditions?.collections).length || nodes(g.conditions?.originLocations).length) {
        skipped.push(`${name}: a rate limited to some products or locations`);
        continue;
      }
      if (kind === "flatRate") {
        const price = money(g.rate?.price, currency);
        if (price) methodDefinitionsToCreate.push({ name, active, rateDefinition: { price }, ...(opt.description ? { description: opt.description } : {}) });
      } else if (kind === "valueBased" || kind === "weightBased") {
        for (const r of nodes(g.rates)) {
          const price = money(r.price, currency);
          if (!price) continue;
          const md = { name, active, rateDefinition: { price } };
          if (kind === "valueBased") {
            md.priceConditionsToCreate = [{ operator: GTE, criteria: money(r.minValue, currency) }];
            if (r.maxValue) md.priceConditionsToCreate.push({ operator: LTE, criteria: money(r.maxValue, currency) });
          } else {
            md.weightConditionsToCreate = [{ operator: GTE, criteria: weight(r.minWeight) }];
            if (r.maxWeight) md.weightConditionsToCreate.push({ operator: LTE, criteria: weight(r.maxWeight) });
          }
          methodDefinitionsToCreate.push(md);
        }
      } else if (kind === "carrierCalculated") {
        const id = carriers.get(carrierKey(g.carrierService));
        if (!id) {
          skipped.push(`${name}: carrier isn't on this store`);
          continue;
        }
        const participant = {
          carrierServiceId: id,
          adaptToNewServices: !!g.autoIncludeNewServices,
          percentageOfRateFee: Number(g.percentageAdjustment || 0),
          participantServices: (g.serviceConfiguration || []).map((s) => ({ name: s.name, active: s.status === "INCLUDED" })),
        };
        const fee = money(g.absoluteAdjustment, currency);
        if (fee) participant.fixedFee = fee;
        methodDefinitionsToCreate.push({ name, active, participant });
      } else skipped.push(`${name}: unknown shipping option type`);
    }
  }
  const zone = { name: market.name, countries: countriesInput(codes.map((countryCode) => ({ code: { countryCode } }))), methodDefinitionsToCreate };
  return { input: zone, skipped };
}

// Undo id for an option added to a market: "<option gid>?market=<market gid>",
// because an option can only be removed through its market.
export function optionUndoGid(optionId, marketId) {
  return `${optionId}?${new URLSearchParams({ market: marketId }).toString()}`;
}

export function optionUndoVariables(gid) {
  const [option, query = ""] = String(gid).split("?");
  const market = new URLSearchParams(query).get("market") || "";
  return { id: market, input: { delivery: { shipping: { optionDefinitionsToDelete: [option] } } } };
}
