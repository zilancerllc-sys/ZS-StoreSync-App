import { test } from "node:test";
import assert from "node:assert/strict";
import {
  optionCreateInput,
  optionKey,
  inputKey,
  findTargetMarket,
  marketForZone,
  zoneMethodsToOptions,
  marketToZoneInput,
  optionUndoGid,
  optionUndoVariables,
  OPTION_GID_TYPES,
} from "../app/lib/market-shipping-core.js";

const usd = (amount) => ({ amount: String(amount), currencyCode: "USD" });
const region = (...codes) => ({
  conditions: { regionsCondition: { regions: { nodes: codes.map((code) => ({ __typename: "MarketRegionCountry", code })) } } },
});

test("flat rate option keeps price, transit, free threshold and mapped conditions", () => {
  const opt = {
    __typename: "DeliveryFlatRateOptionDefinition",
    name: "Standard",
    currency: "USD",
    isActive: true,
    freeDeliveryMinimumValue: usd(50),
    rateGroups: {
      nodes: [
        {
          conditions: { collections: { nodes: [{ handle: "Fragile" }] }, originLocations: { nodes: [{ name: "Warehouse" }] } },
          rate: { price: usd(5), transitTimeMinSeconds: 86400, transitTimeMaxSeconds: 172800 },
        },
      ],
    },
  };
  const r = optionCreateInput(opt, {
    collections: new Map([["fragile", "C1"]]),
    locations: new Map([["warehouse", "L1"]]),
  });
  assert.deepEqual(r.input, {
    flatRate: {
      name: "Standard",
      currency: "USD",
      isActive: true,
      freeDeliveryMinimumValue: usd(50),
      rateGroups: [
        {
          rate: { price: usd(5), transitTimeMinSeconds: 86400, transitTimeMaxSeconds: 172800 },
          conditions: { collectionsToAdd: ["C1"], originLocationsToAdd: ["L1"] },
        },
      ],
    },
  });
});

test("a rate group for a missing collection is skipped, never widened", () => {
  const opt = {
    __typename: "DeliveryFlatRateOptionDefinition",
    name: "Express",
    currency: "USD",
    rateGroups: {
      nodes: [
        { conditions: { collections: { nodes: [{ handle: "gone" }] } }, rate: { price: usd(9) } },
        { conditions: {}, rate: { price: usd(12) } },
      ],
    },
  };
  const r = optionCreateInput(opt, {});
  assert.equal(r.input.flatRate.rateGroups.length, 1);
  assert.equal(r.input.flatRate.rateGroups[0].rate.price.amount, "12");
  assert.match(r.skipped[0], /collection "gone"/);
  const only = optionCreateInput({ ...opt, rateGroups: { nodes: [opt.rateGroups.nodes[0]] } }, {});
  assert.ok(only.skip);
});

test("value and weight tiers, currency retargeted", () => {
  const v = optionCreateInput(
    {
      __typename: "DeliveryValueBasedOptionDefinition",
      name: "By value",
      currency: "USD",
      rateGroups: { nodes: [{ conditions: {}, rates: { nodes: [{ minValue: usd(0), maxValue: usd(50), price: usd(5) }, { minValue: usd(50), price: usd(0) }] } }] },
    },
    { currency: "EUR" },
  );
  assert.equal(v.input.valueBased.currency, "EUR");
  assert.equal(v.input.valueBased.rateGroups[0].rates.length, 2);
  assert.equal(v.input.valueBased.rateGroups[0].rates[0].maxValue.currencyCode, "EUR");
  assert.equal(v.input.valueBased.rateGroups[0].rates[1].maxValue, undefined);
  const w = optionCreateInput({
    __typename: "DeliveryWeightBasedOptionDefinition",
    name: "By weight",
    currency: "USD",
    rateGroups: { nodes: [{ conditions: {}, rates: { nodes: [{ minWeight: { unit: "KILOGRAMS", value: 0 }, maxWeight: { unit: "KILOGRAMS", value: 2 }, price: usd(4) }] } }] },
  });
  assert.deepEqual(w.input.weightBased.rateGroups[0].rates[0].maxWeight, { unit: "KILOGRAMS", value: 2 });
});

test("carrier-calculated option needs the carrier on this store; keys match on re-run", () => {
  const opt = {
    __typename: "DeliveryCarrierCalculatedOptionDefinition",
    currency: "USD",
    rateGroups: { nodes: [{ conditions: {}, carrierService: { id: "SRC", name: "UPS" }, percentageAdjustment: 5, autoIncludeNewServices: true, serviceConfiguration: [{ name: "Ground", status: "INCLUDED" }] }] },
  };
  assert.ok(optionCreateInput(opt, {}).skip);
  const r = optionCreateInput(opt, { carriers: new Map([["ups", "T1"]]) });
  assert.equal(r.input.carrierCalculated.rateGroups[0].carrierServiceId, "T1");
  assert.equal(r.input.carrierCalculated.name, undefined);
  const existing = { ...opt, rateGroups: { nodes: [{ carrierService: { id: "T1" } }] } };
  assert.equal(inputKey(r.input), optionKey(existing));
});

