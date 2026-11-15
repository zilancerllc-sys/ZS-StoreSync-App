// Pure helpers for copying Markets (regions, currency, languages / web
// presences, price adjustments and fixed prices) between stores.
//
// Source market shape (Admin API 2026-10):
//   { name, handle, status, type,
//     conditions { conditionTypes, regionsCondition { regions { nodes { __typename code } } } },
//     currencySettings { baseCurrency { currencyCode manualRate } localCurrencies roundingEnabled },
//     priceInclusions { inclusiveTaxPricingStrategy inclusiveDutiesPricingStrategy adaptivePricingEnabled },
//     webPresences { nodes { subfolderSuffix defaultLocale { locale } alternateLocales { locale } domain { host } } },
//     catalogs { nodes { title status priceList { name currency parent { adjustment { type value } settings { compareAtMode } } } } } }

const lc = (s) => String(s || "").trim().toLowerCase();

// Only region markets are copied by the Markets module: company-location
// markets belong to B2B, and location / channel markets point at POS
// locations and sales channels that are set up by hand.
export const COPYABLE_MARKET_TYPES = new Set(["REGION"]);

export function regionCountryCodes(m) {
  return (m?.conditions?.regionsCondition?.regions?.nodes || [])
    .filter((r) => r.__typename === "MarketRegionCountry" && r.code)
    .map((r) => r.code);
}

// Market key for re-runs: handle, falling back to name.
export function marketKey(m) {
  return lc(m?.handle) || lc(m?.name);
}

export function findExistingMarket(m, targetMarkets) {
  const k = marketKey(m);
  return (targetMarkets || []).find((t) => marketKey(t) === k || lc(t.name) === lc(m.name)) || null;
}

// → MarketCreateInput (catalogs / web presences are attached separately)
export function marketCreateInput(m, { webPresenceIds = [] } = {}) {
  const input = { name: m.name, status: m.status === "ACTIVE" ? "ACTIVE" : "DRAFT" };
  if (m.handle) input.handle = m.handle;
  const codes = regionCountryCodes(m);
  if (codes.length) {
    input.conditions = { regionsCondition: { regions: codes.map((countryCode) => ({ countryCode })) } };
  }
  const cs = m.currencySettings;
  if (cs?.baseCurrency?.currencyCode) {
    input.currencySettings = {
      baseCurrency: cs.baseCurrency.currencyCode,
      localCurrencies: !!cs.localCurrencies,
      roundingEnabled: !!cs.roundingEnabled,
    };
    if (cs.baseCurrency.manualRate != null) {
      input.currencySettings.baseCurrencyManualRate = String(cs.baseCurrency.manualRate);
    }
  }
  const pi = m.priceInclusions;
  if (pi) {
    input.priceInclusions = {
      taxPricingStrategy: pi.inclusiveTaxPricingStrategy,
      dutiesPricingStrategy: pi.inclusiveDutiesPricingStrategy,
      adaptivePricingEnabled: !!pi.adaptivePricingEnabled,
    };
  }
  if (webPresenceIds.length) input.webPresences = webPresenceIds;
  // Two markets can't cover the same country while both are active: let
  // Shopify keep ours as a draft instead of refusing it.
  input.makeDuplicateUniqueMarketsDraft = true;
  return input;
}

// A web presence is a domain or a subfolder (/fr-ca) with its languages.
// Domains belong to one store, so only subfolder presences can be recreated.
export function webPresenceKey(wp) {
  return wp?.subfolderSuffix ? `sub:${lc(wp.subfolderSuffix)}` : wp?.domain?.host ? `dom:${lc(wp.domain.host)}` : "";
}

// → { input } | { skip }   (locales limited to languages enabled on the target)
export function webPresenceInput(wp, targetLocales) {
  if (!wp?.subfolderSuffix) return { skip: "uses its own domain — domains can't be copied between stores" };
  const have = new Set((targetLocales || []).map(lc));
  const def = wp.defaultLocale?.locale;
  if (!def || !have.has(lc(def))) return { skip: `language ${def || "?"} isn't added to this store` };
  const alternateLocales = (wp.alternateLocales || []).map((l) => l.locale).filter((l) => have.has(lc(l)));
  return { input: { defaultLocale: def, alternateLocales, subfolderSuffix: wp.subfolderSuffix } };
}

// → PriceListCreateInput (without catalogId)
export function priceListInput(pl, fallbackName) {
  const adj = pl?.parent?.adjustment;
  const input = {
    name: pl?.name || fallbackName,
    currency: pl?.currency,
    parent: {
      adjustment: { type: adj?.type || "PERCENTAGE_DECREASE", value: Number(adj?.value || 0) },
    },
  };
  const mode = pl?.parent?.settings?.compareAtMode;
  if (mode) input.parent.settings = { compareAtMode: mode };
  return input;
}

// Fixed prices: [{ variant: key, price, compareAtPrice }] → PriceListPriceInput[]
// for variants found on the target. keyToId: Map(variantKey → target id).
export function fixedPricesInput(prices, keyFor, keyToId) {
  const out = [];
  const missing = [];
  for (const p of prices || []) {
    const id = keyFor(p.variant).map((k) => keyToId.get(k)).find(Boolean);
    if (!id) {
      missing.push(p.variant?.sku || p.variant?.title || "?");
      continue;
    }
    const row = { variantId: id, price: { amount: String(p.price.amount), currencyCode: p.price.currencyCode } };
    if (p.compareAtPrice?.amount != null) {
      row.compareAtPrice = { amount: String(p.compareAtPrice.amount), currencyCode: p.compareAtPrice.currencyCode };
    }
    out.push(row);
  }
  return { prices: out, missing };
}
