import { useState } from "react";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { MessageCircle } from "lucide-react";
import { authenticate } from "../shopify.server";
import { syncAffiliate } from "../lib/affiliate.server";
import { isOwnerShop } from "../lib/owner.server";
import { I18nProvider, useT } from "../i18n";
import { messagesFor, resolveLocale } from "../i18n/messages.server";

const TAWK_SRC = "https://embed.tawk.to/6a538d517c60fa1d457184bb/1jtb60286";

// Support chat, loaded only when the merchant asks for it.
//
// This used to mount on every screen: a third-party script on every page of an
// embedded admin app, receiving the shop's domain as the visitor name whether
// or not support was ever wanted. Now nothing leaves the page until the button
// is clicked — at which point the merchant has actively chosen to start a
// conversation, which is also when identifying their store is actually useful.
function SupportChat({ shop }) {
  const t = useT();
  const [state, setState] = useState("idle"); // idle | loading | ready

  const openChat = () => {
    if (state === "ready") {
      window.Tawk_API?.maximize?.();
      return;
    }
    if (state === "loading") return;
    setState("loading");

    window.Tawk_API = window.Tawk_API || {};
    if (shop) window.Tawk_API.visitor = { name: shop };
    // Tawk renders its own launcher once the script is up, so if onLoad never
    // fires we still have to stand down — otherwise this button sits on
    // "Opening…" next to a working chat bubble.
    const settle = setTimeout(() => setState("ready"), 8000);
    window.Tawk_API.onLoad = () => {
      clearTimeout(settle);
      setState("ready");
      window.Tawk_API?.maximize?.();
    };
    window.Tawk_LoadStart = new Date();

    const script = document.createElement("script");
    script.async = true;
    script.src = TAWK_SRC;
    script.charset = "UTF-8";
    script.setAttribute("crossorigin", "*");
    // Let the merchant try again instead of leaving the button spinning.
    script.onerror = () => {
      clearTimeout(settle);
      setState("idle");
    };
    document.head.appendChild(script);
  };

  // Once loaded, Tawk renders its own launcher — showing ours too would put
  // two chat bubbles in the same corner.
  if (state === "ready") return null;

  return (
    <button
      type="button"
      onClick={openChat}
      aria-label={t("Contact support")}
      disabled={state === "loading"}
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        zIndex: 999,
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "11px 16px",
        borderRadius: 999,
        border: "none",
        background: "#a98b76",
        color: "#fff",
        fontSize: 13.5,
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: state === "loading" ? "wait" : "pointer",
        boxShadow: "0 6px 20px rgba(58,49,40,.22)",
      }}
    >
      <MessageCircle size={16} />
      {state === "loading" ? t("Opening…") : t("Support")}
    </button>
  );
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Affiliate commissions: report this shop's subscriptions if it was referred.
  // Fire-and-forget and self-throttled — never slows or breaks the page load.
  void syncAffiliate({ admin, shop: session.shop, request });

  // Shopify opens embedded apps with ?locale=<admin language>.
  const locale = resolveLocale(new URL(request.url).searchParams.get("locale"));

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    shop: session.shop,
    isOwner: isOwnerShop(session.shop),
    locale,
    messages: messagesFor(locale),
  };
};

// Only the admin's first load carries ?locale; in-app navigation and form
// submissions don't. Re-running this loader without it would flip the app
// back to English, so keep the data from the load that had it.
export function shouldRevalidate({ nextUrl, defaultShouldRevalidate }) {
  return nextUrl.searchParams.has("locale") ? defaultShouldRevalidate : false;
}

export default function App() {
  const { apiKey, shop, isOwner, locale, messages } = useLoaderData();

  return (
    <I18nProvider locale={locale} messages={messages}>
      <AppShell apiKey={apiKey} shop={shop} isOwner={isOwner} />
    </I18nProvider>
  );
}

function AppShell({ apiKey, shop, isOwner }) {
  const t = useT();

  // v2's AppProvider takes only children and apiKey, and always injects App
  // Bridge — the `embedded` prop it used to need is gone.
  return (
    <AppProvider apiKey={apiKey}>
      <SupportChat shop={shop} />
      <s-app-nav>
        <s-link href="/app">{t("Dashboard")}</s-link>
        <s-link href="/app/start">{t("Get Started")}</s-link>
        <s-link href="/app/migrate">{t("New Migration")}</s-link>
        <s-link href="/app/sync">{t("Sync Changes")}</s-link>
        <s-link href="/app/preview">{t("Preview")}</s-link>
        <s-link href="/app/history">{t("History")}</s-link>
        <s-link href="/app/plan">{t("Plans")}</s-link>
        <s-link href="/app/settings">{t("Settings")}</s-link>
        {isOwner && <s-link href="/app/stores">Owner dashboard</s-link>}
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
