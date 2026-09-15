/**
 * Zilancer Affiliate Network integration.
 *
 * Lets a merchant enter an affiliate's referral code and keeps the affiliate
 * platform in sync with this shop's real Shopify subscriptions, so referring
 * affiliates earn commission on paid plans.
 *
 * Safety rules — this must never break the app:
 * - Switched off entirely unless AFFILIATE_API_URL and AFFILIATE_API_KEY are set.
 * - Every network call times out after 5s; nothing here throws to its caller
 *   except applyReferralCode, whose errors are shown to the merchant.
 * - The code lives in an app-owned metafield on the app installation, so no
 *   database migration is needed.
 *
 * Docs: affiliate platform repo, docs/shopify-integration.md
 */

const APP_SLUG = "zs-storesync";
const METAFIELD_NAMESPACE = "$app:affiliate";
const METAFIELD_KEY = "referral_code";
const SYNC_INTERVAL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

const lastSyncByShop = new Map();

export function isAffiliateEnabled() {
  return Boolean(process.env.AFFILIATE_API_URL && process.env.AFFILIATE_API_KEY);
}

export function normalizeReferralCode(raw) {
  return String(raw ?? "").trim().toUpperCase();
}

export function isValidReferralCode(code) {
  return /^[A-Z0-9]{3,32}$/.test(code);
}

async function callPlatform(path, body) {
  const base = process.env.AFFILIATE_API_URL.replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AFFILIATE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

const STATE_QUERY = `#graphql
  query AffiliateState {
    currentAppInstallation {
      id
      metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
        value
      }
      activeSubscriptions {
        id
        name
        status
        test
        trialDays
        createdAt
        lineItems {
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing {
                interval
                price {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
      oneTimePurchases(first: 50, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          status
          test
          createdAt
          price {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

/**
 * Reads the saved referral code and the shop's subscriptions straight from
 * Shopify's Admin API — amounts are never taken from the browser.
 */
export async function getAffiliateState(admin) {
  const response = await admin.graphql(STATE_QUERY);
  const { data } = await response.json();
  const installation = data?.currentAppInstallation;

  const subscriptions = (installation?.activeSubscriptions ?? [])
    .map((sub) => {
      const recurring = (sub.lineItems ?? [])
        .map((li) => li?.plan?.pricingDetails)
        .filter((p) => p?.__typename === "AppRecurringPricing");
      if (recurring.length === 0) return null;

      const amount = recurring.reduce((sum, p) => sum + Number(p.price?.amount ?? 0), 0);
      return {
        id: sub.id,
        name: sub.name,
        status: sub.status,
        amount: Math.round(amount * 100) / 100,
        currency: recurring[0].price?.currencyCode ?? "USD",
        interval: recurring[0].interval,
        trial_days: sub.trialDays ?? 0,
        created_at: sub.createdAt,
        test: Boolean(sub.test),
      };
    })
    .filter(Boolean);

  // One-time purchases (charged once, e.g. buying a single section). Only
  // ACTIVE ones have actually been paid.
  const purchases = (installation?.oneTimePurchases?.nodes ?? [])
    .filter((p) => p.status === "ACTIVE")
    .map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      amount: Math.round(Number(p.price?.amount ?? 0) * 100) / 100,
      currency: p.price?.currencyCode ?? "USD",
      interval: "ONE_TIME",
      trial_days: 0,
      created_at: p.createdAt,
      test: Boolean(p.test),
    }));

  return {
    installationId: installation?.id ?? null,
    referralCode: installation?.metafield?.value ?? null,
    subscriptions: [...subscriptions, ...purchases],
  };
}

async function saveReferralCode(admin, installationId, code) {
  const response = await admin.graphql(
    `#graphql
      mutation SaveReferralCode($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            ownerId: installationId,
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
            type: "single_line_text_field",
            value: code,
          },
        ],
      },
    },
  );
  const { data } = await response.json();
  const errors = data?.metafieldsSet?.userErrors ?? [];
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
}

/**
 * Apply a code the merchant typed. Returns { ok, code } or { ok: false, error }
 * with a message that's safe to show the merchant.
 */
export async function applyReferralCode({ admin, shop, code: rawCode }) {
  if (!isAffiliateEnabled()) return { ok: false, error: "Referral codes aren't available right now." };

  const code = normalizeReferralCode(rawCode);
  if (!isValidReferralCode(code)) {
    return { ok: false, error: "Referral codes are letters and numbers only, like AFF123." };
  }

  try {
    const state = await getAffiliateState(admin);
    if (state.referralCode) {
      return { ok: true, code: state.referralCode, alreadyApplied: true };
    }

    const result = await callPlatform("/api/shopify/attribution", { shop, app: APP_SLUG, referral_code: code });
    if (result.status === 404) {
      return { ok: false, error: "We couldn't find that referral code. Check it with the person who shared it." };
    }
    if (!result.ok) {
      return { ok: false, error: "We couldn't apply the code right now. Try again in a few minutes." };
    }

    await saveReferralCode(admin, state.installationId, code);
    // The merchant may already be on a paid plan — credit it right away.
    await syncAffiliate({ admin, shop, force: true, state: { ...state, referralCode: code } });
    return { ok: true, code };
  } catch (error) {
    console.error("[affiliate] applying referral code failed:", error?.message);
    return { ok: false, error: "We couldn't apply the code right now. Try again in a few minutes." };
  }
}

/**
 * Report this shop's current subscriptions to the affiliate platform.
 * Only runs for shops that entered a referral code. Never throws.
 * Pass `request` so a return from Shopify's charge approval page (which adds
 * `charge_id` to the URL) reports the new plan immediately.
 */
export async function syncAffiliate({ admin, shop, force = false, state = null, request = null }) {
  if (!isAffiliateEnabled() || !admin || !shop) return;

  if (!force && request?.url) {
    try {
      force = new URL(request.url).searchParams.has("charge_id");
    } catch {
      // Unparseable URL — fall back to the normal throttle.
    }
  }

  const last = lastSyncByShop.get(shop) ?? 0;
  if (!force && Date.now() - last < SYNC_INTERVAL_MS) return;
  lastSyncByShop.set(shop, Date.now());

  try {
    const current = state ?? (await getAffiliateState(admin));
    if (!current.referralCode) return;

    const result = await callPlatform("/api/shopify/subscription-sync", {
      shop,
      app: APP_SLUG,
      subscriptions: current.subscriptions,
    });
    if (!result.ok) {
      console.error("[affiliate] subscription sync rejected:", result.status, JSON.stringify(result.json).slice(0, 300));
    }
  } catch (error) {
    console.error("[affiliate] subscription sync failed:", error?.message);
  }
}

/**
 * Shopify cancels the app's subscription on uninstall, so report an empty
 * list. The platform ignores shops that were never referred. Never throws.
 */
export async function syncAffiliateAfterUninstall(shop) {
  if (!isAffiliateEnabled() || !shop) return;
  lastSyncByShop.delete(shop);
  try {
    await callPlatform("/api/shopify/subscription-sync", { shop, app: APP_SLUG, subscriptions: [] });
  } catch (error) {
    console.error("[affiliate] uninstall sync failed:", error?.message);
  }
}
