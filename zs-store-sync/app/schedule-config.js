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
