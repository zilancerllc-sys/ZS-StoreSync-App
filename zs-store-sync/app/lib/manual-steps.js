// What Shopify doesn't let any app copy between stores, with the admin page on
// the target store where the merchant sets it up. Client-safe (the Manual
// steps page renders it). Texts are English keys for t().

export function storeHandle(shopDomain) {
  return String(shopDomain || "").replace(/\.myshopify\.com$/i, "");
}

export function adminUrl(shopDomain, path) {
  return `https://admin.shopify.com/store/${encodeURIComponent(storeHandle(shopDomain))}/${path}`;
}

// id: stable key for the "done" ticks; path: admin page on the target store.
export const MANUAL_STEPS = [
  {
    id: "details",
    title: "Store details, currency and time zone",
    why: "Store name, contact email, address, store currency, time zone, unit system and order ID format are store settings with no app access. Set the currency before you copy prices or gift cards.",
    path: "settings/general",
  },
  {
    id: "payments",
    title: "Payments",
    why: "Payment providers, Shopify Payments, PayPal and manual payment methods need the store owner's own accounts and identity checks.",
    path: "settings/payments",
  },
  {
    id: "checkout",
    title: "Checkout settings",
    why: "Customer contact method, required fields, tipping, order status page scripts and checkout branding can only be set in the admin (or with the checkout editor).",
    path: "settings/checkout",
  },
  {
    id: "notifications",
    title: "Notification email templates",
    why: "Apps can't read or write order confirmation, shipping and other notification templates. Copy any custom template code by hand. (Their translations are copied when the text is the same on both stores.)",
    path: "settings/notifications",
  },
  {
    id: "taxes",
    title: "Taxes and duties",
    why: "Tax registrations, regional tax settings, tax overrides and duties are not available to apps.",
    path: "settings/taxes",
  },
  {
    id: "shipping-extra",
    title: "Local delivery, packages and shipping labels",
    why: "Shipping profiles, zones and rates are copied by Shipping. Local delivery areas, saved packages, carrier accounts and label settings are not open to apps.",
    path: "settings/shipping",
  },
  {
    id: "domains",
    title: "Domains",
    why: "A domain can only be connected to one store, by its owner. Market subfolders are copied; market domains are not.",
    path: "settings/domains",
  },
  {
    id: "apps",
    title: "Installed apps",
    why: "Each app is installed by the merchant and keeps its own data. Install the same apps here, then use each app's own export / import for its data (reviews, subscriptions contracts, loyalty points, bundles...).",
    path: "settings/apps",
  },
  {
    id: "staff",
    title: "Staff accounts and permissions",
    why: "Staff are invited by the store owner and must accept by email.",
    path: "settings/users",
  },
  {
    id: "languages",
    title: "Publish languages",
    why: "Translations add missing languages to this store unpublished. Publish each language when it is ready.",
    path: "settings/languages",
  },
  {
    id: "customer-accounts",
    title: "Customer accounts and privacy",
    why: "Customer account version, sign-in options, cookie banner and data sale opt-out settings are admin-only.",
    path: "settings/customer_accounts",
  },
  {
    id: "brand",
    title: "Brand assets and sales channels",
    why: "Logo, colours and social links under Brand, and channels like Facebook, Google or POS, are connected by the merchant.",
    path: "settings/branding",
  },
  {
    id: "theme",
    title: "Theme",
    why: "Theme copy waits for Shopify's theme permission. Until then, follow the Copy your theme guide.",
    path: "themes",
    appPath: "/app/theme-guide",
  },
  {
    id: "history",
    title: "Payments, fulfilments and refunds on old orders",
    why: "Orders are recreated with their items, addresses and totals; the payment, fulfilment and refund records stay on the original store.",
    path: "orders",
  },
];
