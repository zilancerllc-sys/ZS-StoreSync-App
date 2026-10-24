/* eslint-env node */
// react-router 7.18 rejects an action (400 "Bad Request") when the Origin
// header doesn't match request.url's origin. Behind Fly's proxy request.url is
// http:// while the embedded app posts from https://, so every form in the app
// failed. The app's own host is the only origin allowed through.
const appHost = new URL(process.env.SHOPIFY_APP_URL || "https://zs-store-sync.fly.dev").host;

/** @type {import("@react-router/dev/config").Config} */
export default {
  allowedActionOrigins: [appHost],
};
