import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countriesInput,
  conditionsInput,
  methodInput,
  zoneInput,
  mapLocationIds,
  variantKeys,
  carrierKey,
} from "../app/lib/shipping-core.js";
import {
  regionCountryCodes,
  findExistingMarket,
  marketCreateInput,
  webPresenceKey,
  webPresenceInput,
  priceListInput,
  fixedPricesInput,
  COPYABLE_MARKET_TYPES,
} from "../app/lib/markets-core.js";
import {
  addressInput,
  companyLocationInput,
  companyInput,
  findExistingCompany,
  roleIdByName,
  b2bAvailability,
} from "../app/lib/b2b-core.js";
import {
  billingPolicyInput,
  deliveryPolicyInput,
  pricingPoliciesInput,
  sellingPlanGroupInput,
  groupKey,
  needsBillingApp,
} from "../app/lib/selling-plans-core.js";
import { locationSkipReason, findTargetLocation, locationAddInput, pickupInput } from "../app/lib/locations-core.js";
import {
  bestDigestMatch,
  menuLinkPaths,
  translationsToRegister,
  TRANSLATION_TYPES,
  TRANSLATION_ORDER,
} from "../app/lib/translation-match.js";
import { MANUAL_STEPS, adminUrl, storeHandle } from "../app/lib/manual-steps.js";
import { policyUndoGid, policyUndoVariables, zoneUndoVariables } from "../app/lib/undo-gids.js";

// ── shipping ────────────────────────────────────────────────────────────────
test("zone countries: whole country, listed provinces, rest of world", () => {
  assert.deepEqual(
    countriesInput([
      { code: { countryCode: "BD", restOfWorld: false }, provinces: [] },
      { code: { countryCode: "US", restOfWorld: false }, provinces: [{ code: "NY" }, { code: "CA" }] },
      { code: { countryCode: null, restOfWorld: true }, provinces: [] },
      { code: {} },
    ]),
    [
      { code: "BD", includeAllProvinces: true },
      { code: "US", provinces: [{ code: "NY" }, { code: "CA" }] },
      { restOfWorld: true },
    ],
  );
});

test("price and weight conditions split into their own inputs", () => {
  const { price, weight } = conditionsInput([
    { field: "TOTAL_PRICE", operator: "GREATER_THAN_OR_EQUAL_TO", conditionCriteria: { amount: "50.0", currencyCode: "USD" } },
    { field: "TOTAL_WEIGHT", operator: "LESS_THAN_OR_EQUAL_TO", conditionCriteria: { unit: "KILOGRAMS", value: 2 } },
  ]);
  assert.deepEqual(price, [{ operator: "GREATER_THAN_OR_EQUAL_TO", criteria: { amount: "50.0", currencyCode: "USD" } }]);
  assert.deepEqual(weight, [{ operator: "LESS_THAN_OR_EQUAL_TO", criteria: { unit: "KILOGRAMS", value: 2 } }]);
});

test("flat rate method keeps price, name, description and active flag", () => {
  const r = methodInput({
    name: "Standard",
    description: "3-5 days",
    active: false,
    rateProvider: { __typename: "DeliveryRateDefinition", price: { amount: "4.99", currencyCode: "USD" } },
    methodConditions: [],
  });
  assert.deepEqual(r.input, {
    name: "Standard",
    active: false,
    description: "3-5 days",
    rateDefinition: { price: { amount: "4.99", currencyCode: "USD" } },
  });
});

test("carrier rates map by carrier name, otherwise they are skipped with a reason", () => {
  const m = {
    name: "UPS",
    rateProvider: {
      __typename: "DeliveryParticipant",
      carrierService: { id: "gid://shopify/DeliveryCarrierService/1", name: "ups", formattedName: "UPS" },
      fixedFee: { amount: "1.00", currencyCode: "USD" },
      percentageOfRateFee: 5,
      adaptToNewServicesFlag: true,
      participantServices: [{ name: "Ground", active: true }],
    },
  };
  assert.match(methodInput(m).skip, /UPS/);
  const carriers = new Map([[carrierKey({ formattedName: "UPS" }), "gid://shopify/DeliveryCarrierService/9"]]);
  const r = methodInput(m, { carriers });
  assert.equal(r.input.participant.carrierServiceId, "gid://shopify/DeliveryCarrierService/9");
  assert.equal(r.input.participant.percentageOfRateFee, 5);
  assert.deepEqual(r.input.participant.fixedFee, { amount: "1.00", currencyCode: "USD" });
  assert.deepEqual(r.input.participant.participantServices, [{ name: "Ground", active: true }]);
});

