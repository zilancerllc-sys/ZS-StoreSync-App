// app/routes/app.stores-export[.]csv.jsx
// Resource route: streams a CSV of all installed stores.
// Path: /app/stores-export.csv
// Only accessible by the app owner (no per-shop auth needed — queries all shops).

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { requireOwnerShop } from "../lib/owner.server";

function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const loader = async ({ request }) => {
  // This route reads every shop's row, so a plain merchant session is not
  // enough — only the app owner's store may download the roster.
  const { session } = await authenticate.admin(request);
  requireOwnerShop(session.shop);

  // ── Fetch all merchant contacts ─────────────────────────────────────────────
  const contacts = await db.merchantContact.findMany({
    orderBy: { installedAt: "desc" },
  });

  // ── Subscription info (plan per shop) ──────────────────────────────────────
  const subscriptions = await db.subscription.findMany();
  const subMap = Object.fromEntries(subscriptions.map((s) => [s.shop, s]));

  // ── Account-owner sessions (for first/last name) ────────────────────────────
  const sessions = await db.session.findMany({
    where: { accountOwner: true },
  });
  // A shop can have multiple sessions — keep the freshest one.
  const sessionMap = {};
  for (const s of sessions) {
    if (!sessionMap[s.shop] || (s.expires && s.expires > (sessionMap[s.shop].expires ?? 0))) {
      sessionMap[s.shop] = s;
    }
  }

  // ── Build rows ──────────────────────────────────────────────────────────────
  const header = [
    "shop_domain",
    "owner_first_name",
    "owner_last_name",
    "owner_email",
    "installed_at",
    "uninstalled_at",
    "status",
    "plan",
    "email_opted_in",
    "welcome_sent_at",
    "unsubscribed_at",
  ];

  const rows = contacts.map((c) => {
    const sub     = subMap[c.shop] ?? {};
    const sess    = sessionMap[c.shop] ?? {};

    return [
      c.shop,
      sess.firstName ?? "",
      sess.lastName ?? "",
      c.email ?? sess.email ?? "",
      c.installedAt   ? new Date(c.installedAt).toISOString().slice(0, 10)   : "",
      c.uninstalledAt ? new Date(c.uninstalledAt).toISOString().slice(0, 10) : "",
      c.uninstalledAt ? "Uninstalled" : "Active",
      sub.plan ?? "free",
      c.optedIn != null ? (c.optedIn ? "Yes" : "No") : "",
      c.welcomeSentAt    ? new Date(c.welcomeSentAt).toISOString().slice(0, 10)    : "",
      c.unsubscribedAt   ? new Date(c.unsubscribedAt).toISOString().slice(0, 10)   : "",
    ]
      .map(csvCell)
      .join(",");
  });

  const csv   = [header.join(","), ...rows].join("\n");
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="storesync-stores-${stamp}.csv"`,
    },
  });
};
