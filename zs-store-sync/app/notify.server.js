// ═════════════════════════════════════════════════════════════════════════════
//  Outbound email (shared across the Zilancer apps)
//
//  Two audiences with different rules:
//    • the team   — merchant feedback (see feedback.server.js)
//    • merchants  — what their scheduled syncs did while they weren't looking
//
//  Merchant mail is strictly rationed. A daily sync that finds nothing new is
//  the normal case, and mailing about it every morning is how an app gets
//  filtered to spam. Only three things are worth an email: something was
//  created, the run failed, or the schedule stopped and needs a human.
//
//  This file is copied verbatim into the other Zilancer apps: everything that
//  differs between them comes from the environment or from the caller, so
//  there is nothing to find-and-replace.
//
//  Environment:
//    RESEND_API_KEY     Resend key. Unset = mail is skipped, never an error.
//    APP_NAME           Shown to merchants, e.g. "ZS StoreSync".
//    FEEDBACK_FROM      Verified sender.
//    MAIL_REPLY_TO      Where replies go.
//    MAIL_FROM_ADDRESS  Postal address, required by CAN-SPAM.
//    SHOPIFY_APP_URL    Base URL for links back into the app.
// ═════════════════════════════════════════════════════════════════════════════

export const APP_NAME = process.env.APP_NAME || "ZS StoreSync";

const FROM =
  process.env.FEEDBACK_FROM || `${APP_NAME} <noreply@zilancer.com>`;

// Sending from noreply@ means a merchant who hits Reply gets a bounce, which
// is a poor way to treat someone answering a mail that asked for feedback.
// Every merchant email therefore carries a Reply-To that a human reads.
const REPLY_TO = process.env.MAIL_REPLY_TO || "contact@zilancer.com";

// Minimal HTML escaping so shop names and error text can't break the markup.
export function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Send one email. Returns true on success; never throws, because no email is
// worth failing a migration over.
export async function sendEmail({ to, subject, html, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return false;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject,
        html,
      }),
    });
    if (!res.ok) {
      console.error("[notify] Resend error", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[notify] Resend request failed", err);
    return false;
  }
}