test("zoneInput collects copyable methods and lists skipped ones", () => {
  const { input, skipped } = zoneInput(
    { name: "Domestic", countries: [{ code: { countryCode: "US" }, provinces: [] }] },
    [
      { name: "Flat", rateProvider: { __typename: "DeliveryRateDefinition", price: { amount: "5", currencyCode: "USD" } } },
      { name: "Odd", rateProvider: { __typename: "Something" } },
    ],
  );
  assert.equal(input.name, "Domestic");
  assert.equal(input.methodDefinitionsToCreate.length, 1);
  assert.equal(skipped.length, 1);
});

test("locations map by name, case-insensitive, one-to-one fallback", () => {
  const target = [{ id: "L1", name: "Main Warehouse" }];
  assert.deepEqual(mapLocationIds(["main warehouse"], target), { ids: ["L1"], missing: [] });
  assert.deepEqual(mapLocationIds(["Shop"], target), { ids: [], missing: ["Shop"] });
  assert.deepEqual(mapLocationIds(["Shop"], target, { oneToOne: true }), { ids: ["L1"], missing: [] });
});

test("variant keys use handle + title, then SKU", () => {
  assert.deepEqual(variantKeys({ title: "Red", sku: "R1", product: { handle: "shirt" } }), ["h:shirt|Red", "s:R1"]);
  assert.deepEqual(variantKeys({ title: "Red" }), []);
});

// ── markets ─────────────────────────────────────────────────────────────────
const market = {
  name: "Europe",
  handle: "europe",
  status: "ACTIVE",
  type: "REGION",
  conditions: {
    regionsCondition: {
      regions: { nodes: [{ __typename: "MarketRegionCountry", code: "DE" }, { __typename: "MarketRegionCountry", code: "FR" }] },
    },
  },
  currencySettings: { baseCurrency: { currencyCode: "EUR", manualRate: "0.92" }, localCurrencies: true, roundingEnabled: false },
  priceInclusions: { inclusiveTaxPricingStrategy: "INCLUDES_TAXES_IN_PRICE", inclusiveDutiesPricingStrategy: "ADD_DUTIES_AT_CHECKOUT", adaptivePricingEnabled: false },
};

test("market create input carries countries, currency and tax display", () => {
  assert.deepEqual(regionCountryCodes(market), ["DE", "FR"]);
  const input = marketCreateInput(market, { webPresenceIds: ["W1"] });
  assert.equal(input.name, "Europe");
  assert.equal(input.handle, "europe");
  assert.equal(input.status, "ACTIVE");
  assert.deepEqual(input.conditions.regionsCondition.regions, [{ countryCode: "DE" }, { countryCode: "FR" }]);
  assert.deepEqual(input.currencySettings, { baseCurrency: "EUR", localCurrencies: true, roundingEnabled: false, baseCurrencyManualRate: "0.92" });
  assert.equal(input.priceInclusions.taxPricingStrategy, "INCLUDES_TAXES_IN_PRICE");
  assert.deepEqual(input.webPresences, ["W1"]);
  assert.equal(input.makeDuplicateUniqueMarketsDraft, true);
  assert.equal(marketCreateInput({ ...market, status: "DRAFT" }).status, "DRAFT");
});

test("only region markets are copied; existing ones found by handle or name", () => {
  assert.ok(COPYABLE_MARKET_TYPES.has("REGION"));
  assert.ok(!COPYABLE_MARKET_TYPES.has("COMPANY_LOCATION"));
  assert.ok(findExistingMarket(market, [{ handle: "EUROPE", name: "x" }]));
  assert.ok(findExistingMarket(market, [{ handle: "eu", name: "europe" }]));
  assert.equal(findExistingMarket(market, [{ handle: "asia", name: "Asia" }]), null);
});

test("web presences: subfolders copy with the languages this store has", () => {
  const wp = { subfolderSuffix: "fr", defaultLocale: { locale: "fr" }, alternateLocales: [{ locale: "en" }, { locale: "de" }] };
  assert.equal(webPresenceKey(wp), "sub:fr");
  assert.deepEqual(webPresenceInput(wp, ["fr", "en"]).input, { defaultLocale: "fr", alternateLocales: ["en"], subfolderSuffix: "fr" });
  assert.match(webPresenceInput(wp, ["en"]).skip, /fr/);
  assert.match(webPresenceInput({ domain: { host: "shop.fr" }, defaultLocale: { locale: "fr" } }, ["fr"]).skip, /domain/);
});

