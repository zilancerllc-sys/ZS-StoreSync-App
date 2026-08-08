// Liveness probe for fly-proxy.
//
// A resource route (no default export), so it never renders React and never
// touches Shopify auth — it answers as soon as the HTTP server is listening,
// which is exactly the moment the proxy is allowed to start routing here.
//
// Deliberately does NOT check the database. A health check that fails when
// Neon hiccups would pull every machine out of rotation at once and turn a
// brief database blip into a total outage. Whether this process can serve
// requests is the only question being asked.
export const loader = () =>
  new Response("ok", {
    status: 200,
    headers: {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    },
  });
