import { authenticate } from "../shopify.server";
import { setPlan } from "../credits.server";

const NAME_TO_PLAN = {
  starter: "starter",
  "starter annual": "starter",
  growth: "growth",
  "growth annual": "growth",
  pro: "pro",
  "pro annual": "pro",
};

export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);

  const sub = payload?.app_subscription;
  const status = sub?.status;
  const nameKey = (sub?.name || "").toLowerCase().trim();
  const plan = NAME_TO_PLAN[nameKey] || "free";

  console.log("APP_SUBSCRIPTIONS_UPDATE:", {
    shop,
    status,
    name: sub?.name,
    plan,
  });

  if (status === "ACTIVE") {
    await setPlan(shop, plan, String(sub?.admin_graphql_api_id || ""));
  } else if (["CANCELLED", "EXPIRED", "DECLINED"].includes(status)) {
    await setPlan(shop, "free", null);
  }

  return new Response(null, { status: 200 });
};
