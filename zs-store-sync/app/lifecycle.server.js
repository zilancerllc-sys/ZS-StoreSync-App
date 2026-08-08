// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — lifecycle email
//
//    install        → welcome
//    install + 2d   → feedback nudge
//    then           → an occasional product update
//
//  Consent, because this is the part with rules attached:
//
//  Shopify's Partner Program Agreement 2.1.2 — "Unless Partner has secured the
//  consent of the applicable Merchant […] Partner will not email any Merchant
//  […] whose email address they have received via Shopify." The welcome mail is
//  part of onboarding the service a merchant just installed and goes out
//  regardless; everything after it is gated on optedIn, and every send carries
//  a working unsubscribe link.
//
//  optedIn DEFAULTS TO TRUE. That is an opt-out model: fine under CAN-SPAM, but
//  GDPR does not accept a pre-ticked box as consent, so an EU or UK merchant
//  has technically not consented until they tick it themselves. To switch to
//  opt-in, change `optedIn` to default false in schema.prisma and drop the
//  `defaultChecked` on the Settings checkbox — nothing else needs to move.
// ═════════════════════════════════════════════════════════════════════════════
import { randomBytes } from "node:crypto";
import db from "./db.server";
import { RECOMMENDED_APPS } from "./recommended-apps";
import {
  sendWelcomeEmail,
  sendFeedbackEmail,
  sendPromoEmail,
} from "./notify.server";

const FEEDBACK_DELAY_MS = 2 * 24 * 60 * 60 * 1000;

// A week between product updates was the original plan. Fortnightly is the
// setting here because a weekly promo to a list this size buys unsubscribes and
// spam reports, and a poor sender reputation would start costing delivery of
// the sync notifications too — mail merchants actually asked for.
const PROMO_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

// First product update waits a week after the feedback nudge, so a new
// merchant's first fortnight is: welcome, feedback, then quiet.
const FIRST_PROMO_DELAY_MS = 9 * 24 * 60 * 60 * 1000;

const Q_SHOP_EMAIL = `#graphql { shop { email } }`;

// Three apps is enough to be useful in an email; the full six is a wall.
function pickApps(offset = 0, count = 3) {
  const list = RECOMMENDED_APPS;
  return Array.from(
    { length: Math.min(count, list.length) },
    (_, i) => list[(offset + i) % list.length],
  );
}

// ─── Install ─────────────────────────────────────────────────────────────────
// Called from the afterAuth hook. Must never throw: a failure here cannot be
// allowed to break the merchant's install.
export async function onAppInstalled({ shop, admin }) {
  try {
    let email = null;
    try {
      const res = await admin.graphql(Q_SHOP_EMAIL);
      email = (await res.json())?.data?.shop?.email || null;
    } catch {
      // No address means no lifecycle mail; the app itself works fine.
    }

    const now = new Date();
    const existing = await db.merchantContact.findUnique({ where: { shop } });

    // A reinstall shouldn't restart the whole sequence, and shouldn't quietly
    // re-subscribe someone who unsubscribed. Only clear the uninstall marker.
    if (existing) {
      await db.merchantContact.update({
        where: { shop },
        data: {
          uninstalledAt: null,
          ...(email ? { email } : {}),
        },
      });
      return { welcomed: false, reason: "already known" };
    }

    const contact = await db.merchantContact.create({
      data: {
        shop,
        email,
        unsubscribeToken: randomBytes(24).toString("base64url"),
        installedAt: now,
        feedbackDueAt: new Date(now.getTime() + FEEDBACK_DELAY_MS),
        nextPromoAt: new Date(now.getTime() + FIRST_PROMO_DELAY_MS),
      },
    });

    if (!email) return { welcomed: false, reason: "no email available" };

    const sent = await sendWelcomeEmail({
      to: email,
      shop,
      token: contact.unsubscribeToken,
      apps: pickApps(0),
    });
    if (sent) {
      await db.merchantContact.update({
        where: { shop },
        data: { welcomeSentAt: new Date() },
      });
    }
    return { welcomed: sent };
  } catch (err) {
    console.error("[lifecycle] install hook failed:", err);
    return { welcomed: false, reason: "error" };
  }
}

// ─── Uninstall ───────────────────────────────────────────────────────────────
export async function onAppUninstalled(shop) {
  await db.merchantContact
    .updateMany({
      where: { shop },
      // Clearing the due dates is what actually stops the sequence; the
      // timestamp is just so we know why.
      data: { uninstalledAt: new Date(), feedbackDueAt: null, nextPromoAt: null },
    })
    .catch(() => {});
}

