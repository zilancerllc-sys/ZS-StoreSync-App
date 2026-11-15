// app/lib/email-track.js
// Email tracking helpers, the same file in every Zilancer app.
//
// Every email an app sends through Resend carries three tags:
//   app   which Zilancer app sent it (zs-bundles, zs-wishlist, ...)
//   type  what kind of email it is (welcome, feedback, uninstall_ask, ...)
//   shop  the store it is about, as the myshopify handle
// Resend hands the tags back on every webhook event (sent, delivered, opened,
// clicked, bounced, complained), and ZS Bundles records those events for all
// apps (app/lib/email-log.server.js there). The owner dashboard of each app
// reads its own numbers back (components/EmailStats.jsx).
//
// Resend tag names and values may only hold ASCII letters, digits, "_" and
// "-", so a shop is sent as its handle without ".myshopify.com".

export const EMAIL_TYPE_LABELS = {
  welcome: "Welcome",
  setup_offer: "Setup offer",
  status_notice: "Setup status notice",
  feedback: "Feedback ask",
  review_ask: "Review ask",
  uninstall_ask: "Uninstall ask",
  trial_ending: "Trial ending",
  unused_plan: "Unused plan",
  bfcm: "Black Friday",
  promo: "Promo",
  result: "First result / milestone",
  merchant_alert: "Merchant alert",
  customer: "Shopper email (sent for the store)",
  team: "To the Zilancer team",
  account: "Account",
  support: "Support reply",
  test: "Test",
  other: "Other",
};

const clean = (v) => String(v || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);

export function shopTagValue(shop) {
  // Some apps hand over their shop record rather than the domain.
  const raw = shop && typeof shop === "object"
    ? shop.shopDomain || shop.shop || shop.myshopifyDomain || shop.domain || ""
    : shop;
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  return clean(s.replace(/\.myshopify\.com$/, ""));
}

export function shopFromTag(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return null;
  return /^[a-z0-9-]+$/.test(s) ? `${s}.myshopify.com` : s;
}

// Tags for one send, in the array form the Resend API takes.
export function emailTags({ app, type, shop, subject } = {}) {
  const tags = [
    { name: "app", value: clean(app) || "unknown" },
    { name: "type", value: clean(type || classifyEmail(subject)) || "other" },
  ];
  const s = shopTagValue(shop);
  if (s) tags.push({ name: "shop", value: s });
  return tags;
}

// Tags as a plain object, from either form Resend uses ({name: value} on
// webhooks, [{name, value}] on the send API).
export function tagMap(tags) {
  if (!tags) return {};
  if (Array.isArray(tags)) return Object.fromEntries(tags.filter((t) => t && t.name).map((t) => [t.name, t.value]));
  if (typeof tags === "object") return { ...tags };
  return {};
}

// Display names the apps send from, mapped to the app tag. Used for email
// sent before the tags existed, and for senders that don't tag (the
// affiliate site).
const SENDER_APPS = [
  [/^(masud from )?zs bundles$/i, "zs-bundles"],
  [/^(masud from )?zs b2b gateway$/i, "zs-b2b-gateway"],
  [/^(masud from )?zs presell$/i, "zs-presell"],
  [/^(masud from )?zs sections?$/i, "zs-sections"],
  [/^(masud from )?zs spin view(er)?$/i, "zs-spin-view"],
  [/^(masud from )?zs storesync$/i, "zs-storesync"],
  [/^(masud from )?zs subscriptions$/i, "zs-subscriptions"],
  [/^(masud from )?zs wishlist$/i, "zs-wishlist"],
  [/^(masud from )?zs (smart content|ai product description seo)$/i, "zs-smart-content"],
  [/^(masud from )?zs uniform portal$/i, "zs-uniform-portal"],
  [/^zilancer affiliates?/i, "zilancer-affiliates"],
];

export function appFromSender(from, subject = "") {
  const name = String(from || "").replace(/<[^>]*>/, "").replace(/"/g, "").trim();
  for (const [re, app] of SENDER_APPS) if (re.test(name)) return app;
  // Shopper-facing mail goes out under the store's own name, so guess by
  // what it says.
  const s = String(subject || "");
  if (/back in stock|price drop|pre-?order|presell/i.test(s)) return "zs-presell";
  if (/subscription|^welcome aboard, /i.test(s)) return "zs-subscriptions";
  if (/trade account|wholesale|reseller/i.test(s)) return "zs-b2b-gateway";
  if (/wishlist/i.test(s)) return "zs-wishlist";
  return "unknown";
}

// Best guess at the type from the subject line, for untagged mail.
export function classifyEmail(subject = "") {
  const s = String(subject || "");
  if (/^\s*\[test\]|^\s*test [a-z]\b|^control c\b/i.test(s)) return "test";
  if (/^\s*re:/i.test(s)) return "support";
  if (/feedback .*\d\/5|feedback —|custom section request/i.test(s)) return "team";
  if (/back in stock|price drop|subscription (is )?confirmed|subscription payment|manage your subscriptions|next subscription order|trade account|welcome aboard, /i.test(s)) return "customer";
  if (/why did you remove/i.test(s)) return "uninstall_ask";
  if (/welcome/i.test(s)) return "welcome";
  if (/how'?s .* working out/i.test(s)) return "feedback";
  if (/quick favou?r|leave a review|review/i.test(s)) return "review_ask";
  if (/trial ends/i.test(s)) return "trial_ending";
  if (/black friday|bfcm|cyber monday/i.test(s)) return "bfcm";
  if (/more ways to grow/i.test(s)) return "promo";
  if (/isn'?t showing|still a draft|switched off|one switch|works again|now shows|about your|your spin on/i.test(s)) return "status_notice";
  if (/set (it |them )?up|build your first|switch .* on|need a hand|we'?ll make|help you run|launch your|set up more/i.test(s)) return "setup_offer";
  if (/result is in|spin is live|spin is ready|generation complete|first .* (order|subscriber)/i.test(s)) return "result";
  if (/password|approved|received your/i.test(s)) return "account";
  if (/application|new orders?|quote request|reseller order/i.test(s)) return "merchant_alert";
  if (/plan/i.test(s)) return "unused_plan";
  return "other";
}
