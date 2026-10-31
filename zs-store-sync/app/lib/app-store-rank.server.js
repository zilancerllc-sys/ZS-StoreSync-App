// app/lib/app-store-rank.server.js
// Where the app stands on the Shopify App Store, measured once a day: its
// position for each tracked search keyword, its position in each of its own
// categories, and the rating / review count of the app and its competitors.
//
// The App Store has no API for this, so the public pages are read, the same
// way the reviews are (lib/app-store-reviews.server.js):
//   search:   /search?q=…&page=N   (results arrive in the "search_page" turbo
//             frame, so that frame is asked for directly; 24 apps a page)
//   category: /categories/<slug>/all?page=N   (24 apps a page)
//   listing:  /<handle>   (rating and review count in its JSON-LD)
// Requests go one at a time with a pause between them; a whole run is a few
// hundred requests at most, once a day. The App Store answers a burst with 429
// (too many requests): then the read waits and tries again, and after a few
// refusals the run stops; whatever is still unread today is picked up by the
// next hourly look, so a day fills in over a few hours instead of failing.
// If Shopify changes the page markup the
// parsers find nothing and the day is stored as "not found", never as a guess.
//
// Each day's numbers are one AppStoreRank row per (day, kind, key), so a run
// that is repeated the same day overwrites rather than duplicates. The tracked
// keywords and competitors are AppStoreRankTarget rows the owner edits on the
// dashboard. Cross-shop data: callers MUST have passed requireOwnerShop().
import prisma from "../db.server";

const BASE = "https://apps.shopify.com";
const HEADERS = { "user-agent": "Mozilla/5.0 (owner dashboard rank check)", "accept-language": "en-US" };
const SEARCH_PAGES = 5; // positions 1-120; below that counts as "not in the top 120"
const CATEGORY_PAGES = 30; // categories can hold 500+ apps
const PAUSE_MS = 5000; // between requests, plus up to 3s of jitter
const MAX_429 = 4; // refusals in one run before it stops for the hour
const RUN_EVERY_MS = 60 * 60 * 1000; // hourly; each look reads only what today still lacks

