// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — background migration jobs
//
//  Migrations used to run inside the HTTP action, which hit the proxy's idle
//  timeout on any real store. Jobs now run detached from the request: the
//  action creates a MigrationJob row, kicks off the runner, and returns the
//  job id immediately. The client polls /app/jobs/:id for live status.
// ═════════════════════════════════════════════════════════════════════════════
import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { runMigration } from "./migrator.server";
import { consumeQuota } from "./credits.server";
import { redactPII } from "./redact.server";
import { notifyScheduledRun, shouldNotifyForJob } from "./notify.server";

// A "running" job whose row hasn't been touched in this long is considered
// dead (machine stopped, deploy, crash). This keys off updatedAt, not
// startedAt: the runner heartbeats the row every HEARTBEAT_MS, so a genuinely
// long migration stays alive while an abandoned one is caught quickly. Keying
// off startedAt got this backwards — it declared healthy long runs dead at two
// hours, and left killed ones showing "running" for two hours.
const STALE_MS = 10 * 60 * 1000;

// How often the runner touches its row while it has nothing new to log.
const HEARTBEAT_MS = 30 * 1000;

// ─── Log serialization that can never produce invalid JSON ────────────────────
// The old code sliced the JSON string, which could cut mid-token and make the
// History page crash on JSON.parse. Trim the ARRAY until the JSON fits instead.
export function safeLogsJson(logs) {
  let arr = logs;
  let json = JSON.stringify(arr);
  while (json.length > 100000 && arr.length > 1) {
    arr = arr.slice(Math.ceil(arr.length / 4)); // drop the oldest quarter
    arr = ["… earlier log lines trimmed …", ...arr];
    json = JSON.stringify(arr);
  }
  return json;
}

