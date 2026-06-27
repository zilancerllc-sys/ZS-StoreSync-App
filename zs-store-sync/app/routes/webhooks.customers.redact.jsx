import { authenticate } from "../shopify.server";

// GDPR — customers/redact
// Sent 48h after a customer requests deletion. ZS StoreSync does not store any
// customer PII (migrations are pass-through, store-to-store), so there is nothing
// to redact. We verify the HMAC (via authenticate.webhook) and acknowledge.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, {
    customer: payload?.customer?.id,
  });
  // No customer data is stored on our servers — nothing to redact.
  return new Response();
};
