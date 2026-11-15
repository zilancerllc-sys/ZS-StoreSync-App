import { authenticateWebhook } from "../lib/webhook-auth.server";
import { queueInventoryChange } from "../live-inventory.server";

// inventory_levels/update, from every store with the app. Almost no store is a
// live-stock source, so this only queues (and only for sources); the stock is
// read fresh from the source on the ticker (app/live-inventory.server.js).
export const action = async ({ request }) => {
  const { shop, payload } = await authenticateWebhook(request);
  await queueInventoryChange(shop, payload?.inventory_item_id);
  return new Response();
};
