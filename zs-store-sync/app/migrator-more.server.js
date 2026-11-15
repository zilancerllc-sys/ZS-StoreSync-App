// ─────────────────────────────────────────────────────────────────────────────
//  ZS StoreSync — phase 2 data types
//
//  Locations, shipping (delivery profiles / zones / rates), markets (regions,
//  currency, languages, price lists), B2B (companies, locations, contacts,
//  catalogs) and selling plan groups. Same rules as the rest of the engine:
//  duplicates are found live on the target, every create sits behind
//  ctx.canCreate() (so dry runs list what would be created), every created gid
//  is reported for Undo, and anything Shopify won't let us copy gets a plain
//  report line instead of a silent skip.
//
//  Pure mapping lives in app/lib/{locations,shipping,markets,b2b,selling-plans}-core.js.
// ─────────────────────────────────────────────────────────────────────────────
import {
  gql,
  sleep,
  fetchAll,
  errText,
  qv,
  NEEDS_PERMISSION,
  metafieldsInput,
} from "./migrator.server.js";
import { locationSkipReason, findTargetLocation, locationAddInput, pickupInput } from "./lib/locations-core.js";
import { zoneInput, mapLocationIds, carrierKey, variantKeys } from "./lib/shipping-core.js";
import {
  COPYABLE_MARKET_TYPES,
  findExistingMarket,
  marketCreateInput,
  webPresenceKey,
  webPresenceInput,
  priceListInput,
  fixedPricesInput,
} from "./lib/markets-core.js";
import {
  companyInput,
  companyLocationInput,
  findExistingCompany,
  roleIdByName,
} from "./lib/b2b-core.js";
import { sellingPlanGroupInput, groupKey, needsBillingApp } from "./lib/selling-plans-core.js";

const lc = (s) => String(s || "").trim().toLowerCase();
const short = (err) => String(err?.message || err).slice(0, 140);
const nodes = (conn) => conn?.nodes || [];

// Run a mutation → { data, errs } (errs = userErrors of the root field)
async function mutate(ctx, query, variables, root) {
  const data = await gql(ctx.target, query, variables);
  return { data: data?.[root], errs: data?.[root]?.userErrors || [] };
}

// A module whose scope a store hasn't approved yet says so once and stops.
function permissionStop(ctx, err, what) {
  if (NEEDS_PERMISSION.test(err?.message || "")) {
    ctx.onLog(`⚠ ${what} can't be copied yet — open ZS StoreSync on both stores to approve the new permission.`);
    return true;
  }
  return false;
}

// ── shared lookups ───────────────────────────────────────────────────────────
const Q_TARGET_VARIANTS_BY_HANDLE = `#graphql
  query MoreTV($handle: String!) {
    productByHandle(handle: $handle) { id variants(first: 250) { nodes { id title sku } } }
  }`;

const Q_TARGET_VARIANT_SKU = `#graphql
  query MoreTVSku($q: String!) {
    productVariants(first: 1, query: $q) { nodes { id } }
  }`;

async function targetProduct(ctx, handle) {
  ctx._tp = ctx._tp || new Map();
  if (!ctx._tp.has(handle)) {
    const d = await gql(ctx.target, Q_TARGET_VARIANTS_BY_HANDLE, { handle });
    ctx._tp.set(handle, d?.productByHandle || null);
  }
  return ctx._tp.get(handle);
}

// source variant { title sku product { handle } } → target variant id
async function targetVariantId(ctx, v) {
  const h = v?.product?.handle;
  if (h) {
    const p = await targetProduct(ctx, h);
    const list = nodes(p?.variants);
    const hit = list.find((x) => x.title === v.title) || (v.sku && list.find((x) => x.sku === v.sku));
    if (hit) return hit.id;
  }
  if (v?.sku) {
    const d = await gql(ctx.target, Q_TARGET_VARIANT_SKU, { q: `sku:${qv(v.sku)}` });
    return nodes(d?.productVariants)[0]?.id || null;
  }
  return null;
}

const Q_LOCATIONS_ALL = `#graphql
  query MoreLocations($cursor: String) {
    locations(first: 100, after: $cursor, includeInactive: true) {
      pageInfo { hasNextPage endCursor }
      edges { node { id name isActive } }
    }
  }`;

async function locationLists(ctx) {
  if (!ctx._locLists) {
    const s = await fetchAll(ctx.source, Q_LOCATIONS_ALL, "locations");
    const t = await fetchAll(ctx.target, Q_LOCATIONS_ALL, "locations");
    ctx._locLists = { source: s.filter((l) => l.isActive), target: t.filter((l) => l.isActive) };
  }
  return ctx._locLists;
}

// Copy metafields onto an item this run created (markets, companies...).
const M_METAFIELDS_SET = `#graphql
  mutation MoreMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }`;

async function copyMetafieldsTo(ctx, sourceNode, ownerId, label) {
  const list = await metafieldsInput(ctx, sourceNode);
  for (let i = 0; i < list.length; i += 25) {
    const batch = list.slice(i, i + 25).map((m) => ({ ...m, ownerId }));
    const { errs } = await mutate(ctx, M_METAFIELDS_SET, { metafields: batch }, "metafieldsSet");
    if (errs.length) ctx.onLog(`  ⚠ Some metafields of ${label} weren't copied — ${errText(errs)}`);
  }
}

const MF = `metafields(first: 50) { edges { node { namespace key type value } } }`;

// ═════════════════════════════════════════════════════════════════════════════
//  LOCATIONS
//  Missing locations are created by name with the same address, "fulfils
//  online orders" setting, local pickup and metafields. Shopify's plan limit on
//  locations still applies; locations run by a fulfilment app are reported.
// ═════════════════════════════════════════════════════════════════════════════
const Q_SOURCE_LOCATIONS = `#graphql
  query MoreSourceLocations($cursor: String) {
    locations(first: 50, after: $cursor, includeLegacy: true) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id name isActive isFulfillmentService fulfillsOnlineOrders
        address { address1 address2 city countryCode provinceCode zip phone }
        localPickupSettingsV2 { pickupTime instructions }
        ${MF}
      } }
    }
  }`;

const Q_TARGET_PICKUP = `#graphql
  query MoreTargetPickup($cursor: String) {
    locations(first: 100, after: $cursor, includeInactive: true) {
      pageInfo { hasNextPage endCursor }
      edges { node { id name isActive localPickupSettingsV2 { pickupTime } } }
    }
  }`;

const M_LOCATION_ADD = `#graphql
  mutation MoreLocationAdd($input: LocationAddInput!) {
    locationAdd(input: $input) {
      location { id name }
      userErrors { field message code }
    }
  }`;

const M_PICKUP_ENABLE = `#graphql
  mutation MorePickup($localPickupSettings: DeliveryLocationLocalPickupEnableInput!) {
    locationLocalPickupEnable(localPickupSettings: $localPickupSettings) {
      localPickupSettings { pickupTime }
      userErrors { field message }
    }
  }`;

