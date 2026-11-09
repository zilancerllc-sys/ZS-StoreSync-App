// Stores the owner has said must never get an email from the Zilancer apps
// (same list as ZS Bundles' app/lib/no-email.js). Checked before the
// uninstall question goes out.
export const NO_EMAIL_SHOPS = new Set([
  "qrdi3m-5z.myshopify.com", // Elitesouq
  "brightneon24.myshopify.com", // Bright Neon
]);

export const NO_EMAIL_ADDRESSES = new Set([
  "015faiza@gmail.com", // Elitesouq
  "hello@brightneon.co.uk", // Bright Neon
]);

export const isNoEmail = ({ shop, email } = {}) =>
  (!!shop && NO_EMAIL_SHOPS.has(shop)) ||
  (!!email && NO_EMAIL_ADDRESSES.has(String(email).trim().toLowerCase()));