const g = global;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(PAUSE_MS + Math.random() * 3000);
const today = () => new Date().toISOString().slice(0, 10);
const decode = (s) => String(s || "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

class RateLimited extends Error {}

async function getHtml(url, frame) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: frame ? { ...HEADERS, "turbo-frame": frame } : HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      g.zsRank429 = (g.zsRank429 || 0) + 1;
      if (g.zsRank429 >= MAX_429 || attempt >= 1) throw new RateLimited(`429 from ${url}`);
      const wait = Math.min(Number(res.headers.get("retry-after")) || 60, 180);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} from ${url}`);
    return res.text();
  }
}

// The app cards on a search or category page, in order. Each card is one
// `data-controller="app-card"` element carrying the handle and name, followed
// by its rating and "N total reviews". Paid placements are left out: their
// link says surface_type=search_ad (or anything but the page's own type).
const CARD_RE = /data-app-card-handle-value="([a-z0-9-]+)"\s+data-app-card-name-value="([^"]*)"[\s\S]*?data-app-card-app-link-value="([^"]*)"/g;
function parseCards(html, surface) {
  const out = [];
  const seen = new Set();
  const matches = [...html.matchAll(CARD_RE)];
  matches.forEach((m, i) => {
    const link = decode(m[3]);
    const type = /surface_type=([a-z_]+)/.exec(link)?.[1];
    if (type && type !== surface) return;
    if (seen.has(m[1])) return;
    seen.add(m[1]);
    const chunk = html.slice(m.index, matches[i + 1]?.index ?? m.index + 6000);
    const rating = /([0-5]\.\d)\s*<span class="tw-sr-only"> out of 5 stars/.exec(chunk)?.[1];
    const reviews = /(\d+) total reviews/.exec(chunk)?.[1];
    out.push({ handle: m[1], name: decode(m[2]).trim(), rating: rating ? Number(rating) : null, reviews: reviews ? Number(reviews) : 0 });
  });
  return out;
}

// Position of `handle` for one search keyword, and the apps above everyone.
export async function keywordRank(handle, keyword) {
  let pos = 0;
  let top = [];
  for (let page = 1; page <= SEARCH_PAGES; page++) {
    const html = await getHtml(`${BASE}/search?q=${encodeURIComponent(keyword)}&page=${page}`, "search_page");
    const cards = parseCards(html, "search");
    if (page === 1) top = cards.slice(0, 10);
    const i = cards.findIndex((c) => c.handle === handle);
    if (i >= 0) return { position: pos + i + 1, top };
    // Only an empty page is the end: a full page can still parse to fewer than
    // 24 (an ad left out, an odd card), which must not stop the count early.
    if (!cards.length) break;
    pos += cards.length;
    await pause();
  }
  return { position: null, top };
}

// Position of `handle` in a category, and how many apps the category holds.
export async function categoryRank(handle, slug) {
  let pos = 0;
  let total = null;
  let label = null;
  for (let page = 1; page <= CATEGORY_PAGES; page++) {
    const html = await getHtml(`${BASE}/categories/${slug}/all?page=${page}`);
    if (page === 1) {
      const t = /([\d,]+) apps/.exec(html)?.[1];
      total = t ? Number(t.replace(/,/g, "")) : null;
      // "Best Product bundles Apps For 2026 - Shopify App Store"
      label = decode(/<title>Best (.+?) Apps For/.exec(html)?.[1] || "") || null;
    }
    const cards = parseCards(html, "category");
    const i = cards.findIndex((c) => c.handle === handle);
    if (i >= 0) return { position: pos + i + 1, total, label };
    // Only an empty page is the end: a full page can still parse to fewer than
    // 24 (an ad left out, an odd card), which must not stop the count early.
    if (!cards.length) break;
    pos += cards.length;
    await pause();
  }
  return { position: null, total, label };
}

// A listing's name, rating and review count, and (for our own listing) the
// categories it is in: the "/categories/<slug>/all" links on the page.
export async function listingInfo(handle) {
  const html = await getHtml(`${BASE}/${handle}`);
  const rating = /"ratingValue":"?([\d.]+)/.exec(html)?.[1];
  const reviews = /"ratingCount":"?(\d+)/.exec(html)?.[1];
  const name = /<title>([^<]*?)(?: \| Shopify App Store)?<\/title>/.exec(html)?.[1];
  const categories = [...new Set([...html.matchAll(/apps\.shopify\.com\/categories\/([a-z0-9-]+)\/all/g)].map((m) => m[1]))];
  return {
    name: name ? decode(name).replace(/ - .*$/, "").trim() : handle,
    rating: rating ? Number(rating) : null,
    reviews: reviews ? Number(reviews) : 0,
    categories,
  };
}

async function save(day, kind, key, data) {
  const row = {
    position: data.position ?? null,
    total: data.total ?? null,
    rating: data.rating ?? null,
    reviews: data.reviews ?? null,
    label: data.label ?? null,
    top: data.top ? JSON.stringify(data.top) : null,
  };
  await prisma.appStoreRank.upsert({
    where: { day_kind_key: { day, kind, key } },
    update: row,
    create: { day, kind, key, ...row },
  });
}

export async function getTargets(defaults) {
  const rows = await prisma.appStoreRankTarget.findMany({ orderBy: { createdAt: "asc" } });
  if (!rows.length && defaults) {
    // First use: start from the app's own list.
    const seed = [
      ...defaults.keywords.map((key) => ({ kind: "keyword", key })),
      ...defaults.competitors.map((key) => ({ kind: "competitor", key })),
    ];
    for (const t of seed) await prisma.appStoreRankTarget.create({ data: t }).catch(() => {});
    return seed;
  }
  return rows.map((r) => ({ kind: r.kind, key: r.key }));
}

export async function addTarget(kind, key) {
  if (kind !== "keyword" && kind !== "competitor") return { ok: false, message: "Unknown list." };
  const k = kind === "competitor"
    ? String(key || "").trim().toLowerCase().replace(/^https?:\/\/apps\.shopify\.com\//, "").replace(/[?#/].*$/, "")
    : String(key || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!k || k.length > 80) return { ok: false, message: "Type a keyword (or an app handle) first." };
  if (kind === "competitor" && !/^[a-z0-9-]+$/.test(k)) return { ok: false, message: "Use the app's handle, the part after apps.shopify.com/." };
  const n = await prisma.appStoreRankTarget.count({ where: { kind } });
  if (n >= (kind === "keyword" ? 40 : 10)) return { ok: false, message: `That is the most ${kind}s the daily check reads.` };
  await prisma.appStoreRankTarget.upsert({ where: { kind_key: { kind, key: k } }, update: {}, create: { kind, key: k } });
  return { ok: true, message: `${kind === "keyword" ? "Keyword" : "Competitor"} "${k}" added. Press Check now, or it is read in tomorrow's run.` };
}

export async function removeTarget(kind, key) {
  await prisma.appStoreRankTarget.deleteMany({ where: { kind, key } });
  return { ok: true, message: `"${key}" is no longer tracked. Its history stays.` };
}