export async function migrateLocations(ctx) {
  const { source, target, onLog, counters } = ctx;
  let src;
  let tgt;
  try {
    src = await fetchAll(source, Q_SOURCE_LOCATIONS, "locations");
    tgt = await fetchAll(target, Q_TARGET_PICKUP, "locations");
  } catch (err) {
    if (permissionStop(ctx, err, "Locations")) return;
    throw err;
  }
  onLog(`Total ${src.length} location(s) on the source store, ${tgt.length} here.`);

  for (const loc of src) {
    if (ctx.stopOnQuota()) {
      onLog("Quota reached — stopping locations.");
      break;
    }
    const skip = locationSkipReason(loc);
    if (skip) {
      counters.skipped++;
      onLog(`↪︎ Skipped ${loc.name} — ${skip}`);
      continue;
    }
    const existing = findTargetLocation(loc, tgt);
    if (existing) {
      counters.skipped++;
      onLog(`↪︎ Exists: ${loc.name}`);
      const pickup = pickupInput(loc, existing.id);
      if (pickup && !existing.localPickupSettingsV2 && !ctx.dryRun) {
        try {
          const { errs } = await mutate(ctx, M_PICKUP_ENABLE, { localPickupSettings: pickup }, "locationLocalPickupEnable");
          if (!errs.length) onLog(`  ↻ Local pickup turned on for ${loc.name}`);
          else onLog(`  ⚠ Local pickup for ${loc.name} — ${errText(errs)}`);
        } catch (err) {
          onLog(`  ⚠ Local pickup for ${loc.name} — ${short(err)}`);
        }
      }
      continue;
    }
    const built = locationAddInput(loc, await metafieldsInput(ctx, loc));
    if (built.skip) {
      counters.skipped++;
      onLog(`↪︎ Skipped ${loc.name} — ${built.skip}`);
      continue;
    }
    if (!ctx.canCreate()) {
      ctx.notCreated(`location ${loc.name}`);
      continue;
    }
    try {
      const { data, errs } = await mutate(ctx, M_LOCATION_ADD, { input: built.input }, "locationAdd");
      if (errs.length) {
        counters.failed++;
        const limit = errs.some((e) => /limit/i.test(`${e.code} ${e.message}`));
        onLog(
          `✕ ${loc.name} — ${errText(errs)}${limit ? " (this store's Shopify plan has no more location slots; upgrade the plan or deactivate a location here)" : ""}`,
        );
        continue;
      }
      const id = data?.location?.id;
      counters.created++;
      ctx.consume(id);
      tgt.push({ id, name: loc.name, isActive: true });
      ctx._locLists = null;
      onLog(`✓ Location: ${loc.name}`);
      const pickup = pickupInput(loc, id);
      if (pickup) {
        const r = await mutate(ctx, M_PICKUP_ENABLE, { localPickupSettings: pickup }, "locationLocalPickupEnable");
        if (r.errs.length) onLog(`  ⚠ Local pickup for ${loc.name} — ${errText(r.errs)}`);
        else onLog(`  ✓ Local pickup turned on`);
      }
    } catch (err) {
      counters.failed++;
      onLog(`✕ ${loc.name} — ${short(err)}`);
    }
    await sleep(200);
  }
  onLog("  Stock isn't moved by this step — run Stock levels after Locations.");
}

// ═════════════════════════════════════════════════════════════════════════════
//  SHIPPING (delivery profiles, location groups, zones, rates)
//
//  General profile: zones the target's general profile doesn't have yet (by
//  name) are added to the location group holding the same locations.
//  Custom profiles: created by name with their products (matched by handle and
//  variant title / SKU), locations (by name), zones and rates. Carrier-
//  calculated rates are linked to the carrier with the same name on this store.
// ═════════════════════════════════════════════════════════════════════════════
const Q_PROFILE_LIST = `#graphql
  query MoreProfiles($cursor: String) {
    deliveryProfiles(first: 25, after: $cursor, merchantOwnedOnly: true) {
      pageInfo { hasNextPage endCursor }
      edges { node { id name default } }
    }
  }`;

