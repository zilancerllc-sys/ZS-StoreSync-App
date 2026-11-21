/* eslint-disable react/prop-types */
// The app's own left sidebar on every /app page (same layout as ZS B2B
// Gateway, ZS PreSell and ZS Bundles). Shopify's admin menu (<s-app-nav>)
// keeps its links too; this is the in-app menu, grouped, with the plan and the
// free-setup card. Under 760px it becomes a drawer opened by the "Menu" button
// (app.jsx).
//
// Sub-items open a part of their page:
//   ?role=from|to  Get started, already read by its loader
//   #hash          a card on the page (no loader runs). On New Migration the
//                  #copy-… links also tick that group of data types.
// The longest matching path wins, so nothing else needs a parent mapping.
import { Link, useLocation } from "react-router";
import { useT } from "../i18n";

const SITE = "https://zs-storesync.zilancer.com";
const UTM = "?utm_source=zs-storesync-app&utm_medium=app&utm_campaign=sidebar";
const SUPPORT_EMAIL = "contact@zilancer.com";

// Every data type New Migration can copy, in the groups the sidebar links to.
// app.migrate.jsx ticks a group's types when its #copy-<group> link is opened.
export const COPY_GROUPS = {
  catalog: ["products", "collections", "inventory", "metafields", "metaobjects", "files", "translations"],
  content: ["pages", "blogPosts", "menus", "redirects", "policies"],
  customers: ["customers", "orders", "giftCards", "discounts"],
  setup: ["locations", "shipping", "markets", "b2b", "sellingPlans"],
};

// Shown as the tooltip of each group link, so the types inside can be found.
const TYPE_NAMES = {
  products: "Products", collections: "Collections", inventory: "Stock levels", metafields: "Metafields",
  metaobjects: "Metaobjects", files: "Files", translations: "Translations", pages: "Pages",
  blogPosts: "Blog Posts", menus: "Menus", redirects: "Redirects", policies: "Store policies",
  customers: "Customers", orders: "Orders", giftCards: "Gift cards", discounts: "Discounts",
  locations: "Locations", shipping: "Shipping", markets: "Markets", b2b: "B2B companies",
  sellingPlans: "Selling plans",
};

// Labels stay as `label: "…"` so scripts/i18n-extract.mjs finds them.
const copy = (group, rest) => ({
  key: `copy-${group}`, to: "/app/migrate", hash: `copy-${group}`, sub: true, types: COPY_GROUPS[group], ...rest,
});
const section = (key, to, hash, rest) => ({ key, to, hash, sub: true, ...rest });

