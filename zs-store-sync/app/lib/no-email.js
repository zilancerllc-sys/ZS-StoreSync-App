// app/lib/no-email.js
// Stores the owner has said must never get an email from the Zilancer apps, of
// any kind: lifecycle, setup offers, review requests, promos, alerts (same list
// as ZS Bundles' app/lib/no-email.js). Checked in sendEmail by store and by
// address, so no path can miss it, and in the owner dashboard by store, so its
// buttons show these stores as not emailable. Elitesouq and Bright Neon since
// 2026-10-28; the owner's own stores and personal clients since 2026-11-21.
export const NO_EMAIL_SHOPS = new Set([
  "qrdi3m-5z.myshopify.com", // Elitesouq
  "brightneon24.myshopify.com", // Bright Neon
  "miro-makauri.myshopify.com", // Miro&Makauri
  "jf7cn8-00.myshopify.com", // NariLuxe
  "i1pjmn-1n.myshopify.com", // Zilancer
  "verduurzamingscentrumnederland.myshopify.com", // Verduurzamingscentrumnederland
  "makspatch-fiybr0gi.myshopify.com", // Mak's Patch
  "pkr0z0-gr.myshopify.com", // ZS Sections
  "vuursfeerhaard-nl.myshopify.com", // vuursfeerhaard
  "forgottenparks-kv1izp5p.myshopify.com", // Forgotten Parks Foundation
  "sx2cjw-e3.myshopify.com", // FRONTIER¹
  "cinewall-nl.myshopify.com", // cinewall-nl
]);

export const NO_EMAIL_ADDRESSES = new Set([
  "015faiza@gmail.com", // Elitesouq
  "hello@brightneon.co.uk", // Bright Neon
  "info@makauri.co.uk", // Miro&Makauri, Mak's Patch
  "contact@nariluxe.com", // NariLuxe
  "zilancerllc@gmail.com", // Zilancer
  "finance@verduurzamingcentrumnederland.nl", // Verduurzamingscentrumnederland
  "store@zssections.com", // ZS Sections
  "info@vuursfeerhaard.nl", // vuursfeerhaard
  "mseignette@hotmail.com", // Forgotten Parks Foundation, FRONTIER¹
  "new_york_gumus@hotmail.com", // cinewall-nl
]);

export const isNoEmail = ({ shop, email } = {}) =>
  (!!shop && NO_EMAIL_SHOPS.has(String(shop).trim().toLowerCase())) ||
  (!!email && NO_EMAIL_ADDRESSES.has(String(email).trim().toLowerCase()));