const Q_PROFILE_DETAIL = `#graphql
  query MoreProfile($id: ID!) {
    deliveryProfile(id: $id) {
      id name default
      profileLocationGroups {
        locationGroup { id locations(first: 50) { nodes { id name } } }
        locationGroupZones(first: 25) {
          nodes {
            zone { id name countries { code { countryCode restOfWorld } provinces { code } } }
            methodDefinitions(first: 25) {
              nodes {
                name description active
                rateProvider {
                  __typename
                  ... on DeliveryRateDefinition { price { amount currencyCode } }
                  ... on DeliveryParticipant {
                    carrierService { id name formattedName }
                    fixedFee { amount currencyCode }
                    percentageOfRateFee adaptToNewServicesFlag
                    participantServices { name active }
                  }
                }
                methodConditions {
                  field operator
                  conditionCriteria {
                    __typename
                    ... on MoneyV2 { amount currencyCode }
                    ... on Weight { unit value }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

const Q_PROFILE_ITEMS = `#graphql
  query MoreProfileItems($id: ID!, $cursor: String) {
    deliveryProfile(id: $id) {
      profileItems(first: 25, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { product { handle } variants(first: 100) { nodes { title sku } } }
      }
    }
  }`;

const Q_CARRIERS = `#graphql
  query MoreCarriers { carrierServices(first: 50) { nodes { id name formattedName active } } }`;

const Q_SHOP_CURRENCY = `#graphql
  query MoreShopCurrency { shop { id currencyCode } }`;

const M_PROFILE_CREATE = `#graphql
  mutation MoreProfileCreate($profile: DeliveryProfileInput!) {
    deliveryProfileCreate(profile: $profile) {
      profile { id name }
      userErrors { field message }
    }
  }`;

const M_PROFILE_UPDATE = `#graphql
  mutation MoreProfileUpdate($id: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $id, profile: $profile) {
      profile { id }
      userErrors { field message }
    }
  }`;

// target profile → [{ groupId, locationIds:Set, zones:[{id,name}] }]
function groupsOf(profile) {
  return (profile?.profileLocationGroups || []).map((g) => ({
    groupId: g.locationGroup.id,
    locationIds: new Set(nodes(g.locationGroup.locations).map((l) => l.id)),
    zones: nodes(g.locationGroupZones).map((z) => z.zone),
  }));
}

// rates keep their amounts; when the stores use different currencies they are
// written in this store's currency and the log says so
function retargetCurrency(zone, currency) {
  const fix = (m) => (m?.currencyCode ? { ...m, currencyCode: currency } : m);
  for (const md of zone.methodDefinitionsToCreate || []) {
    if (md.rateDefinition) md.rateDefinition.price = fix(md.rateDefinition.price);
    if (md.participant?.fixedFee) md.participant.fixedFee = fix(md.participant.fixedFee);
    for (const pc of md.priceConditionsToCreate || []) pc.criteria = fix(pc.criteria);
  }
}

async function profileVariantIds(ctx, profileId) {
  const ids = [];
  let missing = 0;
  let cursor = null;
  do {
    const d = await gql(ctx.source, Q_PROFILE_ITEMS, { id: profileId, cursor });
    const conn = d?.deliveryProfile?.profileItems;
    for (const item of nodes(conn)) {
      for (const v of nodes(item.variants)) {
        const id = await targetVariantId(ctx, { ...v, product: item.product });
        if (id) ids.push(id);
        else missing++;
      }
    }
    cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return { ids, missing };
}

export async function migrateShipping(ctx) {
  const { source, target, onLog, counters } = ctx;
  let list;
  let targetList;
  let carriers = new Map();
  let sourceCurrency;
  let targetCurrency;
  try {
    list = await fetchAll(source, Q_PROFILE_LIST, "deliveryProfiles");
    targetList = await fetchAll(target, Q_PROFILE_LIST, "deliveryProfiles");
    sourceCurrency = (await gql(source, Q_SHOP_CURRENCY))?.shop?.currencyCode;
    targetCurrency = (await gql(target, Q_SHOP_CURRENCY))?.shop?.currencyCode;
  } catch (err) {
    if (permissionStop(ctx, err, "Shipping")) return;
    throw err;
  }
  try {
    for (const c of nodes((await gql(target, Q_CARRIERS))?.carrierServices)) {
      if (c.active) carriers.set(carrierKey(c), c.id);
    }
  } catch {
    carriers = new Map();
  }
  const currencyDiffers = sourceCurrency && targetCurrency && sourceCurrency !== targetCurrency;
  if (currencyDiffers) {
    onLog(`⚠ The source store sells in ${sourceCurrency} and this store in ${targetCurrency}: rate amounts are copied as the same numbers in ${targetCurrency}. Check them after the run.`);
  }
  const { source: srcLocs, target: tgtLocs } = await locationLists(ctx);
  const oneToOne = srcLocs.length === 1 && tgtLocs.length === 1;
  onLog(`Total ${list.length} shipping profile(s) found.`);

  for (const p of list) {
    if (ctx.stopOnQuota()) {
      onLog("Quota reached — stopping shipping.");
      break;
    }
    let sp;
    try {
      sp = (await gql(source, Q_PROFILE_DETAIL, { id: p.id }))?.deliveryProfile;
    } catch (err) {
      counters.failed++;
      onLog(`✕ ${p.name} — couldn't read it: ${short(err)}`);
      continue;
    }
    const label = p.default ? `General profile` : `profile "${p.name}"`;
    const tp = p.default ? targetList.find((x) => x.default) : targetList.find((x) => !x.default && lc(x.name) === lc(p.name));
    let tDetail = null;
    if (tp) tDetail = (await gql(target, Q_PROFILE_DETAIL, { id: tp.id }))?.deliveryProfile;

    // build each source location group's zones
    const groups = [];
    for (const g of sp?.profileLocationGroups || []) {
      const names = nodes(g.locationGroup.locations).map((l) => l.name);
      const { ids, missing } = mapLocationIds(names, tgtLocs, { oneToOne });
      if (missing.length) onLog(`  ⚠ ${label}: no location named ${missing.join(", ")} here — copy Locations first`);
      const zones = [];
      for (const z of nodes(g.locationGroupZones)) {
        const built = zoneInput(z.zone, nodes(z.methodDefinitions), { carriers });
        for (const s of built.skipped) onLog(`  ⚠ ${label} › ${z.zone.name}: rate ${s} — not copied`);
        if (currencyDiffers) retargetCurrency(built.input, targetCurrency);
        zones.push(built.input);
      }
      groups.push({ ids, zones });
    }

    if (!tDetail) {
      // a new custom profile
      if (!ctx.canCreate()) {
        ctx.notCreated(`shipping ${label}`);
        continue;
      }
      const { ids: variantIds, missing } = await profileVariantIds(ctx, p.id);
      if (missing) onLog(`  ⚠ ${label}: ${missing} product variant(s) aren't on this store — copy Products first, then run Shipping again`);
      const profile = {
        name: p.name,
        locationGroupsToCreate: groups.filter((g) => g.ids.length).map((g) => ({ locations: g.ids, zonesToCreate: g.zones })),
      };
      if (variantIds.length) profile.variantsToAssociate = variantIds.slice(0, 250);
      try {
        const { data, errs } = await mutate(ctx, M_PROFILE_CREATE, { profile }, "deliveryProfileCreate");
        if (errs.length) {
          counters.failed++;
          onLog(`✕ ${label} — ${errText(errs)}`);
          continue;
        }
        const id = data?.profile?.id;
        counters.created++;
        ctx.consume(id);
        onLog(`✓ Shipping ${label}: ${profile.locationGroupsToCreate.reduce((n, g) => n + g.zonesToCreate.length, 0)} zone(s), ${variantIds.length} variant(s)`);
        for (let i = 250; i < variantIds.length; i += 250) {
          const r = await mutate(ctx, M_PROFILE_UPDATE, { id, profile: { variantsToAssociate: variantIds.slice(i, i + 250) } }, "deliveryProfileUpdate");
          if (r.errs.length) onLog(`  ⚠ ${label}: some variants weren't added — ${errText(r.errs)}`);
        }
      } catch (err) {
        counters.failed++;
        onLog(`✕ ${label} — ${short(err)}`);
      }
      await sleep(250);
      continue;
    }

    // an existing profile (General, or a custom one with the same name):
    // add only the zones it doesn't have yet
    const tGroups = groupsOf(tDetail);
    let added = 0;
    for (const g of groups) {
      if (!g.ids.length) continue;
      const tg = tGroups.find((x) => g.ids.some((id) => x.locationIds.has(id)));
      const have = new Set((tg?.zones || []).map((z) => lc(z.name)));
      const todo = [];
      for (const z of g.zones) {
        if (have.has(lc(z.name))) {
          counters.skipped++;
          onLog(`↪︎ Exists: ${label} › ${z.name}`);
        } else if (!ctx.canCreate()) {
          ctx.notCreated(`${label} › zone ${z.name}`);
        } else todo.push(z);
      }
      if (!todo.length) continue;
      // one zone per call, so one refused zone (e.g. a country already in
      // another zone) doesn't take the others down with it
      for (const z of todo) {
        const one = tg
          ? { locationGroupsToUpdate: [{ id: tg.groupId, zonesToCreate: [z] }] }
          : { locationGroupsToCreate: [{ locations: g.ids, zonesToCreate: [z] }] };
        try {
          const { errs } = await mutate(ctx, M_PROFILE_UPDATE, { id: tDetail.id, profile: one }, "deliveryProfileUpdate");
          if (errs.length) {
            counters.failed++;
            onLog(`✕ ${label} › ${z.name} — ${errText(errs)}`);
            continue;
          }
          added++;
          counters.created++;
          // find the new zone's id for Undo
          const fresh = (await gql(target, Q_PROFILE_DETAIL, { id: tDetail.id }))?.deliveryProfile;
          const zone = groupsOf(fresh).flatMap((x) => x.zones).find((x) => lc(x.name) === lc(z.name));
          ctx.consume(zone ? `${zone.id}?profile=${encodeURIComponent(tDetail.id)}` : null);
          onLog(`✓ ${label} › zone ${z.name} (${z.methodDefinitionsToCreate.length} rate(s))`);
          if (!tg) break; // the new group exists now; next zones go in on a re-run
        } catch (err) {
          counters.failed++;
          onLog(`✕ ${label} › ${z.name} — ${short(err)}`);
        }
        await sleep(200);
      }
    }
    if (!added && !p.default) {
      // keep product links of an existing custom profile current
      try {
        const { ids } = await profileVariantIds(ctx, p.id);
        if (ids.length && !ctx.dryRun) {
          await mutate(ctx, M_PROFILE_UPDATE, { id: tDetail.id, profile: { variantsToAssociate: ids.slice(0, 250) } }, "deliveryProfileUpdate");
        }
      } catch {
        /* products stay as they are */
      }
    }
  }
  onLog("  Local delivery areas, packages and shipping label settings aren't open to apps — see Manual steps.");
}

