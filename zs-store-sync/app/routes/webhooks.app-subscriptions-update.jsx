import { authenticate } from "../shopify.server";
import { setPlan } from "../credits.server";
import db from "../db.server";

// The subscription "name" Shopify stores is the PLAN KEY passed to
// billing.request (e.g. "starter", "starter_annual") — not the display name
// from lineItems. Map every key, monthly and annual, to its base plan.
const NAME_TO_PLAN = {
  starter: "starter",
  starter_annual: "starter",
  growth: "growth",
  growth_annual: "growth",
  pro: "pro",
  pro_annual: "pro",
};

export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);

  const sub = payload?.app_subscription;
  const status = sub?.status;
  const nameKey = (sub?.name || "").toLowerCase().trim();
  const plan = NAME_TO_PLAN[nameKey];
  const interval = nameKey.endsWith("_annual") ? "annual" : "monthly";

  console.log("APP_SUBSCRIPTIONS_UPDATE:", {
    shop,
    status,
    name: sub?.name,
    plan,
  });

  if (status === "ACTIVE") {
    // Unknown names must NOT downgrade an active subscriber — only set the
    // plan when the name maps to one of ours. This also applies deferred
    // (APPLY_ON_NEXT_BILLING_CYCLE) downgrades when they activate: setPlan
    // clears any pendingPlan.
    if (plan) {
      await setPlan(shop, plan, String(sub?.admin_graphql_api_id || ""), {
        interval,
        // Shopify includes the current period end on this payload when
        // available; setPlan computes it from the interval otherwise.
        lockedUntil: sub?.current_period_end || undefined,
      });
    }
  } else if (["CANCELLED", "EXPIRED", "DECLINED"].includes(status)) {
    const gid = String(sub?.admin_graphql_api_id || "");
    const rec = await db.subscription.findUnique({ where: { shop } });

    // Ignore cancellations of subscriptions we no longer track — e.g. the OLD
    // subscription being cancelled as part of an upgrade/replacement. Without
    // this, that late CANCELLED event would wipe the freshly upgraded plan.
    if (rec?.shopifyChargeId && gid && rec.shopifyChargeId !== gid) {
      return new Response(null, { status: 200 });
    }

    // A merchant-scheduled downgrade cancels the subscription up front but
    // keeps the paid plan until the committed period ends (applied lazily by
    // getUsage). Don't cut it short here.
    if (
      rec?.pendingPlan &&
      rec?.lockedUntil &&
      new Date() < new Date(rec.lockedUntil)
    ) {
      return new Response(null, { status: 200 });
    }

    // Genuine end of subscription (declined payment, uninstall, expiry) —
    // drop back to free.
    await setPlan(shop, "free", null);
  }

  return new Response(null, { status: 200 });
};
