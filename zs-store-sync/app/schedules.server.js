// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — recurring automatic syncs
//
//  Two machines run this app and either can be suspended when idle, so the
//  scheduler cannot assume a single always-on timer. Every machine ticks, and
//  correctness comes from the database instead: a schedule is CLAIMED by
//  moving nextRunAt forward in the same UPDATE that checks it is due. Only one
//  machine's update matches, so only one run starts. The one-running-job-per
//  -shop index added in 20260804150000 is a second net under that.
// ═════════════════════════════════════════════════════════════════════════════
import db from "./db.server";
import { getUsage, filterAllowedTypes } from "./credits.server";
import { getVerifiedConnection } from "./connection.server";
import { startMigrationJob } from "./jobs.server";
// Pure scheduling rules live in a client-safe module so the Sync page can
// render cadence labels without pulling this file into the browser bundle.
import {
  FREQUENCY_LABEL,
  computeNextRun,
  planAllowsFrequency,
} from "./schedule-config";
import { notifySchedulePaused } from "./notify.server";

// ─── Read/write helpers used by the UI ───────────────────────────────────────
export async function getSchedule(ownerShop, sourceShop) {
  return db.syncSchedule.findUnique({
    where: { ownerShop_sourceShop: { ownerShop, sourceShop } },
  });
}

export async function listSchedules(ownerShop) {
  return db.syncSchedule.findMany({
    where: { ownerShop },
    orderBy: { createdAt: "desc" },
  });
}

export async function upsertSchedule({
  ownerShop,
  sourceShop,
  dataTypes,
  frequency,
  hourUtc,
  dayOfWeek,
  enabled = true,
  notify = true,
  notifyEmail = null,
}) {
  const nextRunAt = computeNextRun({ frequency, hourUtc, dayOfWeek });
  const data = {
    dataTypes: dataTypes.join(","),
    frequency,
    hourUtc,
    dayOfWeek,
    enabled,
    nextRunAt,
    lastError: null,
    notify,
    // Only overwrite a stored address when a new one was supplied, so editing
    // the cadence doesn't silently blank the recipient.
    ...(notifyEmail ? { notifyEmail } : {}),
  };
  return db.syncSchedule.upsert({
    where: { ownerShop_sourceShop: { ownerShop, sourceShop } },
    update: data,
    create: { ownerShop, sourceShop, ...data },
  });
}

export async function deleteSchedule(ownerShop, sourceShop) {
  return db.syncSchedule.deleteMany({ where: { ownerShop, sourceShop } });
}

// Turning a schedule off is the one outcome the merchant has to know about —
// it will not run again until they act. Skips (quota, authorization) stay
// silent because the next slot usually fixes itself.
async function pauseSchedule(schedule, reason) {
  await db.syncSchedule.update({
    where: { id: schedule.id },
    data: { enabled: false, lastError: reason },
  });
  if (schedule.notify && schedule.notifyEmail) {
    await notifySchedulePaused({
      to: schedule.notifyEmail,
      shop: schedule.ownerShop,
      sourceShop: schedule.sourceShop,
      reason,
    }).catch(() => {});
  }
}

// ─── Run one schedule, if it is still valid ──────────────────────────────────
// Returns a short reason string for the log; never throws.
async function runSchedule(schedule) {
  const { ownerShop, sourceShop } = schedule;

  // Re-check everything at run time. A plan can be downgraded, a pairing can be
  // disconnected, and a source store can uninstall — all long after the
  // schedule was created.
  const usage = await getUsage(ownerShop);
  if (!planAllowsFrequency(usage.plan, schedule.frequency)) {
    await pauseSchedule(
      schedule,
      `Paused — the ${usage.plan} plan does not include ${FREQUENCY_LABEL[schedule.frequency] || schedule.frequency} syncs.`,
    );
    return "plan no longer allows this cadence";
  }

  const conn = await getVerifiedConnection(ownerShop, sourceShop);
  if (!conn) {
    await pauseSchedule(schedule, "Paused — this store pairing was removed.");
    return "pairing removed";
  }

  const srcSession = await db.session.findFirst({
    where: { shop: sourceShop, isOnline: false },
  });
  if (!srcSession?.accessToken) {
    await db.syncSchedule.update({
      where: { id: schedule.id },
      data: { lastError: "Skipped — the source store is not authorized." },
    });
    return "source not authorized";
  }

  const requested = (schedule.dataTypes || "").split(",").filter(Boolean);
  const { allowed } = await filterAllowedTypes(ownerShop, requested);
  if (allowed.length === 0) {
    await db.syncSchedule.update({
      where: { id: schedule.id },
      data: { lastError: "Skipped — no scheduled data type is on your plan." },
    });
    return "no allowed types";
  }

  // Same per-type remaining-quota maths the manual Sync page does.
  const limits = {};
  for (const t of allowed) {
    limits[t] = usage.allowsOverage
      ? Infinity
      : Math.max((usage.limits[t] || 0) - (usage.usage[t] || 0), 0);
  }
  if (!usage.allowsOverage && Object.values(limits).every((n) => n <= 0)) {
    await db.syncSchedule.update({
      where: { id: schedule.id },
      data: { lastError: "Skipped — monthly quota is used up." },
    });
    return "quota exhausted";
  }

  const jobId = await startMigrationJob({
    shop: ownerShop,
    sourceShop,
    mode: "sync",
    types: allowed,
    limits,
    scheduleId: schedule.id,
  });

  // null means a run was already in flight for this shop; the schedule simply
  // waits for its next slot rather than queueing up behind it.
  await db.syncSchedule.update({
    where: { id: schedule.id },
    data: {
      lastJobId: jobId,
      lastError: jobId ? null : "Skipped — another run was already in progress.",
    },
  });
  return jobId ? `started job ${jobId}` : "another run in progress";
}

// ─── Claim and run everything that is due ────────────────────────────────────
export async function runDueSchedules(now = new Date()) {
  const due = await db.syncSchedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: 50,
  });

  const results = [];
  for (const schedule of due) {
    const nextRunAt = computeNextRun(schedule, now);

    // THE CLAIM. The where clause repeats the due check, so whichever machine
    // commits first moves nextRunAt and the others match zero rows.
    const claimed = await db.syncSchedule.updateMany({
      where: { id: schedule.id, enabled: true, nextRunAt: { lte: now } },
      data: { nextRunAt, lastRunAt: now },
    });
    if (claimed.count !== 1) continue;

    let outcome;
    try {
      outcome = await runSchedule(schedule);
    } catch (err) {
      outcome = `failed: ${String(err?.message || err).slice(0, 200)}`;
      await db.syncSchedule
        .update({
          where: { id: schedule.id },
          data: { lastError: outcome.slice(0, 400) },
        })
        .catch(() => {});
    }
    results.push({ id: schedule.id, shop: schedule.ownerShop, outcome });
  }
  return results;
}

// ─── Ticker ──────────────────────────────────────────────────────────────────
// Started from the server entry so it exists wherever the app runs. Every
// machine ticks; the claim above is what keeps that safe.
const TICK_MS = 60 * 1000;
const globalForTicker = global;

export function startScheduleTicker() {
  // Survive dev hot-reloads, which would otherwise stack up tickers.
  if (globalForTicker.zsScheduleTicker) return;
  globalForTicker.zsScheduleTicker = setInterval(() => {
    runDueSchedules().then(
      (r) => {
        if (r.length) console.log("[schedules]", JSON.stringify(r));
      },
      (err) => console.error("[schedules] tick failed:", err),
    );
  }, TICK_MS);
  // Do not hold the process open on shutdown.
  globalForTicker.zsScheduleTicker.unref?.();
}
