// app/lib/ga4.server.js
// App Store listing traffic for the owner dashboard, read from Google Analytics 4.
//
// The App Store sends listing page views to our GA4 property, and a visit that
// came from a search carries the search in the page URL:
//   apps.shopify.com/zs-storesync?surface_type=search&surface_detail=quantity+breaks
// so the keywords people typed are the surface_detail of the search visits.
//
// Access is a Google Cloud service account that has been added as a Viewer on
// the GA4 property. Its JSON key lives in the Fly secret GA4_SERVICE_ACCOUNT
// and nowhere else; without it the dashboard shows how to connect instead.
// No Google SDK: one signed JWT for a token, then plain runReport calls.
import { createSign } from "node:crypto";

// eslint-disable-next-line no-undef
const PROPERTY = process.env.GA4_PROPERTY_ID || "549429664";
const LISTING_HOST = "apps.shopify.com";
// eslint-disable-next-line no-undef
const SITE_HOST = process.env.SITE_HOST || "zs-storesync.zilancer.com";
const CACHE_MS = 15 * 60 * 1000;

let tokenCache = null;
const reportCache = new Map();

function credentials() {
  try {
    // eslint-disable-next-line no-undef
    const c = JSON.parse(process.env.GA4_SERVICE_ACCOUNT || "");
    return c.client_email && c.private_key ? c : null;
  } catch {
    return null;
  }
}

export const ga4Connected = () => !!credentials();

async function accessToken(c) {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: c.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(c.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${sig}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed (${res.status})`);
  tokenCache = { token: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function runReport(token, body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `GA4 report failed (${res.status})`);
  return (json.rows || []).map((r) => ({
    d: (r.dimensionValues || []).map((v) => v.value),
    m: (r.metricValues || []).map((v) => Number(v.value) || 0),
  }));
}

const onHost = (host) => ({
  filter: { fieldName: "hostName", stringFilter: { matchType: "EXACT", value: host } },
});

// Where a listing visit came from, in words the owner reads.
const SURFACE = {
  search: "App Store search",
  search_ad: "App Store ad",
  category: "Category page",
  collection: "Collection page",
  home: "App Store home",
  app_details: "Another app's page",
  partners_page: "Our partner page",
  partners: "Our partner page",
  app_group: "App group page",
  navbar: "App Store menu",
};

// startDate: "YYYY-MM-DD". Returns { connected, error?, ...numbers }.
export async function listingTraffic(startDate) {
  const c = credentials();
  if (!c) return { connected: false };
  const key = startDate;
  const hit = reportCache.get(key);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.data;

  try {
    const token = await accessToken(c);
    const dateRanges = [{ startDate, endDate: "today" }];
    const [totals, byUrl, events, site] = await Promise.all([
      runReport(token, {
        dateRanges,
        metrics: [{ name: "screenPageViews" }, { name: "totalUsers" }],
        dimensionFilter: onHost(LISTING_HOST),
      }),
      runReport(token, {
        dateRanges,
        dimensions: [{ name: "pageLocation" }],
        metrics: [{ name: "screenPageViews" }],
        dimensionFilter: onHost(LISTING_HOST),
        limit: 2000,
      }),
      runReport(token, {
        dateRanges,
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "eventCount" }],
        dimensionFilter: onHost(LISTING_HOST),
        orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
        limit: 15,
      }),
      runReport(token, {
        dateRanges,
        metrics: [{ name: "screenPageViews" }, { name: "totalUsers" }],
        dimensionFilter: onHost(SITE_HOST),
      }),
    ]);

    const keywords = {};
    const sources = {};
    for (const r of byUrl) {
      let u;
      try { u = new URL(r.d[0]); } catch { continue; }
      const type = u.searchParams.get("surface_type") || "direct";
      const views = r.m[0];
      const label = SURFACE[type] || (type === "direct" ? "Direct / outside link" : type);
      sources[label] = (sources[label] || 0) + views;
      if (type === "search") {
        const kw = (u.searchParams.get("surface_detail") || "").trim().toLowerCase();
        if (kw) keywords[kw] = (keywords[kw] || 0) + views;
      }
    }
    const sort = (o) => Object.entries(o).map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n);
    const data = {
      connected: true,
      views: totals[0]?.m[0] || 0,
      visitors: totals[0]?.m[1] || 0,
      keywords: sort(keywords).slice(0, 25),
      sources: sort(sources),
      events: events.map((e) => ({ k: e.d[0], n: e.m[0] })),
      // The App Store's own event for a press on "Install" on the listing.
      installClicks: events.find((e) => /add app button/i.test(e.d[0]))?.m[0] || 0,
      siteViews: site[0]?.m[0] || 0,
      siteVisitors: site[0]?.m[1] || 0,
    };
    reportCache.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    return { connected: true, error: String(err?.message || err).slice(0, 200) };
  }
}
