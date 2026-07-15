import { authenticate } from "../shopify.server";
import db from "../db.server";
import { parseLogsJson, LOG_TAIL } from "../jobs.server";

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
      logs: parseLogsJson(job.logJson).slice(-LOG_TAIL),
      finished: ["completed", "partial", "failed"].includes(job.status),
    },
  };
};
