// app/lib/email-stats.server.js
// Reads this app's email numbers (sent, delivered, opened, clicked, bounced)
// for the owner dashboard's Emails card (components/EmailStats.jsx).
// All Zilancer apps send through one Resend account; ZS Bundles receives the
// Resend webhooks for all of them and serves each app its own numbers at
// /api/email-stats. Same file in every app except ZS Bundles, which reads its
// database directly.
//
// Fly secret: EMAIL_STATS_TOKEN (this app's read token; never printed).

const URL_DEFAULT = "https://zs-bundles.fly.dev/api/email-stats";

export async function loadEmailStats(app, days = 30) {
  const token = process.env.EMAIL_STATS_TOKEN;
  if (!token) return { error: "EMAIL_STATS_TOKEN is not set on this app." };
  const url = `${process.env.EMAIL_STATS_URL || URL_DEFAULT}?app=${encodeURIComponent(app)}&days=${days}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { error: `ZS Bundles answered ${res.status}.` };
    return await res.json();
  } catch (e) {
    console.error("[email-stats] fetch failed:", e?.message || e);
    return { error: "ZS Bundles did not answer in time; reload to try again." };
  }
}