// ═════════════════════════════════════════════════════════════════════════════
//  CATALOGS + PRICE LISTS (used by Markets and B2B)
// ═════════════════════════════════════════════════════════════════════════════
const CATALOG_FIELDS = `
  id title status
  priceList { id name currency parent { adjustment { type value } settings { compareAtMode } } }
  publication { id autoPublish }`;

const Q_PRICE_LIST_PRICES = `#graphql
  query MorePrices($id: ID!, $cursor: String) {
    priceList(id: $id) {
      prices(first: 100, after: $cursor, originType: FIXED) {
        pageInfo { hasNextPage endCursor }
        nodes {
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
          variant { title sku product { handle } }
        }
      }
    }
  }`;

const Q_PUBLICATION_PRODUCTS = `#graphql
  query MorePubProducts($id: ID!, $cursor: String) {
    publication(id: $id) {
      products(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { handle }
      }
    }
  }`;

const M_PRICE_LIST_CREATE = `#graphql
  mutation MorePriceListCreate($input: PriceListCreateInput!) {
    priceListCreate(input: $input) {
      priceList { id }
      userErrors { field message }
    }
  }`;

const M_PRICE_LIST_DELETE = `#graphql
  mutation MorePriceListDelete($id: ID!) {
    priceListDelete(id: $id) {
      deletedId
      userErrors { field message }
    }
  }`;

const M_FIXED_PRICES_ADD = `#graphql
  mutation MoreFixedPrices($priceListId: ID!, $prices: [PriceListPriceInput!]!) {
    priceListFixedPricesAdd(priceListId: $priceListId, prices: $prices) {
      prices { price { amount } }
      userErrors { field message }
    }
  }`;

const M_CATALOG_CREATE = `#graphql
  mutation MoreCatalogCreate($input: CatalogCreateInput!) {
    catalogCreate(input: $input) {
      catalog { id }
      userErrors { field message }
    }
  }`;

const M_CATALOG_CONTEXT = `#graphql
  mutation MoreCatalogContext($catalogId: ID!, $contextsToAdd: CatalogContextInput) {
    catalogContextUpdate(catalogId: $catalogId, contextsToAdd: $contextsToAdd) {
      catalog { id }
      userErrors { field message }
    }
  }`;

const M_PUBLICATION_CREATE = `#graphql
  mutation MorePublicationCreate($input: PublicationCreateInput!) {
    publicationCreate(input: $input) {
      publication { id }
      userErrors { field message }
    }
  }`;

const M_PUBLISH = `#graphql
  mutation MorePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }`;