test("re-run keys: same name and kind", () => {
  const input = { flatRate: { name: "Standard ", currency: "USD", rateGroups: [] } };
  assert.equal(inputKey(input), optionKey({ __typename: "DeliveryFlatRateOptionDefinition", name: "standard" }));
  assert.notEqual(inputKey(input), optionKey({ __typename: "DeliveryValueBasedOptionDefinition", name: "Standard" }));
});

test("market matching: handle/name, home market to home market", () => {
  const t = [
    { id: "T1", name: "United States", handle: "us", primary: true },
    { id: "T2", name: "Europe", handle: "eu" },
  ];
  assert.equal(findTargetMarket({ name: "EU", handle: "eu" }, t).id, "T2");
  assert.equal(findTargetMarket({ name: "Bangladesh", handle: "bd", primary: true }, t).id, "T1");
  assert.equal(findTargetMarket({ name: "Asia", handle: "asia" }, t), null);
});

test("legacy zone goes to the market with exactly its countries", () => {
  const markets = [{ id: "M1", ...region("DE", "FR") }, { id: "M2", ...region("US") }];
  const zone = (codes) => ({ countries: codes.map((countryCode) => ({ code: { countryCode } })) });
  assert.equal(marketForZone(zone(["FR", "DE"]), markets).id, "M1");
  assert.equal(marketForZone(zone(["FR"]), markets), null);
  assert.equal(marketForZone({ countries: [{ code: { restOfWorld: true } }] }, markets), null);
});

test("legacy methods become grouped market options", () => {
  const rate = (amount) => ({ __typename: "DeliveryRateDefinition", price: usd(amount) });
  const cond = (field, operator, criteria) => ({ field, operator, conditionCriteria: criteria });
  const { options, skipped } = zoneMethodsToOptions(
    [
      { name: "Standard", rateProvider: rate(5), methodConditions: [] },
      { name: "Tiered", rateProvider: rate(5), methodConditions: [cond("TOTAL_PRICE", "LESS_THAN_OR_EQUAL_TO", usd(50))] },
      { name: "Tiered", rateProvider: rate(0), methodConditions: [cond("TOTAL_PRICE", "GREATER_THAN_OR_EQUAL_TO", usd(50))] },
      { name: "Heavy", rateProvider: rate(9), methodConditions: [cond("TOTAL_WEIGHT", "GREATER_THAN_OR_EQUAL_TO", { unit: "KILOGRAMS", value: 5 })] },
      { name: "FedEx", rateProvider: { __typename: "DeliveryParticipant", carrierService: { name: "FedEx" } }, methodConditions: [] },
    ],
    { currency: "USD" },
  );
  assert.equal(options.length, 3);
  const tiered = options.find((o) => o.valueBased).valueBased;
  assert.equal(tiered.rateGroups[0].rates.length, 2);
  assert.deepEqual(tiered.rateGroups[0].rates[0].minValue, usd(0));
  assert.ok(options.find((o) => o.weightBased));
  assert.match(skipped[0], /FedEx/);
});

test("market options become one legacy zone named after the market", () => {
  const z = marketToZoneInput({ name: "Europe", ...region("DE", "FR") }, [
    { __typename: "DeliveryFlatRateOptionDefinition", name: "Standard", isActive: true, rateGroups: { nodes: [{ conditions: {}, rate: { price: usd(5) } }] } },
    {
      __typename: "DeliveryValueBasedOptionDefinition",
      name: "Value",
      rateGroups: { nodes: [{ conditions: {}, rates: { nodes: [{ minValue: usd(0), maxValue: usd(50), price: usd(5) }] } }] },
    },
  ]);
  assert.equal(z.input.name, "Europe");
  assert.equal(z.input.countries.length, 2);
  assert.equal(z.input.methodDefinitionsToCreate.length, 2);
  assert.equal(z.input.methodDefinitionsToCreate[1].priceConditionsToCreate.length, 2);
  assert.ok(marketToZoneInput({ name: "Empty" }, []).skip);
});

test("undo id round-trips through the market", () => {
  const gid = optionUndoGid("gid://shopify/DeliveryFlatRateOptionDefinition/9", "gid://shopify/Market/1");
  assert.deepEqual(optionUndoVariables(gid), {
    id: "gid://shopify/Market/1",
    input: { delivery: { shipping: { optionDefinitionsToDelete: ["gid://shopify/DeliveryFlatRateOptionDefinition/9"] } } },
  });
  assert.ok(OPTION_GID_TYPES.includes("DeliveryFlatRateOptionDefinition"));
});
