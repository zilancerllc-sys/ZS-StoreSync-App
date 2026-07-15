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

// a "running" job older than this is considered dead (server restart etc.)
const STALE_MS = 2 * 60 * 60 * 1000;

// how many log lines the poll endpoint returns
export const LOG_TAIL = 40;

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
      startedAt: { lt: new Date(Date.now() - STALE_MS) },
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
export async function startMigrationJob({
  shop,
  sourceShop,
  mode, // "migrate" | "sync"
  types,
  limits,
}) {
  const job = await db.migrationJob.create({
    data: {
      shop,
      sourceShop,
      targetShop: shop,
      mode,
      dataTypes: types.join(","),
      status: "running",
      startedAt: new Date(),
    },
  });

  // fire-and-forget: the runner keeps going after this request responds
  runJob(job.id, { shop, sourceShop, types, limits, mode }).catch((err) => {
    console.error(`Migration job ${job.id} crashed:`, err);
  });

  return job.id;
}

async function runJob(jobId, { shop, sourceShop, types, limits, mode }) {
  const logs = [];
  let dirty = false;
  const onLog = (msg) => {
    logs.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
    dirty = true;
  };

  // flush logs to the job row every 2s so polling clients see live progress
  const flusher = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    db.migrationJob
      .update({ where: { id: jobId }, data: { logJson: safeLogsJson(logs) } })
      .catch(() => {});
  }, 2000);

  try {
    const { admin: source } = await unauthenticated.admin(sourceShop);
    const { admin: target } = await unauthenticated.admin(shop);

    const result = await runMigration({ source, target, types, limits, onLog });
    await consumeQuota(shop, result.consumedByType);

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
        logJson: safeLogsJson(logs),
        finishedAt: new Date(),
      },
    });
    await db.storeConnection.updateMany({
      where: { ownerShop: shop, sourceShop },
      data: { lastUsedAt: new Date() },
    });
  } catch (err) {
    clearInterval(flusher);
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
  }
}