test("price list keeps adjustment and compare-at mode", () => {
  const input = priceListInput({
    name: "EU prices",
    currency: "EUR",
    parent: { adjustment: { type: "PERCENTAGE_INCREASE", value: 10 }, settings: { compareAtMode: "NULLIFY" } },
  });
  assert.deepEqual(input, {
    name: "EU prices",
    currency: "EUR",
    parent: { adjustment: { type: "PERCENTAGE_INCREASE", value: 10 }, settings: { compareAtMode: "NULLIFY" } },
  });
});

test("fixed prices map to target variants and report the missing ones", () => {
  const keyToId = new Map([["h:shirt|Red", "V9"]]);
  const r = fixedPricesInput(
    [
      { variant: { title: "Red", product: { handle: "shirt" } }, price: { amount: "9.5", currencyCode: "EUR" }, compareAtPrice: { amount: "12", currencyCode: "EUR" } },
      { variant: { title: "Blue", sku: "B", product: { handle: "shirt" } }, price: { amount: "9", currencyCode: "EUR" } },
    ],
    variantKeys,
    keyToId,
  );
  assert.deepEqual(r.prices, [
    { variantId: "V9", price: { amount: "9.5", currencyCode: "EUR" }, compareAtPrice: { amount: "12", currencyCode: "EUR" } },
  ]);
  assert.deepEqual(r.missing, ["B"]);
});

// ── B2B ─────────────────────────────────────────────────────────────────────
test("company location input: addresses, same billing, tax, payment terms by name", () => {
  const addr = { address1: "1 Main", city: "Dhaka", countryCode: "BD", zip: "1000", firstName: null };
  const input = companyLocationInput(
    {
      name: "HQ",
      phone: "+8801",
      shippingAddress: addr,
      billingAddress: { ...addr },
      taxSettings: { taxExempt: true, taxExemptions: [], taxRegistrationId: "VAT1" },
      buyerExperienceConfiguration: { checkoutToDraft: true, editableShippingAddress: false, paymentTermsTemplate: { name: "Net 30" } },
    },
    { termsByName: new Map([["net 30", "T30"]]) },
  );
  assert.deepEqual(input.shippingAddress, { address1: "1 Main", city: "Dhaka", countryCode: "BD", zip: "1000" });
  assert.equal(input.billingSameAsShipping, true);
  assert.equal(input.billingAddress, undefined);
  assert.equal(input.taxExempt, true);
  assert.equal(input.taxRegistrationId, "VAT1");
  assert.deepEqual(input.buyerExperienceConfiguration, { checkoutToDraft: true, editableShippingAddress: false, paymentTermsTemplateId: "T30" });
  assert.equal(addressInput({ city: "x" }), null);
});

test("companies match by external id, then name; roles by name", () => {
  assert.deepEqual(companyInput({ name: "Acme", note: "n", externalId: "A1" }), { name: "Acme", note: "n", externalId: "A1" });
  const t = [{ id: "C1", name: "Other", externalId: "A1" }, { id: "C2", name: "acme" }];
  assert.equal(findExistingCompany({ name: "Acme", externalId: "A1" }, t).id, "C1");
  assert.equal(findExistingCompany({ name: "ACME" }, t).id, "C2");
  assert.equal(findExistingCompany({ name: "New" }, t), null);
  assert.equal(roleIdByName([{ id: "R1", name: "Location admin" }], "location ADMIN"), "R1");
  assert.equal(b2bAvailability({ plan: { shopifyPlus: true } }).ok, true);
  assert.equal(b2bAvailability({ plan: { shopifyPlus: false, partnerDevelopment: false } }).ok, false);
});

// ── selling plans ───────────────────────────────────────────────────────────
const monthly = {
  name: "Monthly",
  options: ["1 month"],
  position: 1,
  category: "SUBSCRIPTION",
  billingPolicy: { __typename: "SellingPlanRecurringBillingPolicy", interval: "MONTH", intervalCount: 1, minCycles: 3, maxCycles: null, anchors: [] },
  deliveryPolicy: { __typename: "SellingPlanRecurringDeliveryPolicy", interval: "MONTH", intervalCount: 1, cutoff: null, intent: "FULFILLMENT_BEGIN", preAnchorBehavior: "ASAP", anchors: [{ type: "MONTHDAY", day: 5 }] },
  pricingPolicies: [{ __typename: "SellingPlanFixedPricingPolicy", adjustmentType: "PERCENTAGE", adjustmentValue: { percentage: 10 } }],
  inventoryPolicy: { reserve: "ON_FULFILLMENT" },
};

