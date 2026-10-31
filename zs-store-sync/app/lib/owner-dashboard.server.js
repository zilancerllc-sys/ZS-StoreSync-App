// app/lib/owner-dashboard.server.js
// Everything the owner dashboard (/app/stores) shows, worked out in one place.
// Reads across every shop -- callers MUST have passed requireOwnerShop() first.
//
// Sources, and what each one can and cannot tell:
//   AppEvent         installs / uninstalls / plan changes / review requests. The
//                    only record that outlives a shop's GDPR redact, so the
//                    chart and "who left" come from here.
//   MerchantContact  email and lifecycle dates while the store is installed
//                    (and for 48h after it leaves).
//   Session          stores that installed before lifecycle mail existed.
//   Subscription     the store's plan (free / starter / growth / pro).
//   StoreConnection  stores a merchant connected as a data source. A store that
//                    only ever appears as a source installed the app to be
//                    copied FROM -- shown as "source store".
//   MigrationJob     migration / sync runs and how much they copied.
//   SyncSchedule     automatic recurring syncs.
//   StoreMeta        the owner's own marks (reviewed, test store) and what
//                    Shopify said at the last "Check stores": open, development,
//                    frozen or closed. Partners leaves the last three out of its
//                    merchant count, and Shopify never tells an app about them.
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { isOwnerShop } from "./owner.server";

const DAY = 24 * 3600 * 1000;
export const PERIODS = {
  today: { label: "Today", days: 1 },
  "7d": { label: "7 days", days: 7 },
  "30d": { label: "30 days", days: 30 },
  all: { label: "All time", days: null },
};

const STUCK_AFTER_MS = 2 * DAY;

const startOfUtcDay = (t) => {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
};
const iso = (d) => (d ? new Date(d).toISOString() : null);

