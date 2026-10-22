import { authenticateWebhook } from "../lib/webhook-auth.server";
import db from "../db.server";
import { setPlan } from "../credits.server";
import { onAppUninstalled } from "../lifecycle.server";
import { syncAffiliateAfterUninstall } from "../lib/affiliate.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticateWebhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Uninstalling cancels the subscription — stop any affiliate commission.
  void syncAffiliateAfterUninstall(shop);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  // No session comes back when its token could not be refreshed, but the
  // stored rows still have to go.
  await db.session.deleteMany({ where: { shop } });

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

  // Turn off this store's own schedules now. Left on, the next tick found the
  // Free plan and emailed a "schedule paused" notice to someone who had just
  // uninstalled.
  await db.syncSchedule.updateMany({
    where: { ownerShop: shop, enabled: true },
    data: { enabled: false, lastError: "Paused — the app was uninstalled." },
  });

  return new Response();
};
