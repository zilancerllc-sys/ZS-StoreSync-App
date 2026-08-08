// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — the other Zilancer apps
//
//  One list, used by the dashboard's "Recommended apps" row and by the welcome
//  and promotional emails. Kept as plain data (no .server suffix) so both the
//  browser bundle and the mail templates can read it — a second copy for email
//  would drift the moment an app is renamed or its listing moves.
// ═════════════════════════════════════════════════════════════════════════════

export const RECOMMENDED_APPS = [
  {
    name: "ZS Smart Content AI",
    category: "Marketing",
    description: "Generate high-quality product descriptions, SEO copy, and ad texts with AI straight from your Shopify admin.",
    link: "https://apps.shopify.com/zs-smart-content-ai",
    icon: "https://cdn.shopify.com/s/files/1/1013/3821/8865/files/ZS_Smart_Content_Logo.png?v=1780889058",
    colorClass: "rose",
    badge: "Free plan available",
  },
  {
    name: "ZS Sections: Theme Sections",
    category: "Store Design",
    description: "Drag and drop professionally designed, high-converting theme sections onto your store without any coding.",
    link: "https://apps.shopify.com/zs-sections",
    icon: "https://cdn.shopify.com/s/files/1/0639/6657/6725/files/ZS_sections_app_icon_5.png?v=1778330085",
    colorClass: "gold",
    badge: "Free plan available",
  },
  {
    name: "ZS Bundles App & Upsells",
    category: "Upsell & AOV",
    description: "Increase average order value with product bundles, volume discounts, and smart cart upsell recommendations.",
    link: "https://apps.shopify.com/zs-bundles",
    icon: "https://cdn.shopify.com/s/files/1/0813/8879/8190/files/favicon_84dd8a2f-dd90-4da4-8e40-4c9302f68cc5.png?v=1781849995",
    colorClass: "sage",
    badge: "Free plan available",
  },
  {
    name: "ZS B2B Gateway",
    category: "B2B & Wholesale",
    description: "Build professional wholesale signup forms and restrict access to specific pages or products based on tags.",
    link: "https://apps.shopify.com/zs-b2b-gateway",
    icon: "https://cdn.shopify.com/s/files/1/0827/7481/9064/files/b2b_1.png?v=1779244866",
    colorClass: "dark",
    badge: "Free trial available",
  },
  {
    name: "ZS Wishlist",
    category: "Conversion",
    description: "Enable guest and customer wishlists, sending automated reminders for price drops and back-in-stock items.",
    link: "https://apps.shopify.com/zs-wishlist",
    icon: "https://cdn.shopify.com/s/files/1/0768/2369/1419/files/imgi_1_favicon.png?v=1781845297",
    colorClass: "rose",
    badge: "Free plan available",
  },
  {
    name: "ZS Spin View",
    category: "Product 3D & 360",
    description: "Convert more visitors with interactive 360-degree product spins generated automatically using AI.",
    link: "https://apps.shopify.com/zs-spin-view",
    icon: "https://cdn.shopify.com/app-store/listing_images/9a4e12c15d721c7f7a030cf4b67e5756/icon/CK7TjLuH1pQDEAE=.png",
    colorClass: "plum",
    badge: "Free plan available",
  },
];
