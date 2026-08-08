import { authenticate } from "../shopify.server";
import db from "../db.server";
import { setPlan } from "../credits.server";
import { onAppUninstalled } from "../lifecycle.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Shopify cancels subscriptions on uninstall — drop the plan now so a
  // reinstall never resumes a paid plan without an active subscription.
  await setPlan(shop, "free", null);

  // Stop the welcome/feedback/update sequence for a store that has left.
  await onAppUninstalled(shop);

  // Other stores can no longer pull from this shop until it re-authorizes.
  await db.storeConnection.updateMany({
    where: { sourceShop: shop },
    data: { authorized: false },
  });

  return new Response();
};
