// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — outbound email
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
//  Environment:
//    RESEND_API_KEY   Resend key. Unset = mail is skipped, never an error.
//    FEEDBACK_FROM    Verified sender.
// ═════════════════════════════════════════════════════════════════════════════

const FROM =
  process.env.FEEDBACK_FROM || "ZS StoreSync <feedback@zilancer.com>";

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
        Turn it off in ZS StoreSync → Sync Changes.
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
    subject,
    html: shell(failed ? "A scheduled sync failed" : "Your scheduled sync ran", body),
  });
}

// ─── A schedule turned itself off ────────────────────────────────────────────
export async function notifySchedulePaused({ to, shop, sourceShop, reason }) {
  return sendEmail({
    to,
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
             or turn them off in ZS StoreSync → Settings.<br>${esc(POSTAL_ADDRESS)}`
          : `Sent because ZS StoreSync was installed on your store.
             <a href="${esc(unsubscribeUrl(token))}" style="color:#8C6E58;">Unsubscribe from non-essential email</a>.<br>${esc(POSTAL_ADDRESS)}`
      }
    </div>
  </div>`;
}

// ─── 1. Welcome, on install ──────────────────────────────────────────────────
export async function sendWelcomeEmail({ to, shop, token, apps }) {
  const body = `
    <h2 style="margin:0 0 12px;font-size:22px;">Welcome to ZS StoreSync</h2>
    <p style="font-size:15px;line-height:1.65;margin:0 0 16px;">
      Thanks for installing on <b>${esc(shop)}</b>. ZS StoreSync copies products, collections, pages,
      files, blogs, menus, discounts and more from one Shopify store into
      another — no spreadsheets, no developer, and nothing stored on our servers.
    </p>
    <div style="background:#faf7f1;border:1px solid #ece5db;border-radius:12px;padding:16px 18px;margin:0 0 20px;">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px;">Getting set up takes three steps</div>
      <div style="font-size:14px;line-height:1.9;color:#6b6259;">
        1. Tell us which store you're copying <b>from</b><br>
        2. Install ZS StoreSync there too<br>
        3. Paste that store's connection code
      </div>
    </div>
    <p style="margin:0 0 22px;">${button(`${APP_URL}/app/start`, "Set up your first migration")}</p>
    <p style="font-size:14px;line-height:1.65;color:#6b6259;margin:0;">
      Re-run a migration whenever you like — anything that already exists is
      skipped, so nothing gets duplicated.
    </p>
    ${appsSection(apps)}`;

  return sendEmail({
    to,
    subject: `Welcome to ZS StoreSync — here's how to start`,
    html: mailShell(body, { token, promotional: false }),
  });
}

// ─── 2. Feedback nudge, two days in ──────────────────────────────────────────
// Points at the in-app rating widget rather than asking for a public review by
// email: it is the flow Shopify sanctions, and it already exists in the app.
export async function sendFeedbackEmail({ to, shop, token }) {
  const body = `
    <h2 style="margin:0 0 12px;font-size:21px;">How's ZS StoreSync working out?</h2>
    <p style="font-size:15px;line-height:1.65;margin:0 0 16px;">
      You installed ZS StoreSync on <b>${esc(shop)}</b> a couple of days ago.
      If you've run a migration, we'd like to know how it went — and if you got
      stuck, we'd rather hear that.
    </p>
    <p style="font-size:15px;line-height:1.65;margin:0 0 20px;">
      There's a short rating box on the dashboard. It takes a few seconds, and
      anything you write comes straight to us.
    </p>
    <p style="margin:0 0 20px;">${button(`${APP_URL}/app`, "Leave feedback")}</p>
    <p style="font-size:14px;line-height:1.65;color:#6b6259;margin:0;">
      Prefer to just reply to this email? That works too.
    </p>`;

  return sendEmail({
    to,
    subject: `How's ZS StoreSync working out?`,
    html: mailShell(body, { token, promotional: true }),
  });
}

// ─── 3. Product update ───────────────────────────────────────────────────────
export async function sendPromoEmail({ to, token, apps, headline, intro }) {
  const body = `
    <h2 style="margin:0 0 12px;font-size:21px;">${esc(headline)}</h2>
    <p style="font-size:15px;line-height:1.65;margin:0 0 18px;">${esc(intro)}</p>
    <p style="margin:0 0 6px;">${button(`${APP_URL}/app`, "Open ZS StoreSync")}</p>
    ${appsSection(apps, "Other apps that pair well with StoreSync")}`;

  return sendEmail({
    to,
    subject: headline,
    html: mailShell(body, { token, promotional: true }),
  });
}
