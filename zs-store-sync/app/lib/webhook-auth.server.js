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

    // Without the secret every HMAC would be computed with an empty key, which
    // anyone can reproduce — refuse rather than accept forgeries.
    const secret = process.env.SHOPIFY_API_SECRET;
    if (!secret) throw new Response(undefined, { status: 401, statusText: "Unauthorized" });

    const rawBody = await copy.text();
    const header = copy.headers.get("x-shopify-hmac-sha256") || "";
    const digest = crypto
      .createHmac("sha256", secret)
      .update(rawBody, "utf8")
      .digest("base64");
    const a = Buffer.from(digest);
    const b = Buffer.from(header);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
    }

    // The HMAC covers the body, not the headers, so the shop named in the
    // header is only trusted when it is a real shop domain and agrees with the
    // signed body (GDPR payloads carry shop_domain; app/uninstalled carries
    // myshopify_domain).
    const shop = copy.headers.get("x-shopify-shop-domain") || "";
    let payload;
    try {
      payload = JSON.parse(rawBody || "{}");
    } catch {
      throw new Response(undefined, { status: 400, statusText: "Bad Request" });
    }
    const signedShop = payload.shop_domain || payload.myshopify_domain;
    if (
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ||
      (signedShop && signedShop !== shop)
    ) {
      throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
    }
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
      payload,
      session: undefined,
      admin: undefined,
    };
  }
}
