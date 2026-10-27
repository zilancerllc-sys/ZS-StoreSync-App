// app/lib/app-store-reviews.server.js
// Who reviewed the app. Shopify gives apps no reviews API, and a review on the
// App Store shows only the store's name, so the public reviews page is read and
// each review is matched to one of our stores by that name (or by its
// myshopify handle). A match sets StoreMeta.reviewedAt to the review's date; a
// mark the owner set by hand is never changed. Reviews that match no store come
// back so the owner dashboard can name them.
// Cross-shop -- callers MUST have passed requireOwnerShop() first.
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];
const DATE_RE = /([A-Z][a-z]+) (\d{1,2}), (\d{4})/g;
const NAME_RE = /<span[^>]*title="([^"]*)">[^<]*<\/span>\s*<button[\s\S]*?data-review-id="(\d+)"/g;

const decode = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");
// "FRONTIER¹" and "Frontier 1" are the same store; so are "Pawzena" and "pawzena".
const norm = (s) => String(s || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");

function parseDate(m) {
  const month = MONTHS.indexOf(m[1].toLowerCase());
  return month < 0 ? null : new Date(Date.UTC(Number(m[3]), month, Number(m[2])));
}

// Every review on the listing, newest first: { id, name, date }.
export async function fetchReviews(handle) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 30; page++) {
    const res = await fetch(`https://apps.shopify.com/${handle}/reviews?sort_by=newest&page=${page}`, {
      headers: { "user-agent": "Mozilla/5.0 (owner dashboard)", "accept-language": "en-US" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) break;
    const html = await res.text();
    let added = 0;
    let last = 0;
    for (const m of html.matchAll(NAME_RE)) {
      if (seen.has(m[2])) continue;
      seen.add(m[2]);
      // The review's own date is the last one printed before its store name.
      let date = null;
      for (const d of html.slice(last, m.index).matchAll(DATE_RE)) date = parseDate(d) || date;
      last = m.index + m[0].length;
      out.push({ id: m[2], name: decode(m[1]).trim(), date });
      added++;
    }
    if (!added) break;
  }
  return out;
}

// Installed stores we have no name for yet: ask Shopify, keep it in StoreMeta.
async function fillStoreNames(shops) {
  for (let i = 0; i < shops.length; i += 4) {
    await Promise.all(shops.slice(i, i + 4).map(async (shop) => {
      try {
        const { admin } = await unauthenticated.admin(shop);
        const name = (await (await admin.graphql(`{ shop { name } }`)).json())?.data?.shop?.name;
        if (name) {
          await prisma.storeMeta.upsert({ where: { shop }, update: { storeName: name }, create: { shop, storeName: name } });
        }
      } catch {
        // Closed, frozen or uninstalled: "Check stores" says which. Match by handle only.
      }
    }));
  }
}

export async function syncReviews(handle) {
  const reviews = await fetchReviews(handle);
  if (!reviews.length) return { reviews: 0, matched: [], unmatched: [] };

  const [metas, sessions, contacts, eventShops] = await Promise.all([
    prisma.storeMeta.findMany(),
    prisma.session.findMany({ where: { isOnline: false }, select: { shop: true } }),
    prisma.merchantContact.findMany({ select: { shop: true } }),
    prisma.appEvent.groupBy({ by: ["shop"] }),
  ]);
  const metaOf = Object.fromEntries(metas.map((m) => [m.shop, m]));
  const installed = [...new Set(sessions.map((s) => s.shop))];
  const unnamed = installed.filter((shop) => !metaOf[shop]?.storeName);
  if (unnamed.length) {
    await fillStoreNames(unnamed);
    for (const m of await prisma.storeMeta.findMany({ where: { shop: { in: unnamed } } })) metaOf[m.shop] = m;
  }

  const shops = [...new Set([...Object.keys(metaOf), ...installed,
    ...contacts.map((c) => c.shop), ...eventShops.map((e) => e.shop)])];
  const findShop = (name) => {
    const n = norm(name);
    if (!n) return null;
    const byName = shops.find((shop) => norm(metaOf[shop]?.storeName) === n);
    if (byName) return byName;
    // A myshopify handle is the first store name plus, at times, a suffix:
    // "vuursfeerhaard" -> vuursfeerhaard-nl.myshopify.com.
    return shops.find((shop) => {
      const h = norm(shop.replace(/\.myshopify\.com$/, ""));
      return h === n || (n.length >= 5 && h.startsWith(n));
    }) || null;
  };

  const matched = [];
  const unmatched = [];
  for (const r of reviews) {
    const shop = findShop(r.name);
    if (!shop) {
      unmatched.push({ name: r.name, date: r.date?.toISOString() || null });
      continue;
    }
    matched.push({ name: r.name, shop });
    if (!metaOf[shop]?.reviewedAt) {
      const reviewedAt = r.date || new Date();
      await prisma.storeMeta.upsert({ where: { shop }, update: { reviewedAt }, create: { shop, reviewedAt } });
      metaOf[shop] = { ...(metaOf[shop] || { shop }), reviewedAt };
    }
  }
  return { reviews: reviews.length, matched, unmatched };
}

// The dashboard reads the listing at most every 30 minutes; "Check stores"
// forces a fresh read. A failed read keeps the last good answer.
const EVERY_MS = 30 * 60 * 1000;
const cache = new Map();
export async function syncReviewsCached(handle, { force = false } = {}) {
  const hit = cache.get(handle);
  if (!force && hit && Date.now() - hit.at < EVERY_MS) return hit.result;
  try {
    const result = await syncReviews(handle);
    cache.set(handle, { at: Date.now(), result });
    return result;
  } catch (err) {
    console.error("[reviews] sync failed:", err?.message || err);
    return hit?.result || null;
  }
}