function shell(heading, bodyHtml) {
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#3a3128;max-width:520px;">
      <h2 style="margin:0 0 14px;font-size:19px;">${esc(heading)}</h2>
      ${bodyHtml}
      <p style="margin:22px 0 0;font-size:12px;color:#8a7d70;">
        You're getting this because automatic sync is on for this store.
        Turn it off in ${esc(APP_NAME)} → Sync Changes.
      </p>
    </div>`;
}

function statRow(label, value, color) {
  return `<tr>
    <td style="padding:5px 0;font-size:14px;color:#8a7d70;">${esc(label)}</td>
    <td style="padding:5px 0;font-size:15px;font-weight:600;text-align:right;color:${color};">${esc(String(value))}</td>
  </tr>`;
}

// ─── A scheduled run finished ────────────────────────────────────────────────
// Only called when there is something to say — see shouldNotifyForJob below.
export async function notifyScheduledRun({ to, shop, sourceShop, job }) {
  const failed = job.status === "failed";
  const subject = failed
    ? `Automatic sync failed — ${shop}`
    : `Automatic sync: ${job.createdCount} new item${job.createdCount === 1 ? "" : "s"} added to ${shop}`;

  const body = failed
    ? `<p style="font-size:14px;line-height:1.6;margin:0 0 14px;">
         The scheduled sync from <b>${esc(sourceShop)}</b> into <b>${esc(shop)}</b>
         didn't finish.
       </p>
       <div style="border-left:3px solid #d97757;padding:8px 0 8px 14px;font-size:14px;color:#9a3412;">
         ${esc(job.error || "No further detail was recorded.")}
       </div>
       <p style="font-size:14px;line-height:1.6;margin:16px 0 0;">
         The schedule is still on and will try again at its next slot. Anything
         already copied is skipped on the retry.
       </p>`
    : `<p style="font-size:14px;line-height:1.6;margin:0 0 14px;">
         The scheduled sync from <b>${esc(sourceShop)}</b> into <b>${esc(shop)}</b>
         has run.
       </p>
       <table style="width:100%;border-collapse:collapse;">
         ${statRow("Created", job.createdCount, "#8A9163")}
         ${statRow("Already up to date", job.skippedCount, "#8a7d70")}
         ${job.failedCount ? statRow("Failed", job.failedCount, "#9a3412") : ""}
       </table>`;

  return sendEmail({
    to,
    replyTo: REPLY_TO,
    subject,
    html: shell(failed ? "A scheduled sync failed" : "Your scheduled sync ran", body),
  });
}

// ─── A schedule turned itself off ────────────────────────────────────────────
export async function notifySchedulePaused({ to, shop, sourceShop, reason }) {
  return sendEmail({
    to,
    replyTo: REPLY_TO,
    subject: `Automatic sync paused — ${shop}`,
    html: shell(
      "Automatic sync has been paused",
      `<p style="font-size:14px;line-height:1.6;margin:0 0 14px;">
         The schedule copying from <b>${esc(sourceShop)}</b> into
         <b>${esc(shop)}</b> has stopped and won't run again until you turn it
         back on.
       </p>
       <div style="border-left:3px solid #a98b76;padding:8px 0 8px 14px;font-size:14px;">
         ${esc(reason)}
       </div>`,
    ),
  });
}

// A finished run is only worth an email if it failed or actually did something.
// A daily sync that finds nothing new is the normal case and stays silent.
export function shouldNotifyForJob(job) {
  if (!job) return false;
  return job.status === "failed" || (job.createdCount || 0) > 0;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Lifecycle mail — welcome, feedback nudge, product updates
// ═════════════════════════════════════════════════════════════════════════════

const APP_URL = process.env.SHOPIFY_APP_URL || "https://zs-store-sync.fly.dev";

// CAN-SPAM requires a real postal address in anything promotional. Set
// MAIL_FROM_ADDRESS to your registered address; the placeholder is obvious on
// purpose so an unset value is caught in review rather than by a regulator.
const POSTAL_ADDRESS =
  process.env.MAIL_FROM_ADDRESS || "Zilancer LLC — address not configured";

function unsubscribeUrl(token) {
  return `${APP_URL}/unsubscribe/${encodeURIComponent(token)}`;
}

function button(href, label) {
  return `<a href="${esc(href)}" style="display:inline-block;background:#a98b76;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:10px;">${esc(label)}</a>`;
}

// The other Zilancer apps, as a simple stacked list. Deliberately not a CSS
// grid: Outlook drops most modern layout, and a broken grid in a welcome email
// is a worse first impression than a plain one.
function appsSection(apps, heading = "More from Zilancer Studio") {
  const rows = apps
    .map(
      (a) => `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #ece5db;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
            <tr>
              <td style="width:44px;vertical-align:top;padding-right:12px;">
                <img src="${esc(a.icon)}" width="40" height="40" alt="" style="width:40px;height:40px;border-radius:9px;display:block;">
              </td>
              <td style="vertical-align:top;">
                <a href="${esc(a.link)}" style="font-size:15px;font-weight:600;color:#3a3128;text-decoration:none;">${esc(a.name)}</a>
                <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#a98b76;margin:2px 0 4px;">${esc(a.category)}</div>
                <div style="font-size:13.5px;line-height:1.55;color:#6b6259;">${esc(a.description)}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>`,
    )
    .join("");

  return `
    <div style="margin:30px 0 0;padding-top:22px;border-top:2px solid #3a3128;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#a98b76;margin-bottom:3px;">From the Zilancer Studio</div>
      <h3 style="margin:0 0 6px;font-size:17px;color:#3a3128;">${esc(heading)}</h3>
      <p style="margin:0 0 6px;font-size:13px;color:#8a7d70;">Every one has a free plan.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">${rows}</table>
    </div>`;
}

function mailShell(bodyHtml, { token, promotional }) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,sans-serif;color:#3a3128;max-width:560px;margin:0 auto;padding:8px;">
    ${bodyHtml}
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #ece5db;font-size:11.5px;line-height:1.7;color:#a09488;">
      ${
        promotional
          ? `You're receiving this because product updates are switched on for your store.
             <a href="${esc(unsubscribeUrl(token))}" style="color:#8C6E58;">Unsubscribe</a> —
             or turn them off in ${esc(APP_NAME)} → Settings.<br>${esc(POSTAL_ADDRESS)}`
          : `Sent because ${esc(APP_NAME)} was installed on your store.
             <a href="${esc(unsubscribeUrl(token))}" style="color:#8C6E58;">Unsubscribe from non-essential email</a>.<br>${esc(POSTAL_ADDRESS)}`
      }
    </div>
  </div>`;
}

