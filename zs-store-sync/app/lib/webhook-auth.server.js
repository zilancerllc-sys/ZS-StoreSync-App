import crypto from "node:crypto";
import { authenticate } from "../shopify.server";

/**
 * authenticate.webhook, but one that still works after the shop has gone.
 *
 * With expiringOfflineAccessTokens on, the library refreshes an expired offline
 * token before handing over the webhook. After an uninstall the refresh is
 * refused and the library throws a bare 500, so app/uninstalled and the GDPR
 * webhooks failed every retry: the shop was never marked uninstalled and its
 * data was never redacted. Those webhooks need no Admin API access, so on that
 * failure we verify the HMAC ourselves and carry on without a session.
 */
export async function authenticateWebhook(request) {
  const copy = request.clone();
  try {
    return await authenticate.webhook(request);
  } catch (err) {
    if (!(err instanceof Response) || err.status !== 500) throw err;

    const rawBody = await copy.text();
    const header = copy.headers.get("x-shopify-hmac-sha256") || "";
    const digest = crypto
      .createHmac("sha256", process.env.SHOPIFY_API_SECRET || "")
      .update(rawBody, "utf8")
      .digest("base64");
    const a = Buffer.from(digest);
    const b = Buffer.from(header);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
    }

    const shop = copy.headers.get("x-shopify-shop-domain");
    // Same shape as the library's topic: "shop/redact" -> "SHOP_REDACT".
    const topic = (copy.headers.get("x-shopify-topic") || "")
      .toUpperCase()
      .replace(/[/.]/g, "_");
    console.warn(`[webhook] ${topic} for ${shop}: token refresh failed, handled without a session`);
    return {
      shop,
      topic,
      apiVersion: copy.headers.get("x-shopify-api-version"),
      webhookId: copy.headers.get("x-shopify-webhook-id"),
      payload: JSON.parse(rawBody || "{}"),
      session: undefined,
      admin: undefined,
    };
  }
}
