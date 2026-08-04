import { authenticate } from "../shopify.server";
import db from "../db.server";
import { parseLogsJson, safeLogsJson } from "../jobs.server";
import { customerLogTag, redactCustomerFromLogs } from "../redact.server";

// GDPR — customers/redact
// Sent 48h after a customer requests deletion.
//
// ZS StoreSync is a pass-through migration tool: customer records themselves
// are written straight to the target store and never persisted here. What we
// DO persist is the per-job log, which references imported customers, so that
// is what has to be scrubbed.
//
// The shop being redacted can appear in a job either as the owner (`shop`) or
// as the store being copied from (`sourceShop`), so both sides are searched.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const customerId = payload?.customer?.id;
  const email = payload?.customer?.email;
  const tag = customerLogTag(customerId);

  console.log(`Received ${topic} webhook for ${shop}`, { customer: customerId });

  if (!tag && !email) {
    // Nothing to match on — acknowledge rather than retry forever.
    return new Response();
  }

  const jobs = await db.migrationJob.findMany({
    where: { OR: [{ shop }, { sourceShop: shop }] },
    select: { id: true, logJson: true },
  });

  let scrubbed = 0;
  for (const job of jobs) {
    const logs = parseLogsJson(job.logJson);
    if (logs.length === 0) continue;

    const next = redactCustomerFromLogs(logs, { tag, email });
    if (!next) continue;

    await db.migrationJob.update({
      where: { id: job.id },
      data: { logJson: safeLogsJson(next) },
    });
    scrubbed++;
  }

  console.log(
    `customers/redact: scrubbed ${scrubbed} job log(s) for ${shop}`,
  );

  return new Response();
};
