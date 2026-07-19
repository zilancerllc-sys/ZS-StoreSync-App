import { useEffect } from "react";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

const TAWK_SRC = "https://embed.tawk.to/6a538d517c60fa1d457184bb/1jtb60286";

function TawkChat({ shop }) {
  useEffect(() => {
    if (document.querySelector(`script[src="${TAWK_SRC}"]`)) return;
    window.Tawk_API = window.Tawk_API || {};
    window.Tawk_LoadStart = new Date();
    if (shop) {
      window.Tawk_API.visitor = { name: shop };
    }
    const script = document.createElement("script");
    script.async = true;
    script.src = TAWK_SRC;
    script.charset = "UTF-8";
    script.setAttribute("crossorigin", "*");
    document.head.appendChild(script);
  }, [shop]);

  return null;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "", shop: session.shop };
};

export default function App() {
  const { apiKey, shop } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <TawkChat shop={shop} />
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
