import { authenticate } from "../shopify.server";
import db from "../db.server";

// GDPR — shop/redact
// Sent 48h after a store uninstalls the app. Remove everything we hold for the
// shop. HMAC is verified via authenticate.webhook before we touch the database.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Purge all shop-scoped records we persist.
  await db.session.deleteMany({ where: { shop } });
  await db.storeConnection.deleteMany({ where: { ownerShop: shop } });
  await db.storeConnection.deleteMany({ where: { sourceShop: shop } });
  await db.migrationJob.deleteMany({ where: { shop } });
  await db.subscription.deleteMany({ where: { shop } });

  return new Response();
};
