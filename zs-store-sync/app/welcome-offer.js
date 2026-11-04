// ═════════════════════════════════════════════════════════════════════════════
//  Free setup card for the welcome email
//
//  A new store gets one email: the welcome carries the done-for-you offer, so a
//  merchant who reads only the first mail still learns we'll set the app up for
//  them. The same file sits in every Zilancer app; each app passes its own copy
//  (COPY.welcomeOffer in lifecycle) and its brand colours.
//
//  Email-safe: tables, inline styles, a solid background (Outlook drops
//  gradients), and steps stacked as rows so nothing needs a media query.
// ═════════════════════════════════════════════════════════════════════════════

const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// offer: { kicker, title, text, steps: [{title, text}], ctaLabel, replyBody, note }
// Returns a full-width <table>; the caller wraps it in its own row or div.
export function welcomeOfferCard({ offer, shop, replyTo, appName, dark, light = "rgba(255,255,255,0.82)", font = FONT }) {
  if (!offer) return "";
  const esc = escHtml;
  const subject = `Free setup for ${shop || "my store"}`;
  const body = offer.replyBody || `Hi! Please set up ${appName || "the app"} for me.\n\nMy store: ${shop || ""}\nWhat I want:\n\n`;
  const href = `mailto:${replyTo}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  const steps = (offer.steps || []).map((s, i) => `
    <tr>
      <td width="40" valign="top" style="padding:0 0 14px;">
        <div style="width:28px;height:28px;border-radius:14px;background:#ffffff;text-align:center;font:800 13px/28px ${font};color:${dark};">${i + 1}</div>
      </td>
      <td valign="top" style="padding:3px 0 14px;">
        <div style="font:700 15px/1.3 ${font};color:#ffffff;">${esc(s.title)}</div>
        ${s.text ? `<div style="font:400 13.5px/1.55 ${font};color:${light};margin-top:3px;">${esc(s.text)}</div>` : ""}
      </td>
    </tr>`).join("");

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${dark};border-radius:22px;">
      <tr><td style="padding:30px 32px 30px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;"><tr>
          <td style="background:#ffffff;border-radius:999px;padding:6px 13px;font:700 10.5px/1 ${font};letter-spacing:1.6px;text-transform:uppercase;color:${dark};">&#9733;&nbsp; ${esc(offer.kicker || "Free setup")}</td>
        </tr></table>
        <div style="font:800 25px/1.2 ${font};letter-spacing:-0.5px;color:#ffffff;margin:0 0 10px;">${esc(offer.title)}</div>
        <div style="font:400 15px/1.6 ${font};color:${light};margin:0 0 22px;">${esc(offer.text)}</div>
        ${steps ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;">${steps}</table>` : ""}
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="border-radius:12px;background:#ffffff;">
            <a href="${esc(href)}" style="display:inline-block;padding:15px 24px;font:800 15px/1 ${font};color:${dark};text-decoration:none;border-radius:12px;">${esc(offer.ctaLabel || "Get my free setup")}&nbsp;&nbsp;&rarr;</a>
          </td></tr></table>
        ${offer.note ? `<div style="font:400 12.5px/1.6 ${font};color:${light};margin-top:16px;">${esc(offer.note)}</div>` : ""}
      </td></tr>
    </table>`;
}

// What every app's offer ends with: no password sharing, and WhatsApp.
export const OFFER_NOTE =
  "Or reply to this email, or WhatsApp us on +8801408270201. We work through a standard " +
  "Shopify collaborator request: you approve it, never share a password, and can remove it any time.";