test("recurring plans convert billing, delivery and pricing", () => {
  assert.deepEqual(billingPolicyInput(monthly.billingPolicy), { recurring: { interval: "MONTH", intervalCount: 1, anchors: [], minCycles: 3 } });
  assert.deepEqual(deliveryPolicyInput(monthly.deliveryPolicy), {
    recurring: { interval: "MONTH", intervalCount: 1, anchors: [{ type: "MONTHDAY", day: 5 }], intent: "FULFILLMENT_BEGIN", preAnchorBehavior: "ASAP" },
  });
  assert.deepEqual(pricingPoliciesInput(monthly.pricingPolicies), [{ fixed: { adjustmentType: "PERCENTAGE", adjustmentValue: { percentage: 10 } } }]);
  assert.deepEqual(
    pricingPoliciesInput([{ __typename: "SellingPlanRecurringPricingPolicy", adjustmentType: "PRICE", afterCycle: 2, adjustmentValue: { amount: "8.00" } }]),
    [{ recurring: { adjustmentType: "PRICE", adjustmentValue: { fixedValue: "8.00" }, afterCycle: 2 } }],
  );
});

test("pre-order plans keep checkout charge and fixed delivery (aliased fields)", () => {
  const b = billingPolicyInput({
    __typename: "SellingPlanFixedBillingPolicy",
    checkoutCharge: { type: "PERCENTAGE", value: { percentage: 20 } },
    remainingBalanceChargeTrigger: "TIME_AFTER_CHECKOUT",
    remainingBalanceChargeTimeAfterCheckout: "P14D",
  });
  assert.deepEqual(b, {
    fixed: { checkoutCharge: { type: "PERCENTAGE", value: { percentage: 20 } }, remainingBalanceChargeTrigger: "TIME_AFTER_CHECKOUT", remainingBalanceChargeTimeAfterCheckout: "P14D" },
  });
  const d = deliveryPolicyInput({
    __typename: "SellingPlanFixedDeliveryPolicy",
    fulfillmentTrigger: "UNKNOWN",
    fixedIntent: "FULFILLMENT_BEGIN",
    fixedPreAnchorBehavior: "ASAP",
    anchors: [],
  });
  assert.deepEqual(d.fixed, { anchors: [], fulfillmentTrigger: "UNKNOWN", intent: "FULFILLMENT_BEGIN", preAnchorBehavior: "ASAP" });
});

test("group input, re-run key and billing-app check", () => {
  const g = { name: "Subscribe", merchantCode: "sub", options: ["Delivery every"], sellingPlans: { nodes: [monthly] } };
  const input = sellingPlanGroupInput(g);
  assert.equal(input.merchantCode, "sub");
  assert.equal(input.sellingPlansToCreate.length, 1);
  assert.equal(input.sellingPlansToCreate[0].inventoryPolicy.reserve, "ON_FULFILLMENT");
  assert.equal(groupKey(g), groupKey({ name: "SUBSCRIBE", merchantCode: "Sub" }));
  assert.equal(needsBillingApp(g), true);
  const paidInFull = {
    sellingPlans: {
      nodes: [{ billingPolicy: { __typename: "SellingPlanFixedBillingPolicy", remainingBalanceChargeTrigger: "NO_REMAINING_BALANCE" } }],
    },
  };
  assert.equal(needsBillingApp(paidInFull), false);
});

// ── locations ───────────────────────────────────────────────────────────────
test("locations: skip app-run and inactive, build add input, pickup", () => {
  assert.match(locationSkipReason({ isFulfillmentService: true }), /fulfilment app/);
  assert.match(locationSkipReason({ isActive: false }), /deactivated/);
  assert.equal(locationSkipReason({ isActive: true }), null);
  assert.equal(findTargetLocation({ name: "Shop" }, [{ id: "L", name: "shop" }]).id, "L");
  const r = locationAddInput({ name: "Shop", fulfillsOnlineOrders: true, address: { countryCode: "BD", city: "Dhaka", zip: "" } });
  assert.deepEqual(r.input, { name: "Shop", address: { countryCode: "BD", city: "Dhaka" }, fulfillsOnlineOrders: true });
  assert.match(locationAddInput({ name: "X", address: {} }).skip, /country/);
  assert.deepEqual(pickupInput({ localPickupSettingsV2: { pickupTime: "ONE_HOUR", instructions: "Ring" } }, "L"), {
    locationId: "L",
    pickupTime: "ONE_HOUR",
    instructions: "Ring",
  });
  assert.equal(pickupInput({}, "L"), null);
});