export async function loadOwnerDashboard(periodKey = "7d") {
  const period = PERIODS[periodKey] ? periodKey : "7d";
  const now = Date.now();
  const start = period === "all" ? 0 : startOfUtcDay(now) - (PERIODS[period].days - 1) * DAY;

  const [contacts, sessions, events, subsRows, connGroups, sourceRows, jobGroups, lastJobs, periodJobs, scheduleGroups, metas] =
    await Promise.all([
      prisma.merchantContact.findMany(),
      prisma.session.findMany({
        select: { shop: true, email: true, firstName: true, lastName: true, accountOwner: true },
      }),
      prisma.appEvent.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.subscription.findMany({ select: { shop: true, plan: true } }),
      prisma.storeConnection.groupBy({ by: ["ownerShop"], _count: { _all: true } }),
      prisma.storeConnection.findMany({ select: { sourceShop: true }, distinct: ["sourceShop"] }),
      prisma.migrationJob.groupBy({ by: ["shop", "status"], _count: { _all: true } }),
      prisma.migrationJob.groupBy({ by: ["shop"], _max: { createdAt: true } }),
      prisma.migrationJob.groupBy({
        by: ["shop"],
        where: { createdAt: { gte: new Date(start) }, mode: { notIn: ["undo", "dryrun"] }, status: { in: ["completed", "partial"] } },
        _count: { _all: true },
        _sum: { createdCount: true },
      }),
      prisma.syncSchedule.groupBy({ by: ["ownerShop"], where: { enabled: true }, _count: { _all: true } }),
      prisma.storeMeta.findMany(),
    ]);

  const contactOf = Object.fromEntries(contacts.map((c) => [c.shop, c]));
  const metaOf = Object.fromEntries(metas.map((m) => [m.shop, m]));
  const planOf = Object.fromEntries(subsRows.map((r) => [r.shop, r.plan]));
  const connOf = Object.fromEntries(connGroups.map((g) => [g.ownerShop, g._count._all]));
  const sourceSet = new Set(sourceRows.map((r) => r.sourceShop));
  const jobsOf = {};
  for (const g of jobGroups) {
    const x = (jobsOf[g.shop] ||= { total: 0, done: 0 });
    x.total += g._count._all;
    if (g.status === "completed" || g.status === "partial") x.done += g._count._all;
  }
  const lastJobOf = Object.fromEntries(lastJobs.map((g) => [g.shop, g._max.createdAt]));
  const periodOf = Object.fromEntries(periodJobs.map((g) => [g.shop, { runs: g._count._all, items: g._sum.createdCount || 0 }]));
  const schedulesOf = Object.fromEntries(scheduleGroups.map((g) => [g.ownerShop, g._count._all]));
  const sessionOf = {};
  for (const s of sessions) {
    if (!sessionOf[s.shop] || (s.accountOwner && !sessionOf[s.shop].accountOwner)) sessionOf[s.shop] = s;
  }
  const eventsOf = {};
  for (const e of events) (eventsOf[e.shop] ||= []).push(e);

  // Stores sharing the owner store's email are the owner's own stores too.
  const ownerEmails = new Set(
    contacts.filter((c) => isOwnerShop(c.shop) && c.email).map((c) => c.email.toLowerCase()),
  );

  const shops = new Set([...Object.keys(contactOf), ...Object.keys(sessionOf), ...Object.keys(eventsOf)]);
  const rows = [];
  for (const shop of shops) {
    const c = contactOf[shop];
    const s = sessionOf[shop];
    const ev = (eventsOf[shop] || []).filter((e) => e.type === "install" || e.type === "uninstall");
    const lastInOut = ev[ev.length - 1];
    const lastInstall = [...ev].reverse().find((e) => e.type === "install");
    const meta = metaOf[shop];
    const email = c?.email || s?.email || "";
    const state = meta?.storeState || null;
    const shut = state === "frozen" || state === "closed" || state === "removed" || state === "dormant";

    // Installed now? The contact knows while it exists; after a redact only the
    // log does. A store we only know from a session has never left.
    let uninstalledAt = c ? c.uninstalledAt : lastInOut?.type === "uninstall" ? lastInOut.createdAt : null;
    if (!c && !s && lastInOut?.type === "install") uninstalledAt = null;
    // No session means the app is not installed, whatever older rows say: the
    // app cannot run on a store without one, and the uninstall webhook deletes
    // it. (A missed webhook leaves Shop/contact rows claiming otherwise.)
    const installed = !uninstalledAt && !!s;
    const active = installed && !shut;
    const installedAt = lastInstall?.createdAt || c?.installedAt || null;

    const connections = connOf[shop] || 0;
    const jobs = jobsOf[shop] || { total: 0, done: 0 };
    const schedules = schedulesOf[shop] || 0;
    const isSource = sourceSet.has(shop) && !connections && !jobs.total;
    const live = jobs.done > 0 || schedules > 0;
    const plan = planOf[shop] || "free";
    const stage = installed && shut
      ? state === "frozen" ? "Frozen" : state === "removed" ? "Unreachable" : state === "dormant" ? "Dormant" : "Closed"
      : !active
      ? "Left"
      : schedules > 0
        ? "Auto-syncing"
        : jobs.done > 0
          ? "Migrated data"
          : connections > 0
            ? "Connected a store"
            : isSource
              ? "Source store"
              : "Installed";

    rows.push({
      shop,
      email,
      name: [s?.firstName, s?.lastName].filter(Boolean).join(" "),
      storeName: meta?.storeName || "",
      storePlan: meta?.storePlan || "",
      storeState: state,
      shut: installed && shut,
      isDev: state === "dev",
      installedAt: iso(installedAt),
      uninstalledAt: iso(uninstalledAt),
      active,
      stage,
      plan,
      paid: plan !== "free",
      connections,
      jobsTotal: jobs.total,
      jobsDone: jobs.done,
      schedules,
      isSource,
      periodRuns: periodOf[shop]?.runs || 0,
      periodItems: periodOf[shop]?.items || 0,
      widgetShownAt: iso(lastJobOf[shop]),
      live,
      stuck: active && !live && !isSource && !!installedAt && now - new Date(installedAt).getTime() > STUCK_AFTER_MS,
      reviewedAt: iso(meta?.reviewedAt),
      reviewAskedAt: iso(c?.reviewAskSentAt),
      canEmail: !!(c?.email && c.optedIn && !c.unsubscribedAt && !c.uninstalledAt),
      isTest:
        !!meta?.isTest ||
        isOwnerShop(shop) ||
        shop.startsWith("app-review-") ||
        (!!email && ownerEmails.has(email.toLowerCase())),
    });
  }
  rows.sort((a, b) => String(b.installedAt || "").localeCompare(String(a.installedAt || "")));

  // What Partners counts: not our own stores, not development stores.
  const real = rows.filter((r) => !r.isTest && !r.isDev);
  const realShops = new Set(real.map((r) => r.shop));
  const realEvents = events.filter((e) => realShops.has(e.shop));

  // Was a store installed at time t? Its last install/uninstall at or before t
  // decides; a store with no log at all (pre-lifecycle) was there all along.
  // "All time" starts at the first install we know of.
  const firstAt = events.length ? events[0].createdAt.getTime() : now;
  const chartStart = period === "all" ? startOfUtcDay(firstAt) : start;

  const activeAt = (t) =>
    // A store that is gone but never logged its uninstall (missed webhook) has
    // no date to stop counting it at, so it is left out of the history.
    real.filter((r) => !r.shut && (r.active || (eventsOf[r.shop] || []).some((e) => e.type === "uninstall"))).filter((r) => {
      const ev = (eventsOf[r.shop] || []).filter(
        (e) => (e.type === "install" || e.type === "uninstall") && e.createdAt.getTime() <= t,
      );
      if (ev.length) return ev[ev.length - 1].type === "install";
      return r.active && !(eventsOf[r.shop] || []).some((e) => e.type === "install");
    }).length;

  // Hourly for today, daily otherwise; each point is the count at the end of
  // its bucket (now, for the last one).
  const hourly = period === "today";
  const step = hourly ? 3600 * 1000 : DAY;
  const buckets = [];
  for (let t = chartStart; t <= now; t += step) {
    const end = Math.min(t + step - 1, now);
    const inBucket = realEvents.filter((e) => {
      const x = e.createdAt.getTime();
      return x >= t && x <= end;
    });
    buckets.push({
      at: new Date(t).toISOString(),
      merchants: activeAt(end),
      installs: inBucket.filter((e) => e.type === "install").length,
      uninstalls: inBucket.filter((e) => e.type === "uninstall").length,
    });
  }

  const inPeriod = realEvents.filter((e) => e.createdAt.getTime() >= start);
  const before = activeAt(start - 1);
  const activeNow = real.filter((r) => r.active).length;
  const activeReal = real.filter((r) => r.active);

  return {
    period,
    start: new Date(chartStart).toISOString(),
    periods: Object.entries(PERIODS).map(([key, p]) => ({ key, label: p.label })),
    stats: {
      installs: inPeriod.filter((e) => e.type === "install").length,
      uninstalls: inPeriod.filter((e) => e.type === "uninstall").length,
      reviewRequests: inPeriod.filter((e) => e.type === "review_request").length,
      runs: real.reduce((n, r) => n + r.periodRuns, 0),
      items: real.reduce((n, r) => n + r.periodItems, 0),
      active: activeNow,
      change: activeNow - before,
      changePct: before ? Math.round(((activeNow - before) / before) * 100) : null,
      paid: activeReal.filter((r) => r.paid).length,
      free: activeReal.filter((r) => !r.paid).length,
      live: activeReal.filter((r) => r.live).length,
      stuck: activeReal.filter((r) => r.stuck).length,
      shut: real.filter((r) => r.shut).length,
      dev: rows.filter((r) => r.isDev && !r.isTest).length,
      reviewed: real.filter((r) => r.reviewedAt).length,
      notReviewed: activeReal.filter((r) => !r.reviewedAt).length,
    },
    funnel: [
      { label: "Installed", n: activeReal.length },
      { label: "Connected a store", n: activeReal.filter((r) => r.connections > 0).length },
      { label: "Migrated data", n: activeReal.filter((r) => r.jobsDone > 0).length },
      { label: "Auto-sync on", n: activeReal.filter((r) => r.schedules > 0).length },
      { label: "Paid plan", n: activeReal.filter((r) => r.paid).length },
    ],
    series: { hourly, buckets },
    activity: inPeriod
      .slice()
      .reverse()
      .slice(0, 60)
      .map((e) => ({ shop: e.shop, type: e.type, detail: e.detail, at: e.createdAt.toISOString() })),
    rows,
    eventsSince: events.length ? events[0].createdAt.toISOString() : null,
    lastChecked: metas.reduce((m, x) => (x.checkedAt && (!m || x.checkedAt > m) ? x.checkedAt : m), null)?.toISOString() || null,
  };
}