// One run: our listing (rating, reviews, categories), each category, each
// keyword, each competitor -- skipping whatever already has a row for today,
// unless `full` (the dashboard's Check now). A failed read stores nothing for
// that key, so the dashboard keeps the last good day instead of a false drop;
// repeated 429s end the run and the next hourly look carries on.
export async function runRankCheck(handle, defaults, { full = false } = {}) {
  if (g.zsRankRunning) return { ok: false, message: "A rank check is already running." };
  g.zsRankRunning = true;
  g.zsRank429 = 0;
  const day = today();
  const failed = [];
  let read = 0;
  try {
    const targets = await getTargets(defaults);
    const done = new Set(full ? [] : (await prisma.appStoreRank.findMany({ where: { day }, select: { kind: true, key: true } })).map((r) => `${r.kind}|${r.key}`));
    // Categories come from our listing; on a resumed day, from today's rows.
    let categories = (await prisma.appStoreRank.findMany({ where: { kind: "category" }, distinct: ["key"], select: { key: true } })).map((r) => r.key);
    const work = [
      ["app", handle, async () => {
        const own = await listingInfo(handle);
        if (own.categories.length) categories = own.categories;
        return own;
      }],
      // Expanded when reached, so categories just found on the listing are used.
      ["categories", null, null],
      ...targets.filter((x) => x.kind === "keyword").map((t) => ["keyword", t.key, () => keywordRank(handle, t.key)]),
      ...targets.filter((x) => x.kind === "competitor").map((t) => ["app", t.key, async () => {
        const r = await listingInfo(t.key);
        return { rating: r.rating, reviews: r.reviews, label: r.name };
      }]),
    ];
    for (let i = 0; i < work.length; i++) {
      const [kind, key, fn] = work[i];
      if (kind === "categories") {
        work.splice(i + 1, 0, ...categories.map((slug) => ["category", slug, async () => {
          const r = await categoryRank(handle, slug);
          return { ...r, label: r.label || slug };
        }]));
        continue;
      }
      if (done.has(`${kind}|${key}`)) continue;
      if (read++) await pause();
      try {
        await save(day, kind, key, await fn());
      } catch (e) {
        failed.push(`${key}: ${e.message}`);
        if (e instanceof RateLimited) break;
      }
    }
    const limited = failed.some((f) => f.includes("429"));
    if (failed.length) console.error("[rank check]", failed.join(" | "));
    else if (read) console.log(`[rank check] ${read} reads done`);
    return {
      ok: true,
      message: limited
        ? "The App Store asked us to slow down; the rest is read over the next hours."
        : failed.length ? `Rank check done, ${failed.length} reads failed (kept the last good day for those).` : "Rank check done.",
    };
  } finally {
    g.zsRankRunning = false;
  }
}

// Every hour, in the background: reads only what today still lacks, so once
// the day is complete a look costs one database query. The first look waits
// a random 5-35 minutes so a deploy's boot isn't slowed and our apps (which
// may share outbound addresses) don't all read the App Store at once.
export function startRankTicker(handle, defaults) {
  if (g.zsRankTicker) return;
  const tick = () => runRankCheck(handle, defaults).catch((e) => console.error("[rank check] tick failed:", e?.message || e));
  setTimeout(() => {
    tick();
    g.zsRankTicker = setInterval(tick, RUN_EVERY_MS);
    g.zsRankTicker.unref?.();
  }, (5 + Math.random() * 30) * 60 * 1000).unref?.();
  g.zsRankTicker = true;
}

// What the dashboard shows: for every tracked key, today's (latest) value, the
// value a day and a week before it, and the last 30 days for a sparkline.
export async function loadRanks(handle, defaults) {
  const targets = await getTargets(defaults);
  const since = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
  const rows = await prisma.appStoreRank.findMany({ where: { day: { gte: since } }, orderBy: { day: "asc" } });
  const by = new Map();
  for (const r of rows) {
    const k = `${r.kind}|${r.key}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const series = (kind, key) => by.get(`${kind}|${key}`) || [];
  const before = (list, days) => {
    const last = list[list.length - 1];
    if (!last) return null;
    const cut = new Date(Date.parse(last.day) - days * 86400000).toISOString().slice(0, 10);
    return [...list].reverse().find((r) => r.day <= cut) || null;
  };
  const summarize = (kind, key) => {
    const list = series(kind, key);
    const last = list[list.length - 1] || null;
    const top = last?.top ? JSON.parse(last.top) : [];
    return {
      key,
      label: last?.label || null,
      day: last?.day || null,
      position: last?.position ?? null,
      total: last?.total ?? null,
      rating: last?.rating ?? null,
      reviews: last?.reviews ?? null,
      dayAgo: before(list, 1)?.position ?? null,
      weekAgo: before(list, 7)?.position ?? null,
      reviewsWeekAgo: before(list, 7)?.reviews ?? null,
      history: list.map((r) => ({ day: r.day, position: r.position })),
      // How hard the keyword is: the review counts of the first 10 apps.
      // A page led by apps with thousands of reviews is hard to break into.
      topReviews: top.length ? Math.round(top.reduce((s, a) => s + (a.reviews || 0), 0) / top.length) : null,
      top: top.slice(0, 3).map((a) => ({ handle: a.handle, name: a.name, reviews: a.reviews })),
    };
  };
  const appRow = summarize("app", handle);
  const categorySlugs = [...new Set(rows.filter((r) => r.kind === "category").map((r) => r.key))];
  const lastRun = rows.filter((r) => r.kind === "app" && r.key === handle).pop()?.updatedAt || null;
  return {
    handle,
    lastRun,
    running: !!g.zsRankRunning,
    app: appRow,
    categories: categorySlugs.map((s) => summarize("category", s)),
    keywords: targets.filter((t) => t.kind === "keyword").map((t) => summarize("keyword", t.key)),
    competitors: targets.filter((t) => t.kind === "competitor").map((t) => summarize("app", t.key)),
  };
}