// ─── Unsubscribe ─────────────────────────────────────────────────────────────
// By token, so the link works from an inbox with no session. Returns the shop
// on success so the page can confirm which store it applied to.
export async function unsubscribeByToken(token) {
  if (!token) return null;
  const contact = await db.merchantContact.findUnique({
    where: { unsubscribeToken: String(token) },
  });
  if (!contact) return null;
  await db.merchantContact.update({
    where: { id: contact.id },
    data: {
      optedIn: false,
      unsubscribedAt: new Date(),
      feedbackDueAt: null,
      nextPromoAt: null,
    },
  });
  return contact.shop;
}

// ─── Settings toggle ─────────────────────────────────────────────────────────
export async function setEmailPreference(shop, optedIn, email = null) {
  const now = new Date();
  let contact = await db.merchantContact.findUnique({ where: { shop } });

  // Stores that installed before lifecycle mail existed have no row, so the
  // checkbox would have saved nothing. Creating it here is also the only
  // consent-clean way to reach them: they are opting in themselves, on a
  // screen they navigated to, which is exactly what 2.1.2 asks for. No welcome
  // mail is sent — they installed long ago.
  if (!contact) {
    contact = await db.merchantContact.create({
      data: {
        shop,
        email,
        unsubscribeToken: randomBytes(24).toString("base64url"),
        // Not a new install: skip the feedback nudge, it would be odd months
        // after the fact.
        feedbackSentAt: now,
        welcomeSentAt: now,
      },
    });
  }

  return db.merchantContact.update({
    where: { shop },
    data: optedIn
      ? {
          optedIn: true,
          unsubscribedAt: null,
          // Re-subscribing restarts the product updates from the normal
          // interval rather than firing one immediately.
          nextPromoAt: new Date(now.getTime() + PROMO_INTERVAL_MS),
          feedbackDueAt: contact.feedbackSentAt
            ? null
            : new Date(contact.installedAt.getTime() + FEEDBACK_DELAY_MS),
        }
      : {
          optedIn: false,
          unsubscribedAt: now,
          feedbackDueAt: null,
          nextPromoAt: null,
        },
  });
}

export async function getEmailPreference(shop) {
  const c = await db.merchantContact.findUnique({ where: { shop } });
  return c ? { optedIn: c.optedIn, email: c.email } : null;
}

// ─── Due work ────────────────────────────────────────────────────────────────
// Same claim discipline as SyncSchedule: clear or move the due timestamp in the
// same UPDATE that checks it, so two machines ticking together cannot both send.
export async function runDueLifecycleEmails(now = new Date()) {
  const results = [];

  // ── Feedback nudges ──
  const dueFeedback = await db.merchantContact.findMany({
    where: {
      optedIn: true,
      uninstalledAt: null,
      feedbackSentAt: null,
      feedbackDueAt: { lte: now },
      email: { not: null },
    },
    take: 25,
  });

  for (const c of dueFeedback) {
    const claimed = await db.merchantContact.updateMany({
      where: { id: c.id, feedbackSentAt: null, feedbackDueAt: { lte: now } },
      data: { feedbackSentAt: now, feedbackDueAt: null },
    });
    if (claimed.count !== 1) continue;

    const sent = await sendFeedbackEmail({
      to: c.email,
      shop: c.shop,
      token: c.unsubscribeToken,
    }).catch(() => false);
    results.push({ shop: c.shop, kind: "feedback", sent });
  }

  // ── Product updates ──
  const duePromo = await db.merchantContact.findMany({
    where: {
      optedIn: true,
      uninstalledAt: null,
      nextPromoAt: { lte: now },
      email: { not: null },
    },
    take: 25,
  });

  for (const c of duePromo) {
    const next = new Date(now.getTime() + PROMO_INTERVAL_MS);
    const claimed = await db.merchantContact.updateMany({
      where: { id: c.id, nextPromoAt: { lte: now } },
      data: { nextPromoAt: next, lastPromoAt: now, promoCount: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;

    // Rotate which apps are shown so a merchant isn't sent the same three
    // every fortnight.
    const sent = await sendPromoEmail({
      to: c.email,
      token: c.unsubscribeToken,
      apps: pickApps(c.promoCount * 3),
      headline: "Getting more out of ZS StoreSync",
      intro:
        "A quick reminder of what the app can do beyond a one-off migration: " +
        "scheduled syncs keep a second store up to date on their own, Preview " +
        "shows what a run would change before it touches anything, and every " +
        "run is logged so you can see exactly what moved.",
    }).catch(() => false);
    results.push({ shop: c.shop, kind: "promo", sent });
  }

  return results;
}