// ─── 1. Welcome, on install ──────────────────────────────────────────────────
// Everything app-specific (blurb, steps, cta, closing, chips, highlights,
// helpLinks) comes from the COPY block at the top of lifecycle.server.js; an
// app that leaves the optional ones out simply gets those blocks omitted.
//
// Built from nested tables with inline styles only: Outlook ignores most CSS
// layout and Gmail strips <style>, so anything fancier breaks for someone.
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function welcomeEmailHtml({
  shop,
  token,
  apps = [],
  blurb = "",
  steps = [],
  cta = { path: "/app", label: "Open the app" },
  closing = "",
  chips = [],
  highlights = [],
  helpLinks = [],
}) {
  const ctaUrl = `${APP_URL}${cta.path}`;

  // Bulletproof button: a table cell carries the colour, so it survives
  // clients that drop padding or background on <a>.
  const bigButton = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr><td bgcolor="#2B231D" style="border-radius:12px;">
        <a href="${esc(ctaUrl)}" style="display:inline-block;padding:15px 28px;font-family:${SANS};font-size:15px;font-weight:700;color:#FFFCF8;text-decoration:none;border-radius:12px;">${esc(cta.label)} &rarr;</a>
      </td></tr>
    </table>`;

  const stepRows = steps
    .map(
      (t, i) => `
      <tr>
        <td width="44" valign="top" style="padding:0 0 14px;">
          <div style="width:32px;height:32px;line-height:32px;border-radius:16px;background:#2B231D;color:#E2BE7E;text-align:center;font-family:${SERIF};font-size:16px;">${i + 1}</div>
        </td>
        <td valign="middle" style="padding:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.5;color:#2B231D;">${esc(t)}</td>
      </tr>`,
    )
    .join("");

  const stepsBlock = steps.length
    ? `<tr><td style="padding:0 36px 8px;">
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFCF8;border:1px solid #ECE2D5;border-radius:16px;">
           <tr><td style="padding:22px 22px 8px;">
             <div style="font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:#A07E66;margin:0 0 14px;">Get set up in ${steps.length} steps</div>
             <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stepRows}</table>
           </td></tr>
         </table>
       </td></tr>`
    : "";

  const chipsBlock = chips.length
    ? `<tr><td style="padding:22px 36px 0;">
         <div style="font-family:${SANS};font-size:11px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:#A07E66;margin:0 0 10px;">What you can copy</div>
         <div style="font-family:${SANS};font-size:13px;line-height:2.3;">
           ${chips
             .map(
               (c) =>
                 `<span style="display:inline-block;background:#F6EEE3;border:1px solid #ECE2D5;border-radius:999px;padding:2px 11px;margin:0 4px 0 0;color:#5C4E43;white-space:nowrap;">${esc(c)}</span>`,
             )
             .join(" ")}
         </div>
       </td></tr>`
    : "";

  const highlightsBlock = highlights.length
    ? `<tr><td style="padding:26px 36px 0;">
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
           ${highlights
             .map(
               (h) => `
             <tr><td style="padding:0 0 14px;">
               <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid #8E9A5E;">
                 <tr><td style="padding:2px 0 2px 14px;font-family:${SANS};">
                   <div style="font-size:15px;font-weight:700;color:#2B231D;">${esc(h.title)}</div>
                   <div style="font-size:14px;line-height:1.55;color:#75665A;">${esc(h.text)}</div>
                 </td></tr>
               </table>
             </td></tr>`,
             )
             .join("")}
         </table>
       </td></tr>`
    : "";

  const helpBlock = helpLinks.length
    ? `<tr><td style="padding:12px 36px 0;font-family:${SANS};font-size:14px;line-height:1.7;color:#75665A;">
         Need a hand? ${helpLinks
           .map(
             (l) =>
               `<a href="${esc(l.url)}" style="color:#8A6A55;font-weight:700;text-decoration:underline;">${esc(l.label)}</a>`,
           )
           .join(" &middot; ")} &middot; or just reply to this email — a person reads every one.
       </td></tr>`
    : "";

  const preheader = `Thanks for installing on ${shop}. Here's how to run your first migration.`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome to ${esc(APP_NAME)}</title></head>
<body style="margin:0;padding:0;background:#F3ECE2;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#F3ECE2" style="background:#F3ECE2;">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FAF5EE;border-radius:20px;overflow:hidden;">

        <tr><td bgcolor="#1E1813" style="background:#1E1813;padding:22px 36px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-family:${SANS};font-size:13px;font-weight:800;letter-spacing:2px;color:#FFFCF8;">${esc(APP_NAME.toUpperCase())}</td>
            <td align="right" style="font-family:${SANS};font-size:12px;color:#C9BBAC;">Store &rarr; Store</td>
          </tr></table>
        </td></tr>

        <tr><td bgcolor="#1E1813" style="background:#1E1813;padding:8px 36px 36px;">
          <div style="font-family:${SERIF};font-size:34px;line-height:1.12;color:#FFFCF8;margin:0 0 14px;">Welcome aboard. <span style="font-style:italic;color:#E2BE7E;">Let's move your store.</span></div>
          <div style="font-family:${SANS};font-size:15px;line-height:1.65;color:#C9BBAC;">Thanks for installing on <b style="color:#FFFCF8;">${esc(shop)}</b>. ${esc(blurb)}</div>
        </td></tr>

        <tr><td style="padding:30px 36px 18px;">${bigButton}</td></tr>

        ${stepsBlock}
        ${chipsBlock}
        ${highlightsBlock}

        ${closing ? `<tr><td style="padding:6px 36px 0;font-family:${SANS};font-size:14px;line-height:1.65;color:#75665A;">${esc(closing)}</td></tr>` : ""}
        ${helpBlock}

        ${apps.length ? `<tr><td style="padding:6px 36px 0;font-family:${SANS};">${appsSection(apps)}</td></tr>` : ""}

        <tr><td style="padding:28px 36px 30px;font-family:${SANS};font-size:11.5px;line-height:1.7;color:#A09488;">
          Sent because ${esc(APP_NAME)} was installed on ${esc(shop)}.
          <a href="${esc(unsubscribeUrl(token))}" style="color:#8C6E58;">Unsubscribe from non-essential email</a>.<br>${esc(POSTAL_ADDRESS)}
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

