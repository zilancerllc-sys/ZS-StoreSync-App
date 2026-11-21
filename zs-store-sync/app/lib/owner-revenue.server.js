// app/lib/owner-revenue.server.js
// The owner dashboard's money cards: stores on a paid plan now, stores on a
// paid plan's free trial, monthly recurring revenue, and an estimate of what
// has been earned so far. Ported from ZS Bundles (same file there).
// Reads across every shop -- callers MUST have passed requireOwnerShop() first.
//
// Source: Shopify itself. For each store, its own offline token reads
// currentAppInstallation.allSubscriptions (name, status, test, createdAt,
// trialDays, currentPeriodEnd, price, interval). The plan cached in this app's
// database cannot tell a trial from a charged plan, nor what was charged
// before, so it is not used for money.
//
// What is left out: test charges, and every store the dashboard already leaves
// out of its numbers (our own stores, App Review, test-marked, development,
// closed / frozen / dormant, uninstalled) -- the caller passes only the shops
// that remain.
//
// Limits (shown on the page): a store that uninstalled can no longer be asked,
// so what it paid before leaving is not in the total; plan changes inside a
// billing cycle are prorated by Shopify, which this does not see. Partners ->
// Payouts is the exact figure.
//
// One Shopify call per store, so the answer is cached in memory for a few
// hours and refreshed by "Check stores" (the same button that re-checks stores).
import { unauthenticated } from "../shopify.server";

const DAY = 24 * 3600 * 1000;
const PERIOD_30 = 30 * DAY;
const PERIOD_YEAR = 365 * DAY;
const CACHE_MS = 6 * 3600 * 1000;

const Q_SUBS = `#graphql
  {
    currentAppInstallation {
      allSubscriptions(first: 50, reverse: true) {
        nodes {
          name status test createdAt trialDays currentPeriodEnd
          lineItems {
            plan {
              pricingDetails {
                __typename
                ... on AppRecurringPricing { price { amount currencyCode } interval }
              }
            }
          }
        }
      }
    }
  }`;

// The recurring price of a subscription: { amount, currency, annual }.
function priceOf(sub) {
  for (const li of sub.lineItems || []) {
    const p = li?.plan?.pricingDetails;
    if (p?.__typename === "AppRecurringPricing" && p.price) {
      return { amount: Number(p.price.amount) || 0, currency: p.price.currencyCode || "USD", annual: p.interval === "ANNUAL" };
    }
  }
  return null;
}

// Money from one store's subscriptions. Exported for tests.
export function moneyFromSubscriptions(subs, now = Date.now()) {
  let paidNow = false;
  let onTrial = false;
  let trialEndsAt = null; // the soonest end of a paid plan's Shopify free trial
  let monthly = 0;
  let earned = 0;
  let unknownPast = 0; // ended subscriptions whose billed time Shopify does not say
  const currencies = new Set();
  for (const s of subs || []) {
    if (s.test) continue; // test charges cost the merchant nothing
    const price = priceOf(s);
    if (!price || price.amount <= 0) continue;
    const created = new Date(s.createdAt).getTime();
    if (!Number.isFinite(created)) continue;
    const trialEnd = created + (Number(s.trialDays) || 0) * DAY;
    const period = price.annual ? PERIOD_YEAR : PERIOD_30;
    let charges = 0;
    if (s.status === "ACTIVE") {
      if (now < trialEnd) {
        onTrial = true;
        if (trialEndsAt == null || trialEnd < trialEndsAt) trialEndsAt = trialEnd;
        continue; // trial not over: nothing charged yet
      }
      paidNow = true;
      monthly += price.annual ? price.amount / 12 : price.amount;
      // Shopify charges at the start of each billing period after the trial.
      charges = Math.floor((now - trialEnd) / period) + 1;
    } else if (["CANCELLED", "EXPIRED", "FROZEN"].includes(s.status)) {
      // Once accepted, a subscription that ended was billed up to its
      // currentPeriodEnd; one that ended inside its trial was never charged.
      const periodEnd = s.currentPeriodEnd ? new Date(s.currentPeriodEnd).getTime() : null;
      if (periodEnd == null) {
        unknownPast += 1;
        continue;
      }
      if (periodEnd <= trialEnd) continue;
      charges = Math.max(1, Math.round((periodEnd - trialEnd) / period));
    } else {
      continue; // PENDING / DECLINED / ACCEPTED: never charged
    }
    earned += charges * price.amount;
    currencies.add(price.currency);
  }
  return { paidNow, onTrial, trialEndsAt, monthly, earned, unknownPast, currencies: [...currencies] };
}

let cache = null; // { at, key, data }
let running = null;

async function readShop(shop) {
  try {
    const { admin } = await unauthenticated.admin(shop);
    const json = await (await admin.graphql(Q_SUBS)).json();
    const subs = json?.data?.currentAppInstallation?.allSubscriptions?.nodes;
    if (!Array.isArray(subs)) return { shop, error: true };
    return { shop, ...moneyFromSubscriptions(subs) };
  } catch {
    return { shop, error: true };
  }
}

async function compute(shops) {
  const results = [];
  for (let i = 0; i < shops.length; i += 6) {
    results.push(...(await Promise.all(shops.slice(i, i + 6).map(readShop))));
  }
  const ok = results.filter((r) => !r.error);
  const currencies = [...new Set(ok.flatMap((r) => r.currencies))];
  const round = (n) => Math.round(n * 100) / 100;
  const trials = ok.filter((r) => r.onTrial && !r.paidNow);
  const now = Date.now();
  return {
    at: new Date().toISOString(),
    checked: shops.length,
    failed: results.filter((r) => r.error).map((r) => r.shop),
    paid: ok.filter((r) => r.paidNow).length,
    paidShops: ok.filter((r) => r.paidNow).map((r) => r.shop),
    // Trial stores card: paid plans inside their Shopify free trial (not
    // charged yet), how many of those trials end in the next 7 days, and the
    // soonest end.
    onTrial: trials.length,
    trialShops: trials.map((r) => r.shop),
    trialEndingWeek: trials.filter((r) => r.trialEndsAt - now < 7 * DAY).length,
    trialNextEnd: trials.length ? new Date(Math.min(...trials.map((r) => r.trialEndsAt))).toISOString() : null,
    monthly: round(ok.reduce((n, r) => n + r.monthly, 0)),
    earned: round(ok.reduce((n, r) => n + r.earned, 0)),
    unknownPast: ok.reduce((n, r) => n + r.unknownPast, 0),
    currency: currencies.length <= 1 ? currencies[0] || "USD" : null,
  };
}

// shops: the stores the dashboard counts (active, not test / dev / shut).
// Returns the cached answer when it is fresh and for the same set of stores.
export function loadRevenue(shops, { force = false } = {}) {
  const key = [...shops].sort().join(",");
  if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return Promise.resolve(cache.data);
  }
  if (running && running.key === key) return running.promise;
  const promise = compute(shops)
    .then((data) => {
      cache = { at: Date.now(), key, data };
      return data;
    })
    .finally(() => {
      if (running?.promise === promise) running = null;
    });
  running = { key, promise };
  return promise;
}

// The last answer worked out, however old (null before the first one).
export function cachedRevenue() {
  return cache?.data || null;
}