// ── translations ────────────────────────────────────────────────────────────
test("digest match picks the single best target, refuses ties", () => {
  const src = [{ key: "title", digest: "a" }, { key: "body", digest: "b" }];
  const targets = [
    { resourceId: "T1", translatableContent: [{ key: "title", digest: "a" }] },
    { resourceId: "T2", translatableContent: [{ key: "title", digest: "a" }, { key: "body", digest: "b" }] },
  ];
  assert.equal(bestDigestMatch(src, targets).resourceId, "T2");
  assert.equal(bestDigestMatch([{ key: "title", digest: "a" }], targets), null);
  assert.equal(bestDigestMatch([{ key: "title", digest: "z" }], targets), null);
});

test("menu link paths are stable across stores", () => {
  const paths = menuLinkPaths({
    handle: "main-menu",
    items: [
      { id: "1", title: "Shop", items: [{ id: "2", title: "Shoes", items: [] }] },
      { id: "3", title: "Shop", items: [] },
    ],
  });
  assert.equal(paths.get("main-menu>Shop#0"), "1");
  assert.equal(paths.get("main-menu>Shop#0>Shoes#0"), "2");
  assert.equal(paths.get("main-menu>Shop#1"), "3");
});

test("translations to register use target digests and respect existing ones", () => {
  const out = translationsToRegister(
    [{ key: "title", value: "Titre" }, { key: "body", value: "Corps" }, { key: "gone", value: "x" }],
    [{ key: "title", digest: "d1" }, { key: "body", digest: "d2" }],
    new Set(["body"]),
    "fr",
    false,
  );
  assert.deepEqual(out, [{ locale: "fr", key: "title", value: "Titre", translatableContentDigest: "d1" }]);
  assert.equal(translationsToRegister([{ key: "body", value: "C" }], [{ key: "body", digest: "d2" }], new Set(["body"]), "fr", true).length, 1);
  assert.ok(TRANSLATION_ORDER.includes("SHOP_POLICY") && TRANSLATION_ORDER.includes("LINK"));
  assert.equal(TRANSLATION_TYPES.PRODUCT, "mapped");
});

// ── manual steps + undo gids ───────────────────────────────────────────────
test("manual steps link to the target store's admin", () => {
  assert.equal(storeHandle("zs-storesync.myshopify.com"), "zs-storesync");
  assert.equal(adminUrl("zs-storesync.myshopify.com", "settings/payments"), "https://admin.shopify.com/store/zs-storesync/settings/payments");
  const ids = MANUAL_STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of MANUAL_STEPS) assert.ok(s.title && s.why && s.path, s.id);
});

test("a zone created in an existing profile undoes through that profile", () => {
  const gid = `gid://shopify/DeliveryZone/77?profile=${encodeURIComponent("gid://shopify/DeliveryProfile/5")}`;
  assert.deepEqual(zoneUndoVariables(gid), {
    id: "gid://shopify/DeliveryProfile/5",
    profile: { zonesToDelete: ["gid://shopify/DeliveryZone/77"] },
  });
});

test("a created store metafield undoes by owner, namespace and key", async () => {
  const { metafieldUndoGid, metafieldUndoVariables } = await import("../app/lib/undo-gids.js");
  const gid = metafieldUndoGid("gid://shopify/Metafield/9", "gid://shopify/Shop/1", "judgeme", "settings");
  assert.match(gid, /^gid:\/\/shopify\/Metafield\/9\?/);
  assert.deepEqual(metafieldUndoVariables(gid), {
    metafields: [{ ownerId: "gid://shopify/Shop/1", namespace: "judgeme", key: "settings" }],
  });
});

test("store policy undo empties the policy it filled", () => {
  const gid = policyUndoGid("gid://shopify/ShopPolicy/7", "REFUND_POLICY");
  assert.equal(gid, "gid://shopify/ShopPolicy/7?type=REFUND_POLICY");
  assert.deepEqual(policyUndoVariables(gid), { shopPolicy: { type: "REFUND_POLICY", body: "" } });
});
