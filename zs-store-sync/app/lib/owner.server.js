// app/lib/owner.server.js
// Gate for app-owner-only routes.
//
// Most routes are per-merchant: authenticate.admin() gives us a session and
// every query is scoped to session.shop. A few routes (the store roster / its
// CSV) read ACROSS every shop, so an ordinary merchant session is not enough
// authorisation — without this gate any merchant with the app installed could
// read every other merchant's domain and email.
//
// Allowed shops come from OWNER_SHOPS (comma-separated myshopify domains).

const FALLBACK_OWNER_SHOPS = ["zs-storesync.myshopify.com"];

function ownerShops() {
  // eslint-disable-next-line no-undef
  const raw = process.env.OWNER_SHOPS;
  if (!raw) return FALLBACK_OWNER_SHOPS;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isOwnerShop(shopDomain) {
  if (!shopDomain) return false;
  return ownerShops().includes(String(shopDomain).toLowerCase());
}

// Throws a 404 (not 403) for non-owners so the route's existence isn't
// advertised to merchants who probe for it.
export function requireOwnerShop(shopDomain) {
  if (!isOwnerShop(shopDomain)) {
    throw new Response("Not Found", { status: 404 });
  }
}
