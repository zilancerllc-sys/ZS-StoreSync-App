import { authenticateWebhook } from "../lib/webhook-auth.server";
import { queueProductChange } from "../instant-sync.server";

// products/create and products/update, from every store with the app. Most
// stores have no one syncing from them, so this only queues; the work happens
// on the ticker (app/instant-sync.server.js).
export const action = async ({ request }) => {
  const { shop, payload } = await authenticateWebhook(request);
  await queueProductChange(shop, payload?.id);
  return new Response();
};
