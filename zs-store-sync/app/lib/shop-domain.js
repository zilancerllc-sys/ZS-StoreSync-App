// Turn whatever a merchant pastes for "the other store" into its
// xxx.myshopify.com domain, or "" when we can't tell.
//
// Merchants rarely know the .myshopify.com address. What they have open is the
// admin URL (admin.shopify.com/store/<handle>/...) or they type just the handle,
// and both used to be rejected with "Enter the full domain". Custom domains
// (mystore.com) can't be mapped without asking Shopify, so they stay "" and the
// page explains where to find the right address.
export function toShopDomain(input) {
  let s = String(input || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "");
  const admin = s.match(/^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/);
  if (admin) return `${admin[1]}.myshopify.com`;
  s = s.replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) return s;
  // a bare handle such as "my-store"
  if (/^[a-z0-9][a-z0-9-]*$/.test(s)) return `${s}.myshopify.com`;
  return "";
}