export const NAV_GROUPS = [
  {
    id: "overview",
    label: "Overview",
    items: [
      { key: "home", to: "/app", label: "Dashboard", icon: "home", exact: true },
      { key: "start", to: "/app/start", label: "Get started", icon: "rocket" },
      { key: "start-from", to: "/app/start", role: "from", label: "Copy FROM this store", icon: "upload", sub: true },
      { key: "start-to", to: "/app/start", role: "to", label: "Copy INTO this store", icon: "download", sub: true },
    ],
  },
  {
    id: "copy",
    label: "Copy & migrate",
    items: [
      { key: "migrate", to: "/app/migrate", label: "New Migration", icon: "swap" },
      section("mig-connect", "/app/migrate", "connect", { label: "Connect a source store", icon: "link" }),
      copy("catalog", { label: "Products & catalog", icon: "box" }),
      copy("content", { label: "Pages, blog & menus", icon: "page" }),
      copy("customers", { label: "Customers, orders & gift cards", icon: "users" }),
      copy("setup", { label: "Shipping, markets & B2B", icon: "truck" }),
      section("mig-run", "/app/migrate", "run", { label: "Run the migration", icon: "play" }),
      { key: "theme", to: "/app/theme-guide", label: "Copy your theme", icon: "brush" },
      { key: "preview", to: "/app/preview", label: "Preview & Compare", icon: "compare" },
      { key: "manual", to: "/app/manual-steps", label: "Manual steps", icon: "check" },
    ],
  },
  {
    id: "sync",
    label: "Keep in sync",
    items: [
      { key: "sync", to: "/app/sync", label: "Sync Changes", icon: "sync" },
      section("sync-instant", "/app/sync", "instant-sync", { label: "Instant sync", icon: "zap" }),
      section("sync-auto", "/app/sync", "automatic-sync", { label: "Automatic sync", icon: "clock" }),
      { key: "rules", to: "/app/rules", label: "Price & stock rules", icon: "percent" },
      section("rules-price", "/app/rules", "price-rules", { label: "Price rules", icon: "tag" }),
      section("rules-stock", "/app/rules", "live-stock", { label: "Live stock sync", icon: "stock" }),
      { key: "history", to: "/app/history", label: "History", icon: "history", also: ["/app/jobs"] },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      { key: "settings", to: "/app/settings", label: "Settings", icon: "gear" },
      section("set-code", "/app/settings", "connection-code", { label: "Connection code", icon: "key" }),
      section("set-pulling", "/app/settings", "connected-stores", { label: "Connected stores", icon: "store" }),
      section("set-email", "/app/settings", "emails", { label: "Emails", icon: "mail" }),
    ],
  },
  {
    id: "account",
    label: "Account",
    items: [
      { key: "plan", to: "/app/plan", label: "Plans", icon: "card" },
      // Owner-only and English-only, like its page (rawLabel: never translated).
      { key: "stores", to: "/app/stores", rawLabel: "Owner dashboard", icon: "chart", ownerOnly: true },
    ],
  },
  {
    id: "help",
    label: "Help",
    items: [
      { key: "docs", href: `${SITE}/documentation${UTM}`, label: "Documentation", icon: "book" },
      { key: "faq", href: `${SITE}/faq${UTM}`, label: "FAQ", icon: "help" },
      { key: "contact", href: `${SITE}/contact${UTM}`, label: "Contact us", icon: "chat" },
    ],
  },
];

function matchLen(pathname, item) {
  const p = pathname.replace(/\/+$/, "") || "/";
  const hit = (path, exact) => (exact ? p === path : p === path || p.startsWith(`${path}/`));
  let best = hit(item.to, item.exact) ? item.to.length : -1;
  for (const a of item.also || []) if (hit(a, false)) best = Math.max(best, a.length);
  return best;
}

