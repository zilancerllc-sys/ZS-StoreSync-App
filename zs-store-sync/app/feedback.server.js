// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — Feedback helpers
//  Stores in-app feedback and (for written low-rating feedback) notifies the
//  team by email via the Resend HTTP API — no extra npm dependency required.
//
//  Environment variables:
//    RESEND_API_KEY   Resend API key. If unset, feedback is stored but no
//                     email is sent (delivery is skipped, not an error).
//    FEEDBACK_TO      Recipient inbox (default: contact@zilancer.com)
//    FEEDBACK_FROM    Verified Resend sender
//                     (default: "ZS StoreSync <feedback@zilancer.com>")
// ═════════════════════════════════════════════════════════════════════════════
import db from "./db.server";

const FEEDBACK_TO = process.env.FEEDBACK_TO || "contact@zilancer.com";
const FEEDBACK_FROM =
  process.env.FEEDBACK_FROM || "ZS StoreSync <feedback@zilancer.com>";

// Minimal HTML escaping so merchant text can't break the email markup.
function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Send a feedback notification via Resend. Returns true on success, false if
// email is not configured or the request failed (never throws).
async function sendFeedbackEmail({ shop, rating, message }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
  const subject = `ZS StoreSync feedback — ${rating}/5 from ${shop}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#3a3128;">
      <h2 style="margin:0 0 8px;">New feedback for ZS StoreSync</h2>
      <p style="font-size:20px;letter-spacing:2px;color:#a98b76;margin:0 0 4px;">${stars} <span style="font-size:14px;color:#8a7d70;">(${rating}/5)</span></p>
      <p style="margin:0 0 16px;color:#8a7d70;">from <strong>${esc(shop)}</strong></p>
      <div style="border-left:3px solid #a98b76;padding:6px 0 6px 14px;white-space:pre-wrap;font-size:15px;line-height:1.6;">${
        message ? esc(message) : "<em>(no written message)</em>"
      }</div>
    </div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FEEDBACK_FROM,
        to: [FEEDBACK_TO],
        reply_to: FEEDBACK_TO,
        subject,
        html,
      }),
    });
    if (!res.ok) {
      console.error("[feedback] Resend error", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[feedback] Resend request failed", err);
    return false;
  }
}

// Persist feedback and, when there's a written message, email the team.
export async function recordFeedback({ shop, rating, message }) {
  const r = Math.max(1, Math.min(5, Number(rating) || 0));
  const text = (message || "").trim().slice(0, 4000) || null;

  // Only written (low-rating) feedback is emailed; store everything.
  const emailed = text ? await sendFeedbackEmail({ shop, rating: r, message: text }) : false;

  await db.feedback.create({
    data: { shop, rating: r, message: text, emailed },
  });

  return { ok: true, emailed };
}
