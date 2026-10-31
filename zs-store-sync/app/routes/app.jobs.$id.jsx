import { authenticate } from "../shopify.server";
import db from "../db.server";
import { parseLogsJson } from "../jobs.server";

// Resource route polled by the Migrate / Sync pages for live job status.
// Scoped to the authenticated shop — one merchant can never read another's job.
export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const job = await db.migrationJob.findFirst({
    where: { id: params.id, shop: session.shop },
  });
  if (!job) {
    throw new Response("Not found", { status: 404 });
  }

  return {
    ok: true,
    job: {
      id: job.id,
      status: job.status,
      mode: job.mode,
      sourceShop: job.sourceShop,
      created: job.createdCount,
      updated: job.updatedCount,
      skipped: job.skippedCount,
      failed: job.failedCount,
      total: job.itemCount,
      summary: job.summary,
      error: job.error,
      logs: parseLogsJson(job.logJson),
      finished: ["completed", "partial", "failed", "stopped"].includes(job.status),
    },
  };
};

// Stop button. Same shop scope as the loader; a finished run matches nothing.
export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const { count } = await db.migrationJob.updateMany({
    where: { id: params.id, shop: session.shop, status: "running" },
    data: { cancelRequested: true },
  });
  return { ok: count > 0 };
};