export function parseLogsJson(json) {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// ─── Housekeeping: mark dead "running" jobs as failed ─────────────────────────
export async function failStaleJobs(shop) {
  await db.migrationJob.updateMany({
    where: {
      shop,
      status: "running",
      updatedAt: { lt: new Date(Date.now() - STALE_MS) },
    },
    data: {
      status: "failed",
      error:
        "Interrupted — the job did not finish (server restarted mid-run). " +
        "Run it again: items that were already created will be skipped.",
      finishedAt: new Date(),
    },
  });
}

// ─── One migration/sync at a time per shop ────────────────────────────────────
export async function getActiveJob(shop) {
  await failStaleJobs(shop);
  return db.migrationJob.findFirst({
    where: { shop, status: "running" },
    orderBy: { createdAt: "desc" },
  });
}

// ─── Start a job and return its id immediately ────────────────────────────────
// Returns the new job's id, or null when a run is already in flight for this
// shop. Callers must handle null — see the partial unique index created in
// migration 20260804150000_one_running_job_per_shop.
export async function startMigrationJob({
  shop,
  sourceShop,
  mode, // "migrate" | "sync"
  types,
  limits,
  scheduleId = null, // set only when a SyncSchedule started this run
}) {
  let job;
  try {
    job = await db.migrationJob.create({
      data: {
        shop,
        sourceShop,
        targetShop: shop,
        mode,
        dataTypes: types.join(","),
        status: "running",
        startedAt: new Date(),
        scheduleId,
      },
    });
  } catch (err) {
    // P2002 = unique constraint violation. The database refused a second
    // concurrent run for this shop, which is the outcome we want: the caller's
    // getActiveJob() check can pass for two requests at once, this cannot.
    if (err?.code === "P2002") return null;
    throw err;
  }

  // fire-and-forget: the runner keeps going after this request responds
  runJob(job.id, { shop, sourceShop, types, limits, mode, scheduleId }).catch((err) => {
    console.error(`Migration job ${job.id} crashed:`, err);
  });

  return job.id;
}

// ─── Tell the merchant, but only when there is something to tell ─────────────
// Manual runs are never mailed about: the merchant is watching the screen. A
// scheduled run is mailed only when it failed or actually created something,
// so a nightly sync over an unchanged catalogue stays silent.
async function notifyIfScheduled(scheduleId, jobId) {
  if (!scheduleId) return;
  try {
    const [schedule, job] = await Promise.all([
      db.syncSchedule.findUnique({ where: { id: scheduleId } }),
      db.migrationJob.findUnique({ where: { id: jobId } }),
    ]);
    if (!schedule?.notify || !schedule.notifyEmail) return;
    if (!shouldNotifyForJob(job)) return;
    await notifyScheduledRun({
      to: schedule.notifyEmail,
      shop: job.shop,
      sourceShop: job.sourceShop,
      job,
    });
  } catch (err) {
    // Never let mail failure change the outcome of a run.
    console.error("[schedules] notify failed:", err);
  }
}

async function runJob(jobId, { shop, sourceShop, types, limits, mode, scheduleId }) {
  const logs = [];
  let dirty = false;
  const onLog = (msg) => {
    // Single chokepoint: job logs are persisted and shown on History, so every
    // line is scrubbed here rather than at each of the ~40 call sites. This
    // also covers PII echoed back inside Shopify userError / error messages.
    logs.push(`[${new Date().toISOString().slice(11, 19)}] ${redactPII(msg)}`);
    dirty = true;
  };

  // ── Quota billed as the run progresses, not at the end ──────────────────────
  // Charging only after runMigration() resolved meant an interrupted run was
  // free: a job killed after creating 2,900 products consumed no quota at all.
  // Items are counted here as they are created and flushed periodically, so
  // whatever a dead run produced has already been billed.
  const pendingQuota = {};
  let flushingQuota = false;
  const onConsume = (type) => {
    pendingQuota[type] = (pendingQuota[type] || 0) + 1;
  };
  const flushQuota = async () => {
    if (flushingQuota) return; // never let two flushes overlap
    const batch = {};
    let any = false;
    for (const [type, n] of Object.entries(pendingQuota)) {
      if (n > 0) {
        batch[type] = n;
        pendingQuota[type] = 0;
        any = true;
      }
    }
    if (!any) return;
    flushingQuota = true;
    try {
      await consumeQuota(shop, batch);
    } catch {
      // Put it back rather than dropping it — the next flush (or the final one
      // in the finally block) retries. Better to bill late than never.
      for (const [type, n] of Object.entries(batch)) {
        pendingQuota[type] = (pendingQuota[type] || 0) + n;
      }
    } finally {
      flushingQuota = false;
    }
  };

  // Flush logs every 2s so polling clients see live progress, and touch the row
  // at least every HEARTBEAT_MS so failStaleJobs can tell "still working" from
  // "machine went away".
  //
  // Both writes are updateMany guarded on status:"running" rather than a plain
  // update. clearInterval() stops new ticks but cannot recall a write already
  // in flight, and such a write landing after the final "completed" update
  // would revive the job as running (or roll its log back). The guard makes a
  // late write match zero rows instead.
  let lastWriteAt = Date.now();
  const flusher = setInterval(() => {
    flushQuota();
    if (dirty) {
      dirty = false;
      lastWriteAt = Date.now();
      db.migrationJob
        .updateMany({
          where: { id: jobId, status: "running" },
          data: { logJson: safeLogsJson(logs) },
        })
        .catch(() => {});
    } else if (Date.now() - lastWriteAt >= HEARTBEAT_MS) {
      lastWriteAt = Date.now();
      // No content change — this exists purely to bump updatedAt.
      db.migrationJob
        .updateMany({
          where: { id: jobId, status: "running" },
          data: { status: "running" },
        })
        .catch(() => {});
    }
  }, 2000);

  try {
    const { admin: source } = await unauthenticated.admin(sourceShop);
    const { admin: target } = await unauthenticated.admin(shop);

    const result = await runMigration({
      source,
      target,
      types,
      limits,
      mode,
      onLog,
      onConsume,
    });
    await flushQuota();

    const summary =
      mode === "sync"
        ? `${result.created} new · ${result.skipped} unchanged`
        : result.summary;

    clearInterval(flusher);
    await db.migrationJob.update({
      where: { id: jobId },
      data: {
        status: result.failed > 0 ? "partial" : "completed",
        itemCount: result.total,
        createdCount: result.created,
        updatedCount: result.updated,
        skippedCount: result.skipped,
        failedCount: result.failed,
        summary,
        statsJson: JSON.stringify(result.statsByType || {}),
        logJson: safeLogsJson(logs),
        finishedAt: new Date(),
      },
    });
    await db.storeConnection.updateMany({
      where: { ownerShop: shop, sourceShop },
      data: { lastUsedAt: new Date() },
    });
    await notifyIfScheduled(scheduleId, jobId);
  } catch (err) {
    clearInterval(flusher);
    // Bill whatever the run managed to create before it died.
    await flushQuota();
    await db.migrationJob
      .update({
        where: { id: jobId },
        data: {
          status: "failed",
          error: String(err?.message || err).slice(0, 500),
          logJson: safeLogsJson(logs),
          finishedAt: new Date(),
        },
      })
      .catch(() => {});
    // A scheduled run that died is exactly the case the merchant cannot see
    // for themselves, so this path always notifies.
    await notifyIfScheduled(scheduleId, jobId);
  }
}