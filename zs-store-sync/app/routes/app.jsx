import { useState } from "react";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { MessageCircle } from "lucide-react";
import { authenticate } from "../shopify.server";

const TAWK_SRC = "https://embed.tawk.to/6a538d517c60fa1d457184bb/1jtb60286";

// Support chat, loaded only when the merchant asks for it.
//
// This used to mount on every screen: a third-party script on every page of an
// embedded admin app, receiving the shop's domain as the visitor name whether
// or not support was ever wanted. Now nothing leaves the page until the button
// is clicked — at which point the merchant has actively chosen to start a
// conversation, which is also when identifying their store is actually useful.
function SupportChat({ shop }) {
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
      aria-label="Contact support"
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
      {state === "loading" ? "Opening…" : "Support"}
    </button>
  );
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "", shop: session.shop };
};

export default function App() {
  const { apiKey, shop } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <SupportChat shop={shop} />
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/migrate">New Migration</s-link>
        <s-link href="/app/sync">Sync Changes</s-link>
        <s-link href="/app/preview">Preview</s-link>
        <s-link href="/app/history">History</s-link>
        <s-link href="/app/plan">Plans</s-link>
        <s-link href="/app/settings">Settings</s-link>
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
