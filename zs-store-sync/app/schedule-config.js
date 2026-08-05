// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — scheduling rules and time maths
//
//  Deliberately NOT a .server module: the Sync page renders cadence labels and
//  gating in the component, and React Router only strips server imports that
//  are confined to loader/action. Everything here is pure — no database, no
//  secrets — so it is safe to ship to the browser. The database side lives in
//  schedules.server.js.
// ═════════════════════════════════════════════════════════════════════════════

// ─── Which cadences each plan may use ────────────────────────────────────────
// BUSINESS DECISION, not a technical constraint — every paid tier gets
// something and each step up buys a shorter interval. Change freely.
export const SCHEDULE_FREQUENCIES = {
  free: [],
  starter: ["weekly"],
  growth: ["weekly", "daily"],
  pro: ["weekly", "daily", "every6h"],
};

export const FREQUENCY_LABEL = {
  weekly: "Once a week",
  daily: "Once a day",
  every6h: "Every 6 hours",
};

export function planAllowsSchedule(plan) {
  return (SCHEDULE_FREQUENCIES[plan] || []).length > 0;
}

export function planAllowsFrequency(plan, frequency) {
  return (SCHEDULE_FREQUENCIES[plan] || []).includes(frequency);
}

// ─── Notification address ────────────────────────────────────────────────────
// The recipient is merchant-supplied, so it is validated on the server before
// anything is stored — an unchecked value meant a typo silently produced no
// mail at all, and left the app willing to send to whatever was typed.
//
// Deliberately NOT restricted to the store's own domain: wanting results at a
// personal or shared inbox is the normal case, and blocking it would break the
// feature for most merchants to deter an attack that costs the attacker a paid
// plan, a second store they control, and yields four templated emails a day.
// Every notification names the sending store and says how to turn it off.
// A practical character set rather than the full RFC grammar: the first
// attempt allowed "anything but whitespace and @" in the local part, which let
// input like "<script>@x.com" through — harmless where the value is used, but
// exactly the unusable address this check exists to catch. Quoted local parts
// and apostrophes are rejected along with it; neither reaches a real inbox
// often enough to be worth the looser rule.
const EMAIL_RE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
const EMAIL_MAX = 254; // RFC 5321

// Returns the cleaned address, or null when it isn't usable.
export function normalizeNotifyEmail(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s || s.length > EMAIL_MAX) return null;
  return EMAIL_RE.test(s) ? s : null;
}

// ─── When should this schedule fire next? ────────────────────────────────────
// Always strictly in the future, so a claim can never re-fire immediately —
// that property is what stops a due schedule spinning in a loop.
export function computeNextRun(
  { frequency, hourUtc = 3, dayOfWeek = 1 },
  from = new Date(),
) {
  const base = new Date(from.getTime());

  if (frequency === "every6h") {
    // Next 00:00 / 06:00 / 12:00 / 18:00 UTC boundary after `from`.
    const next = new Date(base);
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(Math.floor(base.getUTCHours() / 6) * 6 + 6);
    return next;
  }

  const hour = Math.min(23, Math.max(0, Number(hourUtc) || 0));
  const next = new Date(base);
  next.setUTCHours(hour, 0, 0, 0);

  if (frequency === "weekly") {
    const target = Math.min(6, Math.max(0, Number(dayOfWeek) || 0));
    // Days until the target weekday; 0 means today, which only counts if the
    // hour has not passed yet.
    let delta = (target - next.getUTCDay() + 7) % 7;
    if (delta === 0 && next <= base) delta = 7;
    next.setUTCDate(next.getUTCDate() + delta);
    return next;
  }

  // daily
  if (next <= base) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
