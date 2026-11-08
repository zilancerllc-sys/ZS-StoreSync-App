/* eslint-disable react/prop-types */
// Free setup bar at the top of every app page. One click opens WhatsApp with a
// message the merchant reviews and sends themselves (app, store, email), so
// nothing is sent on their behalf. Dismissible for 7 days: Built for Shopify
// asks that admin banners can be closed.
import { useEffect, useState } from "react";

const WHATSAPP = "8801408270201";
const HIDE_KEY = "zs_setup_bar_hidden_until";
const HIDE_DAYS = 7;

export default function SetupBar({ appName, shop, email }) {
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    try {
      const until = Number(localStorage.getItem(HIDE_KEY) || 0);
      setHidden(until > Date.now());
    } catch {
      setHidden(false);
    }
  }, []);

  if (hidden) return null;

  const message =
    `Hi! Please set up ${appName} on my store for free.\n` +
    `Store: ${shop || ""}` +
    (email ? `\nEmail: ${email}` : "");
  const href = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(message)}`;

  const close = () => {
    try {
      localStorage.setItem(HIDE_KEY, String(Date.now() + HIDE_DAYS * 864e5));
    } catch {
      // Storage blocked: hide for this visit only.
    }
    setHidden(true);
  };

  return (
    <div
      role="region"
      aria-label="Free setup"
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap",
        background: "#0f5132", color: "#fff", padding: "9px 44px 9px 16px", position: "relative",
        fontSize: 14, lineHeight: 1.4, fontFamily: "inherit",
      }}
    >
      <span>
        <b>Free setup:</b> we&apos;ll set up {appName} on your store for you, at no cost.
      </span>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, background: "#25D366", color: "#0b2e1c",
          fontWeight: 700, textDecoration: "none", padding: "6px 14px", borderRadius: 999, whiteSpace: "nowrap",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.5-.3z" />
        </svg>
        Chat on WhatsApp
      </a>
      <button
        type="button"
        onClick={close}
        aria-label="Close"
        style={{
          position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "transparent",
          border: 0, color: "#fff", fontSize: 20, lineHeight: 1, cursor: "pointer", padding: 4, opacity: 0.8,
        }}
      >
        ×
      </button>
    </div>
  );
}