export async function sendWelcomeEmail({ to, ...opts }) {
  return sendEmail({
    to,
    replyTo: REPLY_TO,
    subject: `Welcome to ${APP_NAME} — here's how to start`,
    html: welcomeEmailHtml(opts),
  });
}

// ─── 2. Feedback nudge, two days in ──────────────────────────────────────────
// Points at the in-app rating widget rather than asking for a public review by
// email: it is the flow Shopify sanctions, and it already exists in the app.
// Deliberately does not name the store — the merchant knows which one they
// installed, and the domain added nothing but clutter.
export async function sendFeedbackEmail({ to, token, experience = "experience" }) {
  const body = `
    <h2 style="margin:0 0 14px;font-size:21px;">How's ${esc(APP_NAME)} working out?</h2>
    <p style="font-size:15px;line-height:1.65;margin:0 0 16px;">
      You installed ${esc(APP_NAME)} a few days ago, and we&rsquo;d love to hear
      how your ${esc(experience)} went.
    </p>
    <p style="font-size:15px;line-height:1.65;margin:0 0 22px;">
      Did everything go smoothly, or did you run into any issues along the way?
      Your honest feedback helps us identify areas where we can improve and make
      ${esc(APP_NAME)} easier to use.
    </p>
    <p style="margin:0 0 22px;">${button(`${APP_URL}/app`, "Share your feedback")}</p>
    <p style="font-size:15px;line-height:1.65;margin:0 0 16px;">
      You&rsquo;ll find a short feedback box on your dashboard. It only takes a
      few seconds, and anything you share goes directly to our team.
    </p>
    <p style="font-size:15px;line-height:1.65;margin:0;">
      Thank you for using ${esc(APP_NAME)}!
    </p>`;

  return sendEmail({
    to,
    replyTo: REPLY_TO,
    subject: `How's ${APP_NAME} working out?`,
    html: mailShell(body, { token, promotional: true }),
  });
}

// ─── 3. Product update ───────────────────────────────────────────────────────
export async function sendPromoEmail({ to, token, apps, headline, intro }) {
  const body = `
    <h2 style="margin:0 0 12px;font-size:21px;">${esc(headline)}</h2>
    <p style="font-size:15px;line-height:1.65;margin:0 0 18px;">${esc(intro)}</p>
    <p style="margin:0 0 6px;">${button(`${APP_URL}/app`, `Open ${APP_NAME}`)}</p>
    ${appsSection(apps, "Other apps from the same studio")}`;

  return sendEmail({
    to,
    replyTo: REPLY_TO,
    subject: headline,
    html: mailShell(body, { token, promotional: true }),
  });
}

// ─── Review request, sent by hand ────────────────────────────────────────────
// From the owner dashboard, for a store that is using the app. No incentive of
// any kind (Shopify forbids it), and the review link goes to everyone -- the
// "reply instead" line is an addition, never a gate in front of the review.
const REVIEW_REQUEST_URL = "https://apps.shopify.com/zs-storesync#modal-show=WriteReviewModal";

export async function sendReviewRequestEmail({ to, token }) {
  const body = `
    <h2 style="margin:0 0 14px;font-size:21px;">How is ${esc(APP_NAME)} working for you?</h2>
    <p style="font-size:15px;line-height:1.65;margin:0 0 16px;">
      Thanks for using ${esc(APP_NAME)}. If it has been useful, a short review on
      the Shopify App Store would mean a lot. We&rsquo;re a small studio, and
      reviews are how other merchants find us.
    </p>
    <p style="margin:0 0 22px;">${button(REVIEW_REQUEST_URL, "Write a quick review")}</p>
    <p style="font-size:15px;line-height:1.65;margin:0;">
      Something not right? Reply to this email as well &mdash; it comes straight
      to us and we&rsquo;ll fix it.
    </p>`;

  return sendEmail({
    to,
    replyTo: REPLY_TO,
    subject: `A quick favour from the ${APP_NAME} team`,
    html: mailShell(body, { token, promotional: true }),
  });
}