// The item for the current page (internal links only), or null. A section
// link (#hash) or a role link (?role=) lights up only while it is the one
// asked for; otherwise the page's own item does.
export function activeItemFor(pathname, search = "", hash = "") {
  const h = String(hash || "").replace(/^#/, "");
  const role = new URLSearchParams(search || "").get("role");
  const p = pathname.replace(/\/+$/, "") || "/";
  let best = null;
  let bestLen = -1;
  for (const g of NAV_GROUPS) {
    for (const item of g.items) {
      if (!item.to) continue;
      if (item.hash || item.role) {
        if (p === item.to && ((item.hash && h === item.hash) || (item.role && role === item.role))) return item;
        continue;
      }
      const len = matchLen(pathname, item);
      if (len > bestLen) {
        best = item;
        bestLen = len;
      }
    }
  }
  return best;
}

export function hrefFor(item) {
  if (item.role) return `${item.to}?role=${item.role}`;
  return item.hash ? `${item.to}#${item.hash}` : item.to;
}

const ICONS = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  rocket: (
    <>
      <path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.1 2.1 0 0 0-2.9-.1z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2z" />
      <path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5" />
    </>
  ),
  upload: <path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />,
  download: <path d="M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />,
  swap: <path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />,
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>
  ),
  box: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </>
  ),
  page: (
    <>
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14a6.5 6.5 0 0 1 3 6" />
    </>
  ),
  truck: (
    <>
      <path d="M2 6h12v10H2zM14 10h4l3 3v3h-7" />
      <circle cx="6" cy="18" r="1.8" />
      <circle cx="17" cy="18" r="1.8" />
    </>
  ),
  play: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5v7l6-3.5z" />
    </>
  ),
  brush: (
    <>
      <path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8 9.2 12z" />
      <path d="M9 12.5c-2.5 0-4 1.6-4 3.8 0 1.5-.8 2.6-2 3.2 1 .7 2.6 1.1 4 1.1 3 0 5-2 5-4.6" />
    </>
  ),
  compare: (
    <>
      <rect x="3" y="4" width="7" height="16" rx="1.5" />
      <rect x="14" y="4" width="7" height="16" rx="1.5" />
      <path d="M6.5 9h0M17.5 9h0" />
    </>
  ),
  check: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  sync: (
    <>
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" />
    </>
  ),
  zap: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
    </>
  ),
  percent: (
    <>
      <path d="M19 5 5 19" />
      <circle cx="7" cy="7" r="2.5" />
      <circle cx="17" cy="17" r="2.5" />
    </>
  ),
  tag: (
    <>
      <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />
      <circle cx="8" cy="8" r="1.4" />
    </>
  ),
  stock: (
    <>
      <path d="M3 21V9l9-6 9 6v12" />
      <path d="M7 21v-8h10v8M7 17h10" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.7 12.3 9.3-9.3M16 7l3 3M14 9l2 2" />
    </>
  ),
  store: (
    <>
      <path d="M3 9l1.5-5h15L21 9" />
      <path d="M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" />
      <path d="M5 13v8h14v-8" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </>
  ),
  card: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20M6 15h4" />
    </>
  ),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" />
      <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
    </>
  ),
  out: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />,
};