// The owner's marks on a store. Upsert so a store we never noted before works.
export async function setStoreMeta(shop, data) {
  return prisma.storeMeta.upsert({
    where: { shop },
    update: data,
    create: { shop, ...data },
  });
}

// "Check stores": ask Shopify about every store our tables call installed.
// Read-only on the stores' side; the answer is kept in StoreMeta. A few at a
// time -- each check may refresh the store's token first.
const Q_SHOP = `#graphql
  { shop { name plan { displayName partnerDevelopment } } }`;

async function probe(shop) {
  try {
    const { admin } = await unauthenticated.admin(shop);
    const s = (await (await admin.graphql(Q_SHOP)).json())?.data?.shop;
    if (!s) return { storeState: "unknown" };
    return {
      storeName: s.name || null,
      storePlan: s.plan?.displayName || null,
      storeState: s.plan?.partnerDevelopment ? "dev" : "open",
    };
  } catch (err) {
    // Shopify throws a Response for HTTP failures; its status is the answer.
    // Each Shopify library version reports HTTP failures in a different place.
    const text = [
      err?.status, err?.statusCode, err?.response?.code, err?.response?.status,
      err?.response?.statusText, err?.message, err?.constructor?.name, String(err),
    ].filter((x) => x != null && x !== "" && x !== "[object Object]").join(" ");
    if (/402/.test(text)) return { storeState: "frozen" };   // not paying Shopify
    if (/423|404/.test(text)) return { storeState: "closed" };
    if (/401|403|session/i.test(text)) return { storeState: "removed" }; // token refused / gone
    // 500 from the token refresh: the store's token expired because nobody has
    // opened the app there for 90+ days. Installed on paper, dead in practice.
    if (/\b500\b/.test(text)) return { storeState: "dormant" };
    // Anything else: keep what Shopify said, so the dashboard can show it.
    const why = text.replace(/\s+/g, " ").slice(0, 120);
    return { storeState: "unknown", storePlan: why ? `error: ${why}` : null };
  }
}

export async function checkStores() {
  const sessions = await prisma.session.findMany({ where: { isOnline: false }, select: { shop: true } });
  const shops = [...new Set(sessions.map((x) => x.shop))];
  const tally = {};
  for (let i = 0; i < shops.length; i += 4) {
    await Promise.all(
      shops.slice(i, i + 4).map(async (shop) => {
        const r = await probe(shop);
        tally[r.storeState] = (tally[r.storeState] || 0) + 1;
        await setStoreMeta(shop, { ...r, checkedAt: new Date() });
      }),
    );
  }
  return { checked: shops.length, tally };
}
