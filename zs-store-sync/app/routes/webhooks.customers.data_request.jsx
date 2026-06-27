import { authenticate } from "../shopify.server";

// GDPR — customers/data_request
// Sent when a store owner requests a customer's data on the merchant's behalf.
// ZS StoreSync is a pass-through migration tool: it does not persist any customer
// PII on our servers, so there is no stored data to return. We verify the HMAC
// (via authenticate.webhook) and acknowledge.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, {
    customer: payload?.customer?.id,
  });
  // No customer data is stored on our servers — nothing to return.
  return new Response();
};
