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