export function NavIcon({ name, className = "zs-nav-ico" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}

// Same names as the plan page (credits.server.js PLAN_LABEL).
const PLAN_NAME = { free: "Free Plan", starter: "Starter Plan", growth: "Growth Plan", pro: "Pro Plan" };

// The plan the app.jsx loader already read: no extra billing call.
function PlanCard({ plan }) {
  const t = useT();
  const id = PLAN_NAME[plan] ? plan : "free";
  return (
    <div className="zs-nav-plan">
      <span className={"zs-nav-plan-pill" + (id === "free" ? "" : " is-paid")}>{t(PLAN_NAME[id])}</span>
      {id === "pro" ? (
        <small>{t("All features unlocked")}</small>
      ) : (
        <Link to="/app/plan" className="zs-nav-plan-up">
          {t("Upgrade plan")} <span aria-hidden="true">→</span>
        </Link>
      )}
    </div>
  );
}

// The chat script loads only when asked for (app.jsx SupportChat listens for
// this event), so "Chat with us" asks for it instead of opening an email.
function openChat(e) {
  e.preventDefault();
  window.dispatchEvent(new Event("zs:open-support"));
}

function SupportCard({ shop }) {
  const t = useT();
  const mail =
    `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Free setup for ZS StoreSync")}` +
    `&body=${encodeURIComponent(`Hi! Please set up ZS StoreSync and copy my store for free.\nStore: ${shop || ""}`)}`;
  return (
    <div className="zs-nav-help">
      <span className="zs-nav-help-tag">{t("Free setup")}</span>
      <b>{t("Need a hand?")}</b>
      <p>{t("Our team sets up ZS StoreSync and copies your store for free.")}</p>
      <div className="zs-nav-help-btns">
        <a href={mail} onClick={openChat} className="zs-nav-help-btn is-main">
          <NavIcon name="chat" className="zs-nav-ico-sm" />
          {t("Chat with us")}
        </a>
        <a href={mail} target="_blank" rel="noopener noreferrer" className="zs-nav-help-btn">
          <NavIcon name="mail" className="zs-nav-ico-sm" />
          {t("Email us")}
        </a>
      </div>
    </div>
  );
}

export default function AppSidebar({ isOwner, plan, shop, open, onClose }) {
  const t = useT();
  const { pathname, search, hash } = useLocation();
  const active = activeItemFor(pathname, search, hash);

  return (
    <aside className={"zs-nav" + (open ? " is-open" : "")} aria-label={t("App navigation")} id="zs-app-nav">
      <div className="zs-nav-head">
        <span className="zs-nav-logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />
          </svg>
        </span>
        <span className="zs-nav-brand">
          <span className="zs-nav-name">ZS StoreSync</span>
          <span className="zs-nav-tagline">{t("Store to store copy")}</span>
        </span>
        <button type="button" className="zs-nav-close" onClick={onClose} aria-label={t("Close menu")}>
          ×
        </button>
      </div>

      {NAV_GROUPS.map((g) => {
        const items = g.items.filter((i) => !i.ownerOnly || isOwner);
        if (!items.length) return null;
        return (
          <nav className="zs-nav-grp" key={g.id} aria-label={t(g.label)}>
            <p className="zs-nav-grp-t">{t(g.label)}</p>
            <ul className="zs-nav-links">
              {items.map((item) => {
                const label = item.rawLabel || t(item.label);
                if (item.href) {
                  return (
                    <li key={item.key}>
                      <a href={item.href} target="_blank" rel="noopener noreferrer" onClick={onClose}>
                        <NavIcon name={item.icon} />
                        <span className="zs-nav-label">{label}</span>
                        <NavIcon name="out" className="zs-nav-out" />
                        <span className="zs-sr">{t("(opens in a new tab)")}</span>
                      </a>
                    </li>
                  );
                }
                const on = active?.key === item.key;
                return (
                  <li key={item.key} className={item.sub ? "is-sub" : undefined}>
                    <Link
                      to={hrefFor(item)}
                      className={on ? "is-on" : undefined}
                      aria-current={on ? (item.hash ? "location" : "page") : undefined}
                      title={item.types ? item.types.map((ty) => t(TYPE_NAMES[ty])).join(", ") : undefined}
                      onClick={onClose}
                    >
                      <NavIcon name={item.icon} />
                      <span className="zs-nav-label">{label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        );
      })}

      <div className="zs-nav-foot">
        <PlanCard plan={plan} />
        <SupportCard shop={shop} />
      </div>
    </aside>
  );
}

// ZS StoreSync's own admin palette (routes/zs-styles.js): espresso #3A3128,
// clay #A98B76, camel #BFA28C, cream #F3E4C9, sage #BABF94.
export const SIDEBAR_STYLES = `
body{margin:0}
.zs-shell{
  --zsn-ink:#2B241D; --zsn-ink2:#4A4034; --zsn-clay:#A98B76; --zsn-camel:#BFA28C; --zsn-cream:#F3E4C9; --zsn-sage:#BABF94;
  --zsn-tx:#EFE6D8; --zsn-mut:rgba(239,230,216,.55); --zsn-line:rgba(191,162,140,.22);
  display:flex; align-items:flex-start; min-height:100vh; background:#FBF7EF;
  font-family:'Hanken Grotesk',Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;
}
.zs-nav{
  width:236px; flex-shrink:0; box-sizing:border-box;
  position:sticky; top:0; height:100vh; overflow-y:auto; overscroll-behavior:contain;
  display:flex; flex-direction:column;
  background:
    radial-gradient(circle at 0% 0%, rgba(169,139,118,.34), transparent 44%),
    radial-gradient(circle at 100% 100%, rgba(186,191,148,.18), transparent 48%),
    linear-gradient(180deg, var(--zsn-ink) 0%, #3A3128 55%, var(--zsn-ink2) 100%);
  color:var(--zsn-tx); padding:18px 12px 16px;
  scrollbar-width:thin; scrollbar-color:rgba(191,162,140,.35) transparent;
}
.zs-nav *{box-sizing:border-box}
.zs-nav-head{display:flex; align-items:center; gap:10px; margin:0 6px 20px}
.zs-nav-logo{width:34px; height:34px; border-radius:10px; flex-shrink:0; display:grid; place-items:center;
  background:linear-gradient(135deg, var(--zsn-clay), var(--zsn-sage)); box-shadow:0 6px 16px -6px rgba(169,139,118,.75), inset 0 1px 0 rgba(255,255,255,.3)}
.zs-nav-logo svg{width:20px; height:20px; fill:none; stroke:#fff; stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round}
.zs-nav-brand{flex:1; min-width:0; display:flex; flex-direction:column}
.zs-nav-name{font-family:'Fraunces',Georgia,serif; font-size:16px; font-weight:600; color:#fff; letter-spacing:-.01em; line-height:1.2}
.zs-nav-tagline{font-size:10.5px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color:var(--zsn-camel); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.zs-nav-close{all:unset; display:none; cursor:pointer; font-size:24px; line-height:1; padding:2px 8px; border-radius:8px; color:var(--zsn-tx)}
.zs-nav-close:hover{background:rgba(239,230,216,.1)}
.zs-nav-grp{margin-bottom:14px}
.zs-nav-grp-t{margin:0 10px 6px; font-size:10.5px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--zsn-mut)}
.zs-nav-links{list-style:none; margin:0; padding:0}
.zs-nav-links a{position:relative; display:flex; align-items:center; gap:11px; padding:9px 10px; margin:2px 0; border-radius:10px;
  color:var(--zsn-tx); text-decoration:none; font-size:14px; font-weight:500; transition:background .15s, color .15s}
.zs-nav-links a:hover{background:rgba(239,230,216,.08); color:#fff}
.zs-nav-links a.is-on{background:linear-gradient(90deg, rgba(169,139,118,.55), rgba(169,139,118,.18)); color:#fff; font-weight:650;
  box-shadow:inset 0 0 0 1px rgba(191,162,140,.35)}
.zs-nav-links a.is-on::before{content:""; position:absolute; inset-block:8px; inset-inline-start:-12px; width:4px; border-radius:0 4px 4px 0; background:var(--zsn-sage); box-shadow:0 0 12px rgba(186,191,148,.95)}
.zs-nav-links a.is-on .zs-nav-ico{color:var(--zsn-cream)}
.zs-nav-ico{width:18px; height:18px; flex-shrink:0; stroke:currentColor; fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; opacity:.92}
.zs-nav-ico-sm{width:15px; height:15px; flex-shrink:0; stroke:currentColor; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round}
.zs-nav-out{width:13px; height:13px; flex-shrink:0; stroke:currentColor; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; opacity:.45}
.zs-nav-links li.is-sub a{padding-top:6px; padding-bottom:6px; padding-inline-start:24px; font-size:13px; color:rgba(239,230,216,.8)}
.zs-nav-links li.is-sub a:hover, .zs-nav-links li.is-sub a.is-on{color:#fff}
.zs-nav-links li.is-sub a svg{width:15px; height:15px}
/* Long labels (Customers, orders & gift cards, longer languages) wrap instead of being cut. */
.zs-nav-label{flex:1; min-width:0; line-height:1.25; overflow-wrap:anywhere}
.zs-sr{position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap}
.zs-nav a:focus-visible, .zs-nav button:focus-visible{outline:2px solid var(--zsn-sage); outline-offset:2px}
.zs-nav-foot{margin-top:auto; padding-top:8px; display:flex; flex-direction:column; gap:10px}
.zs-nav-plan{display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; padding:10px 12px; border-radius:12px;
  background:rgba(239,230,216,.06); border:1px solid var(--zsn-line)}
.zs-nav-plan small{font-size:11.5px; color:var(--zsn-mut)}
.zs-nav-plan-pill{font-size:12px; font-weight:700; color:#fff; padding:3px 10px; border-radius:999px; background:rgba(239,230,216,.14)}
.zs-nav-plan-pill.is-paid{background:var(--zsn-sage); color:var(--zsn-ink)}
.zs-nav-plan-up{font-size:12px; font-weight:700; color:var(--zsn-camel); text-decoration:none; white-space:nowrap}
.zs-nav-plan-up:hover{text-decoration:underline}
.zs-nav-help{position:relative; overflow:hidden; padding:14px; border-radius:14px; color:var(--zsn-ink);
  background:linear-gradient(140deg, var(--zsn-cream) 0%, var(--zsn-camel) 60%, var(--zsn-clay) 100%); box-shadow:0 14px 30px -18px rgba(169,139,118,.95)}
.zs-nav-help::after{content:""; position:absolute; width:110px; height:110px; border-radius:50%; right:-40px; top:-46px; background:radial-gradient(circle, rgba(255,255,255,.45), transparent 70%); pointer-events:none}
.zs-nav-help-tag{display:inline-block; font-size:10px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; background:var(--zsn-ink); color:var(--zsn-sage); padding:3px 8px; border-radius:999px}
.zs-nav-help b{display:block; margin-top:8px; font-size:14px}
.zs-nav-help p{margin:3px 0 10px; font-size:12.5px; line-height:1.45; color:rgba(43,36,29,.82)}
.zs-nav-help-btns{display:flex; gap:6px; flex-wrap:wrap}
.zs-nav-help-btn{display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:700; text-decoration:none; color:var(--zsn-ink);
  padding:7px 10px; border-radius:9px; border:1px solid rgba(43,36,29,.28); background:rgba(255,255,255,.3)}
.zs-nav-help-btn.is-main{background:var(--zsn-ink); color:#fff; border-color:var(--zsn-ink)}
.zs-nav-help-btn:hover{filter:brightness(1.08)}
.zs-nav-help-btn:focus-visible{outline:2px solid var(--zsn-ink); outline-offset:2px}
.zs-shell-main{flex:1; min-width:0}
/* Pages break out to the full window width (width:100vw; margin-left:-50vw);
   beside the sidebar they fill the content column instead. */
.zs-shell-main .zs-section-wrap{width:auto !important; left:auto !important; right:auto !important; margin-left:0 !important; margin-right:0 !important}
.zs-shell-main [id]{scroll-margin-top:12px}
/* Full width (owner 2026-11-21): every page uses the whole content column
   right of the sidebar; pages keep their own ~24px inner padding. */
.zs-shell-main .zs-wrap{max-width:none !important}
.zs-menu-bar{display:none}
.zs-nav-backdrop{display:none}
@media (max-width:759px){
  .zs-shell{display:block}
  .zs-nav{position:fixed; inset-block:0; inset-inline-start:0; z-index:1100; height:100%; width:min(280px, 86vw);
    transform:translateX(-100%); transition:transform .22s ease, visibility .22s; box-shadow:8px 0 30px rgba(43,36,29,.4); visibility:hidden}
  .zs-nav.is-open{transform:none; visibility:visible}
  .zs-nav-close{display:block}
  .zs-nav-backdrop.is-open{display:block; position:fixed; inset:0; z-index:1090; background:rgba(43,36,29,.45); border:0; padding:0; backdrop-filter:blur(2px)}
  .zs-menu-bar{display:flex; align-items:center; gap:12px; position:sticky; top:0; z-index:900;
    background:linear-gradient(90deg, #2B241D, #5A4A3C); color:#fff; padding:8px 12px; font-size:14px; font-weight:600}
  .zs-menu-btn{display:inline-flex; align-items:center; gap:7px; border:1px solid rgba(191,162,140,.55); background:rgba(169,139,118,.3);
    color:#fff; border-radius:9px; padding:6px 11px; cursor:pointer; font:inherit; font-size:13px; font-weight:600}
  .zs-menu-btn svg{width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:2; stroke-linecap:round}
  .zs-menu-btn:focus-visible{outline:2px solid #BABF94; outline-offset:2px}
  .zs-menu-title{overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#EFE6D8}
  .zs-shell-main [id]{scroll-margin-top:56px}
}
@media (prefers-reduced-motion: reduce){ .zs-nav, .zs-nav-links a{transition:none} }
`;
