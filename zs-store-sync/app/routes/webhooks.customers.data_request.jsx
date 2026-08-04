import { authenticate } from "../shopify.server";

// GDPR — customers/data_request
// Sent when a store owner requests a customer's data on the merchant's behalf.
//
// ZS StoreSync is a pass-through migration tool: customer records are written
// straight to the target store and no customer profile is persisted here. The
// only trace an imported customer leaves is a per-job log line holding a masked
// email and the customer's Shopify id (see app/redact.server.js) — retained to
// let merchants diagnose a failed import, and scrubbed on customers/redact.
//
// That masked reference is not a customer profile, so there is nothing to hand
// back; we verify the HMAC (via authenticate.webhook) and acknowledge.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, {
    customer: payload?.customer?.id,
  });
  return new Response();
};