async function copyFixedPrices(ctx, sourcePriceListId, targetPriceListId, label) {
  let cursor = null;
  let copied = 0;
  let missing = 0;
  do {
    const d = await gql(ctx.source, Q_PRICE_LIST_PRICES, { id: sourcePriceListId, cursor });
    const conn = d?.priceList?.prices;
    const keyToId = new Map();
    for (const p of nodes(conn)) {
      const id = await targetVariantId(ctx, p.variant);
      if (id) for (const k of variantKeys(p.variant)) keyToId.set(k, id);
    }
    const built = fixedPricesInput(nodes(conn), variantKeys, keyToId);
    missing += built.missing.length;
    if (built.prices.length) {
      const { errs } = await mutate(ctx, M_FIXED_PRICES_ADD, { priceListId: targetPriceListId, prices: built.prices }, "priceListFixedPricesAdd");
      if (errs.length) ctx.onLog(`  ⚠ ${label}: some fixed prices weren't copied — ${errText(errs)}`);
      else copied += built.prices.length;
    }
    cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  if (copied) ctx.onLog(`  ✓ ${copied} fixed price(s)`);
  if (missing) ctx.onLog(`  ⚠ ${label}: ${missing} fixed price(s) skipped — their products aren't on this store`);
}

async function copyPublication(ctx, sourcePub, catalogId, label) {
  const { data, errs } = await mutate(
    ctx,
    M_PUBLICATION_CREATE,
    { input: { catalogId, autoPublish: !!sourcePub.autoPublish, defaultState: "EMPTY" } },
    "publicationCreate",
  );
  if (errs.length) {
    ctx.onLog(`  ⚠ ${label}: product list not copied — ${errText(errs)}`);
    return;
  }
  const publicationId = data?.publication?.id;
  let cursor = null;
  let added = 0;
  let missing = 0;
  do {
    const d = await gql(ctx.source, Q_PUBLICATION_PRODUCTS, { id: sourcePub.id, cursor });
    const conn = d?.publication?.products;
    for (const p of nodes(conn)) {
      const tp = await targetProduct(ctx, p.handle);
      if (!tp?.id) {
        missing++;
        continue;
      }
      const r = await mutate(ctx, M_PUBLISH, { id: tp.id, input: [{ publicationId }] }, "publishablePublish");
      if (!r.errs.length) added++;
      await sleep(60);
    }
    cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  ctx.onLog(`  ✓ ${added} product(s) in the catalog${missing ? `, ${missing} not on this store yet` : ""}`);
}

// → target catalog id, or null. context: { marketIds } | { companyLocationIds }
async function copyCatalog(ctx, cat, context, label) {
  let priceListId = null;
  if (cat.priceList) {
    const { data, errs } = await mutate(
      ctx,
      M_PRICE_LIST_CREATE,
      { input: priceListInput(cat.priceList, `${cat.title} prices`) },
      "priceListCreate",
    );
    if (errs.length) {
      ctx.onLog(`  ⚠ ${label}: price list not copied — ${errText(errs)}`);
    } else {
      priceListId = data?.priceList?.id;
    }
  }
  const input = { title: cat.title, status: cat.status || "ACTIVE", context };
  if (priceListId) input.priceListId = priceListId;
  const { data, errs } = await mutate(ctx, M_CATALOG_CREATE, { input }, "catalogCreate");
  if (errs.length) {
    ctx.onLog(`  ✕ ${label}: catalog "${cat.title}" — ${errText(errs)}`);
    ctx.counters.failed++;
    if (priceListId) await gql(ctx.target, M_PRICE_LIST_DELETE, { id: priceListId }).catch(() => {});
    return null;
  }
  const catalogId = data?.catalog?.id;
  ctx.record(catalogId);
  ctx.onLog(`  ✓ Catalog "${cat.title}"${priceListId ? ` with price list (${cat.priceList.parent?.adjustment?.type === "PERCENTAGE_INCREASE" ? "+" : "−"}${cat.priceList.parent?.adjustment?.value ?? 0}%, ${cat.priceList.currency})` : ""}`);
  if (priceListId) await copyFixedPrices(ctx, cat.priceList.id, priceListId, label);
  if (cat.publication?.id) await copyPublication(ctx, cat.publication, catalogId, label);
  return catalogId;
}

// ═════════════════════════════════════════════════════════════════════════════
//  MARKETS
//  Region markets: countries, currency settings, tax / duty display, language
//  subfolders (web presences) and catalogs with their price list adjustment,
//  fixed prices and product list. The source's home market is left to the
//  target's own home market.
// ═════════════════════════════════════════════════════════════════════════════
const Q_MARKET_LIST = `#graphql
  query MoreMarkets($cursor: String) {
    markets(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id name handle type status primary } }
    }
  }`;

const Q_MARKET_DETAIL = `#graphql
  query MoreMarket($id: ID!) {
    market(id: $id) {
      id name handle status type
      conditions {
        conditionTypes
        regionsCondition { regions(first: 250) { nodes { __typename ... on MarketRegionCountry { code } } } }
      }
      currencySettings { baseCurrency { currencyCode manualRate } localCurrencies roundingEnabled }
      priceInclusions { inclusiveTaxPricingStrategy inclusiveDutiesPricingStrategy adaptivePricingEnabled }
      webPresences(first: 10) {
        nodes { id subfolderSuffix domain { host } defaultLocale { locale } alternateLocales { locale } }
      }
      catalogs(first: 5) { nodes { ${CATALOG_FIELDS} } }
      ${MF}
    }
  }`;

const Q_WEB_PRESENCES = `#graphql
  query MoreWebPresences($cursor: String) {
    webPresences(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id subfolderSuffix domain { host } } }
    }
  }`;

const Q_LOCALES = `#graphql
  query MoreLocales { shopLocales { locale } }`;

const M_WEB_PRESENCE_CREATE = `#graphql
  mutation MoreWebPresenceCreate($input: WebPresenceCreateInput!) {
    webPresenceCreate(input: $input) {
      webPresence { id }
      userErrors { field message }
    }
  }`;

const M_MARKET_CREATE = `#graphql
  mutation MoreMarketCreate($input: MarketCreateInput!) {
    marketCreate(input: $input) {
      market { id name status }
      userErrors { field message }
    }
  }`;

export async function migrateMarkets(ctx) {
  const { source, target, onLog, counters } = ctx;
  let list;
  let tMarkets;
  let tPresences;
  let tLocales;
  try {
    list = await fetchAll(source, Q_MARKET_LIST, "markets");
    tMarkets = await fetchAll(target, Q_MARKET_LIST, "markets");
    tPresences = await fetchAll(target, Q_WEB_PRESENCES, "webPresences");
    tLocales = ((await gql(target, Q_LOCALES))?.shopLocales || []).map((l) => l.locale);
  } catch (err) {
    if (permissionStop(ctx, err, "Markets")) return;
    throw err;
  }
  onLog(`Total ${list.length} market(s) found.`);

  for (const m of list) {
    if (ctx.stopOnQuota()) {
      onLog("Quota reached — stopping markets.");
      break;
    }
    if (m.primary) {
      counters.skipped++;
      onLog(`↪︎ Skipped ${m.name} — the source's home market; this store keeps its own`);
      continue;
    }
    if (!COPYABLE_MARKET_TYPES.has(m.type)) {
      counters.skipped++;
      onLog(`↪︎ Skipped ${m.name} — ${m.type === "COMPANY_LOCATION" ? "B2B market (copied with B2B)" : "point-of-sale / channel market, set it up here by hand"}`);
      continue;
    }
    if (findExistingMarket(m, tMarkets)) {
      counters.skipped++;
      onLog(`↪︎ Exists: ${m.name}`);
      continue;
    }
    if (!ctx.canCreate()) {
      ctx.notCreated(`market ${m.name}`);
      continue;
    }
    let sm;
    try {
      sm = (await gql(source, Q_MARKET_DETAIL, { id: m.id }))?.market;
    } catch (err) {
      counters.failed++;
      onLog(`✕ ${m.name} — couldn't read it: ${short(err)}`);
      continue;
    }

    // languages / subfolders first, so the market can be created with them
    const webPresenceIds = [];
    for (const wp of nodes(sm?.webPresences)) {
      const key = webPresenceKey(wp);
      const have = tPresences.find((x) => webPresenceKey(x) === key);
      if (have) {
        webPresenceIds.push(have.id);
        continue;
      }
      const built = webPresenceInput(wp, tLocales);
      if (built.skip) {
        onLog(`  ⚠ ${m.name}: web address ${wp.subfolderSuffix ? `/${wp.subfolderSuffix}` : wp.domain?.host || ""} not copied — ${built.skip}`);
        continue;
      }
      try {
        const { data, errs } = await mutate(ctx, M_WEB_PRESENCE_CREATE, { input: built.input }, "webPresenceCreate");
        if (errs.length) {
          onLog(`  ⚠ ${m.name}: subfolder /${wp.subfolderSuffix} — ${errText(errs)}`);
          continue;
        }
        const id = data?.webPresence?.id;
        ctx.record(id);
        tPresences.push({ id, subfolderSuffix: wp.subfolderSuffix });
        webPresenceIds.push(id);
        onLog(`  ✓ Subfolder /${wp.subfolderSuffix} (${[built.input.defaultLocale, ...built.input.alternateLocales].join(", ")})`);
      } catch (err) {
        onLog(`  ⚠ ${m.name}: subfolder /${wp.subfolderSuffix} — ${short(err)}`);
      }
    }

    try {
      const input = marketCreateInput(sm, { webPresenceIds });
      const { data, errs } = await mutate(ctx, M_MARKET_CREATE, { input }, "marketCreate");
      if (errs.length) {
        counters.failed++;
        onLog(`✕ ${m.name} — ${errText(errs)}`);
        continue;
      }
      const id = data?.market?.id;
      counters.created++;
      ctx.consume(id);
      tMarkets.push({ id, name: m.name, handle: m.handle });
      const countries = input.conditions?.regionsCondition?.regions?.length || 0;
      onLog(`✓ Market ${m.name}: ${countries} countr${countries === 1 ? "y" : "ies"}${input.currencySettings ? `, ${input.currencySettings.baseCurrency}` : ""}${data?.market?.status === "DRAFT" && sm.status === "ACTIVE" ? " — saved as draft (another market here already covers one of its countries)" : ""}`);
      await copyMetafieldsTo(ctx, sm, id, `market ${m.name}`);
      for (const cat of nodes(sm.catalogs)) {
        await copyCatalog(ctx, cat, { marketIds: [id] }, m.name);
      }
    } catch (err) {
      counters.failed++;
      onLog(`✕ ${m.name} — ${short(err)}`);
    }
    await sleep(250);
  }
  onLog("  Market domains, POS location markets and market-specific translations aren't copied.");
}

// ═════════════════════════════════════════════════════════════════════════════
//  B2B (companies, company locations, contacts, roles, catalogs)
//  B2B needs Shopify Plus (or a development store) on both stores. Contacts
//  are linked to the customer with the same email on this store, so run
//  Customers first.
// ═════════════════════════════════════════════════════════════════════════════
const Q_SHOP_PLAN = `#graphql
  query MoreShopPlan { shop { plan { shopifyPlus partnerDevelopment publicDisplayName } } }`;

const Q_COMPANY_LIST = `#graphql
  query MoreCompanies($cursor: String) {
    companies(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id name externalId } }
    }
  }`;

const ADDRESS = `address1 address2 city countryCode firstName lastName phone recipient zip zoneCode`;

const Q_COMPANY_DETAIL = `#graphql
  query MoreCompany($id: ID!) {
    company(id: $id) {
      id name note externalId customerSince
      mainContact { customer { defaultEmailAddress { emailAddress } } }
      ${MF}
      locations(first: 50) {
        nodes {
          id name phone locale note externalId
          shippingAddress { ${ADDRESS} }
          billingAddress { ${ADDRESS} }
          taxSettings { taxExempt taxExemptions taxRegistrationId }
          buyerExperienceConfiguration { checkoutToDraft editableShippingAddress paymentTermsTemplate { name } }
          catalogs(first: 5) { nodes { ${CATALOG_FIELDS} } }
          ${MF}
        }
      }
      contacts(first: 50) {
        nodes {
          title
          customer { defaultEmailAddress { emailAddress } }
          roleAssignments(first: 50) { nodes { role { name } companyLocation { name } } }
        }
      }
    }
  }`;

const Q_TARGET_COMPANY_PARTS = `#graphql
  query MoreCompanyParts($id: ID!) {
    company(id: $id) {
      contactRoles(first: 10) { nodes { id name } }
      locations(first: 50) { nodes { id name } }
    }
  }`;

const Q_PAYMENT_TERMS = `#graphql
  query MoreTerms { paymentTermsTemplates { id name } }`;

const Q_CUSTOMER_BY_EMAIL = `#graphql
  query MoreCustomerByEmail($q: String!) {
    customers(first: 1, query: $q) { nodes { id } }
  }`;

const M_COMPANY_CREATE = `#graphql
  mutation MoreCompanyCreate($input: CompanyCreateInput!) {
    companyCreate(input: $input) {
      company { id }
      userErrors { field message code }
    }
  }`;

const M_COMPANY_LOCATION_CREATE = `#graphql
  mutation MoreCompanyLocationCreate($companyId: ID!, $input: CompanyLocationInput!) {
    companyLocationCreate(companyId: $companyId, input: $input) {
      companyLocation { id name }
      userErrors { field message }
    }
  }`;

const M_ASSIGN_CONTACT = `#graphql
  mutation MoreAssignContact($companyId: ID!, $customerId: ID!) {
    companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
      companyContact { id }
      userErrors { field message }
    }
  }`;

const M_ASSIGN_ROLES = `#graphql
  mutation MoreAssignRoles($companyContactId: ID!, $rolesToAssign: [CompanyContactRoleAssign!]!) {
    companyContactAssignRoles(companyContactId: $companyContactId, rolesToAssign: $rolesToAssign) {
      userErrors { field message }
    }
  }`;

const M_MAIN_CONTACT = `#graphql
  mutation MoreMainContact($companyId: ID!, $companyContactId: ID!) {
    companyAssignMainContact(companyId: $companyId, companyContactId: $companyContactId) {
      userErrors { field message }
    }
  }`;

export async function migrateB2B(ctx) {
  const { source, target, onLog, counters } = ctx;
  let tPlan;
  try {
    tPlan = (await gql(target, Q_SHOP_PLAN))?.shop?.plan;
  } catch {
    tPlan = null;
  }
  let list;
  try {
    list = await fetchAll(source, Q_COMPANY_LIST, "companies");
  } catch (err) {
    if (permissionStop(ctx, err, "B2B companies")) return;
    onLog(`⚠ The source store has no B2B companies to read (B2B needs Shopify Plus): ${short(err)}`);
    return;
  }
  if (!list.length) {
    onLog("No B2B companies on the source store.");
    return;
  }
  let tCompanies;
  try {
    tCompanies = await fetchAll(target, Q_COMPANY_LIST, "companies");
  } catch (err) {
    counters.skipped += list.length;
    onLog(`⚠ ${list.length} compan${list.length === 1 ? "y" : "ies"} not copied — this store can't use B2B (it needs Shopify Plus${tPlan?.publicDisplayName ? `; it is on ${tPlan.publicDisplayName}` : ""}). ${short(err)}`);
    return;
  }
  if (tPlan && !tPlan.shopifyPlus && !tPlan.partnerDevelopment) {
    onLog(`⚠ This store is on ${tPlan.publicDisplayName || "a plan without Plus"}. Shopify allows B2B companies only on Shopify Plus, so creating them may be refused.`);
  }
  let termsByName = new Map();
  try {
    termsByName = new Map(((await gql(target, Q_PAYMENT_TERMS))?.paymentTermsTemplates || []).map((t) => [lc(t.name), t.id]));
  } catch {
    /* payment terms left empty */
  }
  const catalogMap = new Map(); // source catalog id → target catalog id
  onLog(`Total ${list.length} compan${list.length === 1 ? "y" : "ies"} found.`);

  for (const c of list) {
    if (ctx.stopOnQuota()) {
      onLog("Quota reached — stopping B2B.");
      break;
    }
    if (findExistingCompany(c, tCompanies)) {
      counters.skipped++;
      onLog(`↪︎ Exists: ${c.name}`);
      continue;
    }
    if (!ctx.canCreate()) {
      ctx.notCreated(`company ${c.name}`);
      continue;
    }
    let sc;
    try {
      sc = (await gql(source, Q_COMPANY_DETAIL, { id: c.id }))?.company;
    } catch (err) {
      counters.failed++;
      onLog(`✕ ${c.name} — couldn't read it: ${short(err)}`);
      continue;
    }
    const locs = nodes(sc.locations);
    try {
      const input = { company: companyInput(sc) };
      if (locs[0]) input.companyLocation = companyLocationInput(locs[0], { termsByName });
      const { data, errs } = await mutate(ctx, M_COMPANY_CREATE, { input }, "companyCreate");
      if (errs.length) {
        counters.failed++;
        onLog(`✕ ${c.name} — ${errText(errs)}`);
        continue;
      }
      const companyId = data?.company?.id;
      counters.created++;
      ctx.consume(companyId);
      tCompanies.push({ id: companyId, name: c.name, externalId: c.externalId });
      await copyMetafieldsTo(ctx, sc, companyId, c.name);

      const parts = (await gql(target, Q_TARGET_COMPANY_PARTS, { id: companyId }))?.company;
      const roles = nodes(parts?.contactRoles);
      const tLocs = new Map(nodes(parts?.locations).map((l) => [lc(l.name), l.id]));
      for (const l of locs.slice(1)) {
        const r = await mutate(ctx, M_COMPANY_LOCATION_CREATE, { companyId, input: companyLocationInput(l, { termsByName }) }, "companyLocationCreate");
        if (r.errs.length) onLog(`  ⚠ ${c.name} › ${l.name} — ${errText(r.errs)}`);
        else tLocs.set(lc(l.name), r.data?.companyLocation?.id);
      }
      onLog(`✓ Company ${c.name}: ${tLocs.size} location(s)`);
      for (const l of locs) {
        const tl = tLocs.get(lc(l.name));
        if (tl) await copyMetafieldsTo(ctx, l, tl, `${c.name} › ${l.name}`);
      }

      // contacts → existing customers by email
      const mainEmail = lc(sc.mainContact?.customer?.defaultEmailAddress?.emailAddress);
      let linked = 0;
      let missing = 0;
      for (const ct of nodes(sc.contacts)) {
        const email = ct.customer?.defaultEmailAddress?.emailAddress;
        if (!email) continue;
        const found = await gql(target, Q_CUSTOMER_BY_EMAIL, { q: `email:${qv(email)}` });
        const customerId = nodes(found?.customers)[0]?.id;
        if (!customerId) {
          missing++;
          continue;
        }
        const a = await mutate(ctx, M_ASSIGN_CONTACT, { companyId, customerId }, "companyAssignCustomerAsContact");
        const contactId = a.data?.companyContact?.id;
        if (a.errs.length || !contactId) {
          onLog(`  ⚠ ${c.name}: a contact wasn't linked — ${errText(a.errs)}`);
          continue;
        }
        linked++;
        const rolesToAssign = nodes(ct.roleAssignments)
          .map((ra) => ({
            companyContactRoleId: roleIdByName(roles, ra.role?.name),
            companyLocationId: tLocs.get(lc(ra.companyLocation?.name)),
          }))
          .filter((r) => r.companyContactRoleId && r.companyLocationId);
        if (rolesToAssign.length) {
          const r = await mutate(ctx, M_ASSIGN_ROLES, { companyContactId: contactId, rolesToAssign }, "companyContactAssignRoles");
          if (r.errs.length) onLog(`  ⚠ ${c.name}: contact roles — ${errText(r.errs)}`);
        }
        if (mainEmail && lc(email) === mainEmail) {
          await mutate(ctx, M_MAIN_CONTACT, { companyId, companyContactId: contactId }, "companyAssignMainContact");
        }
      }
      if (linked) onLog(`  ✓ ${linked} contact(s) linked to their customers`);
      if (missing) onLog(`  ⚠ ${missing} contact(s) not linked — their customer isn't on this store yet. Copy Customers, then run B2B again for new companies.`);

      // catalogs (shared catalogs are created once and extended)
      for (const l of locs) {
        const tl = tLocs.get(lc(l.name));
        if (!tl) continue;
        for (const cat of nodes(l.catalogs)) {
          if (catalogMap.has(cat.id)) {
            const r = await mutate(ctx, M_CATALOG_CONTEXT, { catalogId: catalogMap.get(cat.id), contextsToAdd: { companyLocationIds: [tl] } }, "catalogContextUpdate");
            if (r.errs.length) onLog(`  ⚠ ${c.name} › ${l.name}: catalog "${cat.title}" — ${errText(r.errs)}`);
            continue;
          }
          const id = await copyCatalog(ctx, cat, { companyLocationIds: [tl] }, `${c.name} › ${l.name}`);
          if (id) catalogMap.set(cat.id, id);
        }
      }
    } catch (err) {
      counters.failed++;
      onLog(`✕ ${c.name} — ${short(err)}`);
    }
    await sleep(250);
  }
  onLog("  Store credit, staff assignments and vaulted payment methods of companies aren't copied.");
}

// ═════════════════════════════════════════════════════════════════════════════
//  SELLING PLAN GROUPS (subscriptions, pre-orders, try before you buy)
//
//  Plans copied by ZS StoreSync are owned by ZS StoreSync on this store, and
//  Shopify sends their subscription contracts and remaining-balance charges to
//  the owning app. ZS StoreSync doesn't bill renewals, so plans that charge
//  after checkout are only copied when the merchant ticks that they understand
//  (options.sellingPlansAck); one-time plans paid in full at checkout always
//  copy.
// ═════════════════════════════════════════════════════════════════════════════
const Q_SPG_LIST = `#graphql
  query MoreSPGs($cursor: String) {
    sellingPlanGroups(first: 50, after: $cursor, query: "app_id:ALL") {
      pageInfo { hasNextPage endCursor }
      edges { node { id name merchantCode appId } }
    }
  }`;

const POLICY_ANCHORS = `anchors { type day month cutoffDay }`;
const Q_SPG_DETAIL = `#graphql
  query MoreSPG($id: ID!) {
    sellingPlanGroup(id: $id) {
      id name merchantCode description options position
      sellingPlans(first: 31) {
        nodes {
          name description options position category
          inventoryPolicy { reserve }
          billingPolicy {
            __typename
            ... on SellingPlanRecurringBillingPolicy { interval intervalCount minCycles maxCycles ${POLICY_ANCHORS} }
            ... on SellingPlanFixedBillingPolicy {
              remainingBalanceChargeTrigger remainingBalanceChargeExactTime remainingBalanceChargeTimeAfterCheckout
              checkoutCharge {
                type
                value { __typename ... on MoneyV2 { amount } ... on SellingPlanCheckoutChargePercentageValue { percentage } }
              }
            }
          }
          deliveryPolicy {
            __typename
            ... on SellingPlanRecurringDeliveryPolicy { interval intervalCount cutoff intent preAnchorBehavior ${POLICY_ANCHORS} }
            ... on SellingPlanFixedDeliveryPolicy { cutoff fulfillmentTrigger fulfillmentExactTime fixedIntent: intent fixedPreAnchorBehavior: preAnchorBehavior ${POLICY_ANCHORS} }
          }
          pricingPolicies {
            __typename
            ... on SellingPlanFixedPricingPolicy {
              adjustmentType
              adjustmentValue { __typename ... on MoneyV2 { amount } ... on SellingPlanPricingPolicyPercentageValue { percentage } }
            }
            ... on SellingPlanRecurringPricingPolicy {
              adjustmentType afterCycle
              adjustmentValue { __typename ... on MoneyV2 { amount } ... on SellingPlanPricingPolicyPercentageValue { percentage } }
            }
          }
        }
      }
    }
  }`;

const Q_SPG_PRODUCTS = `#graphql
  query MoreSPGProducts($id: ID!, $cursor: String) {
    sellingPlanGroup(id: $id) {
      products(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { handle }
      }
    }
  }`;

const Q_SPG_VARIANTS = `#graphql
  query MoreSPGVariants($id: ID!, $cursor: String) {
    sellingPlanGroup(id: $id) {
      productVariants(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { title sku product { handle } }
      }
    }
  }`;

const M_SPG_CREATE = `#graphql
  mutation MoreSPGCreate($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
    sellingPlanGroupCreate(input: $input, resources: $resources) {
      sellingPlanGroup { id }
      userErrors { field message }
    }
  }`;

const M_SPG_ADD_PRODUCTS = `#graphql
  mutation MoreSPGAddProducts($id: ID!, $productIds: [ID!]!) {
    sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
      userErrors { field message }
    }
  }`;

const M_SPG_ADD_VARIANTS = `#graphql
  mutation MoreSPGAddVariants($id: ID!, $productVariantIds: [ID!]!) {
    sellingPlanGroupAddProductVariants(id: $id, productVariantIds: $productVariantIds) {
      userErrors { field message }
    }
  }`;

async function pagedNodes(admin, query, root, conn, variables) {
  const out = [];
  let cursor = null;
  do {
    const d = await gql(admin, query, { ...variables, cursor });
    const c = d?.[root]?.[conn];
    out.push(...nodes(c));
    cursor = c?.pageInfo?.hasNextPage ? c.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

export async function migrateSellingPlans(ctx) {
  const { source, target, onLog, counters } = ctx;
  let list;
  let tList;
  try {
    list = await fetchAll(source, Q_SPG_LIST, "sellingPlanGroups");
    tList = await fetchAll(target, Q_SPG_LIST, "sellingPlanGroups");
  } catch (err) {
    if (permissionStop(ctx, err, "Selling plans")) return;
    throw err;
  }
  const have = new Set(tList.map(groupKey));
  const ack = !!ctx.options?.sellingPlansAck;
  onLog(`Total ${list.length} selling plan group(s) found.`);
  let heldBack = 0;
  let made = 0;

  for (const g of list) {
    if (ctx.stopOnQuota()) {
      onLog("Quota reached — stopping selling plans.");
      break;
    }
    if (have.has(groupKey(g))) {
      counters.skipped++;
      onLog(`↪︎ Exists: ${g.name}`);
      continue;
    }
    let sg;
    try {
      sg = (await gql(source, Q_SPG_DETAIL, { id: g.id }))?.sellingPlanGroup;
    } catch (err) {
      counters.failed++;
      onLog(`✕ ${g.name} — couldn't read it: ${short(err)}`);
      continue;
    }
    if (needsBillingApp(sg) && !ack) {
      counters.skipped++;
      heldBack++;
      onLog(`↪︎ Held back ${g.name} — it charges customers after checkout (renewals or a remaining balance). Tick "I understand" on the Migrate page to copy it anyway.`);
      continue;
    }
    if (!ctx.canCreate()) {
      ctx.notCreated(`selling plan group ${g.name}`);
      continue;
    }
    try {
      const productIds = [];
      const productHandles = new Set();
      let missing = 0;
      for (const p of await pagedNodes(source, Q_SPG_PRODUCTS, "sellingPlanGroup", "products", { id: g.id })) {
        productHandles.add(p.handle);
        const tp = await targetProduct(ctx, p.handle);
        if (tp?.id) productIds.push(tp.id);
        else missing++;
      }
      const variantIds = [];
      for (const v of await pagedNodes(source, Q_SPG_VARIANTS, "sellingPlanGroup", "productVariants", { id: g.id })) {
        if (productHandles.has(v.product?.handle)) continue; // the whole product is in already
        const id = await targetVariantId(ctx, v);
        if (id) variantIds.push(id);
        else missing++;
      }
      const resources = { productIds: productIds.slice(0, 250), productVariantIds: variantIds.slice(0, 250) };
      const { data, errs } = await mutate(ctx, M_SPG_CREATE, { input: sellingPlanGroupInput(sg), resources }, "sellingPlanGroupCreate");
      if (errs.length) {
        counters.failed++;
        onLog(`✕ ${g.name} — ${errText(errs)}`);
        continue;
      }
      const id = data?.sellingPlanGroup?.id;
      counters.created++;
      made++;
      ctx.consume(id);
      have.add(groupKey(g));
      for (let i = 250; i < productIds.length; i += 250) {
        await mutate(ctx, M_SPG_ADD_PRODUCTS, { id, productIds: productIds.slice(i, i + 250) }, "sellingPlanGroupAddProducts");
      }
      for (let i = 250; i < variantIds.length; i += 250) {
        await mutate(ctx, M_SPG_ADD_VARIANTS, { id, productVariantIds: variantIds.slice(i, i + 250) }, "sellingPlanGroupAddProductVariants");
      }
      onLog(`✓ ${g.name}: ${nodes(sg.sellingPlans).length} plan(s), ${productIds.length} product(s)${variantIds.length ? `, ${variantIds.length} variant(s)` : ""}`);
      if (missing) onLog(`  ⚠ ${missing} product(s)/variant(s) aren't on this store — copy Products first`);
    } catch (err) {
      counters.failed++;
      onLog(`✕ ${g.name} — ${short(err)}`);
    }
    await sleep(250);
  }
  if (made) {
    onLog("⚠ Copied plans belong to ZS StoreSync on this store. ZS StoreSync doesn't charge renewals: install your subscription / pre-order app here and set its plans up with that app before selling them. Existing subscription contracts are never copied.");
  }
  if (heldBack) onLog(`  ${heldBack} group(s) held back for that reason.`);
}
