/* eslint-disable react/prop-types */
// Where the merchant is stuck, on every admin page, with the one action that
// fixes it (see lib/setup-status.server.js for the checks). Hidden when all is
// well; says so once in green after a blocker clears.
//
// The first answer comes with the layout loader. Re-checks go through
// /app/setup-status on every page change and when the merchant comes back to
// the tab (from the source store's admin, say): the layout loader itself does
// not re-run, because only the admin's first load carries its language.
//
// Also a short welcome on the very first visit to the Dashboard.
import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useLocation } from "react-router";
import { useLocale, useT } from "../i18n";
import { downloadFile } from "../lib/download";

const WAS_BLOCKED = "zsss-setup-was-blocked";
const WELCOME_DONE = "zsss-welcome-done";
const DISMISS = "zsss-dismiss-"; // + code + id: a run result the merchant has seen

// The page that already walks the merchant through this step.
const OWN_PAGE = {
  code_unused: ["/app/start"],
  no_source: ["/app", "/app/start"],
  pair_revoked: ["/app/start"],
  source_gone: ["/app/start"],
  no_run: ["/app/migrate"],
};

function store(key, value) {
  try {
    if (value === undefined) return window.localStorage.getItem(key);
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked: still works for this page view */
  }
  return null;
}

const dismissKey = (s) =>
  s.code === "run_failed" || s.code === "run_partial"
    ? `${DISMISS}${s.code}-${s.jobId}`
    : s.code === "limit_reached"
      ? `${DISMISS}${s.code}-${s.type}-${s.resetsAt}`
      : null;

const CSS = `
.zsss-ss{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:12px 16px 0;padding:12px 16px;border-radius:12px;font-size:14px;line-height:1.45;font-family:inherit}
.zsss-ss.red{background:#fdecec;border:1px solid #f3b4b4;color:#7a1f1f}
.zsss-ss.amber{background:#fff6e5;border:1px solid #f0d199;color:#6b4a0d}
.zsss-ss.green{background:#e8f6ee;border:1px solid #a9dcbd;color:#14532d}
.zsss-ss-i{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;flex:none}
.zsss-ss.red .zsss-ss-i{background:#b42318}.zsss-ss.amber .zsss-ss-i{background:#b7791f}.zsss-ss.green .zsss-ss-i{background:#1f9e6a}
.zsss-ss-t{flex:1 1 300px;min-width:0;word-break:break-word}
.zsss-ss-t b{display:block;margin-bottom:2px}
.zsss-ss-a{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.zsss-ss-btn{display:inline-flex;align-items:center;background:#1a1a1a;color:#fff !important;text-decoration:none;font-weight:700;font-size:13.5px;padding:8px 14px;border-radius:9px;border:0;cursor:pointer;white-space:nowrap;font-family:inherit}
.zsss-ss.red .zsss-ss-btn{background:#b42318}.zsss-ss.amber .zsss-ss-btn{background:#8a5a12}
.zsss-ss-btn.ghost{background:transparent !important;color:inherit !important;border:1.5px solid currentColor}
.zsss-ss-x{background:none;border:0;color:inherit;font-size:20px;line-height:1;cursor:pointer;opacity:.6;padding:2px 6px}
.zsss-wl-back{position:fixed;inset:0;z-index:1000;background:rgba(20,20,20,.45);display:flex;align-items:center;justify-content:center;padding:16px}
.zsss-wl{background:#fff;border-radius:18px;max-width:560px;width:100%;padding:26px 28px;box-shadow:0 30px 80px rgba(0,0,0,.25);color:#1a1a1a;font-family:inherit}
.zsss-wl h2{margin:0 0 6px;font-size:22px}
.zsss-wl p{margin:0 0 14px;color:#555;font-size:14.5px;line-height:1.55}
.zsss-wl ol{margin:0 0 18px;padding-left:20px;display:grid;gap:8px;font-size:14.5px;line-height:1.5}
.zsss-wl-f{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}
`;

export default function SetupStatus({ status: first }) {
  const t = useT();
  const locale = useLocale();
  const { pathname } = useLocation();
  const path = pathname.replace(/\/+$/, "") || "/app";
  const fetcher = useFetcher();
  const status = fetcher.data && "status" in fetcher.data ? fetcher.data.status : first;

  const [mounted, setMounted] = useState(false);
  const [fixed, setFixed] = useState(false);
  const [welcome, setWelcome] = useState(false);
  const [, setTick] = useState(0); // re-render after a dismiss

  useEffect(() => setMounted(true), []);

  // Re-check on every page change (not the first render: the loader just answered).
  const seenPath = useRef(path);
  const load = fetcher.load;
  const idle = fetcher.state === "idle";
  useEffect(() => {
    if (seenPath.current === path) return;
    seenPath.current = path;
    load("/app/setup-status");
  }, [path, load]);

  // ...and when the merchant comes back to this tab.
  useEffect(() => {
    const on = () => {
      if (document.visibilityState === "visible" && idle) load("/app/setup-status");
    };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => {
      document.removeEventListener("visibilitychange", on);
      window.removeEventListener("focus", on);
    };
  }, [idle, load]);

  const blocked = !!status && status.code !== "ok";
  useEffect(() => {
    if (!status) return;
    if (blocked) store(WAS_BLOCKED, "1");
    else if (store(WAS_BLOCKED) === "1") {
      store(WAS_BLOCKED, null);
      setFixed(true);
    }
  }, [status, blocked]);

  useEffect(() => {
    if (path === "/app" && status?.fresh && store(WELCOME_DONE) !== "1") setWelcome(true);
  }, [path, status]);

  if (!mounted) return null;

  const closeWelcome = () => {
    store(WELCOME_DONE, "1");
    setWelcome(false);
  };
  const dKey = status ? dismissKey(status) : null;
  const dismissed = dKey && store(dKey) === "1";
  const dismiss = () => {
    store(dKey, "1");
    setTick((n) => n + 1);
  };
  const report = () =>
    downloadFile(`/app/job-report.csv?id=${encodeURIComponent(status.jobId)}`, "zs-storesync-report.csv").catch(
      (e) => window.shopify?.toast?.show?.(e.message, { isError: true }),
    );

  let copy = null;
  let actions = null;
  const shop = status?.sourceShop || "";
  switch (blocked ? status.code : null) {
    case "code_unused":
      copy = {
        tone: "amber",
        title: t("No store has used this store's connection code yet."),
        text: t("Copying FROM this store? Install ZS StoreSync on the store you copy TO, open Get Started there and paste the code shown in Settings here. Copying INTO this store? Connect the other store in Get Started."),
      };
      actions = (
        <>
          <Link className="zsss-ss-btn" to="/app/settings">{t("See connection code")}</Link>
          <Link className="zsss-ss-btn ghost" to="/app/start">{t("Get Started")}</Link>
        </>
      );
      break;
    case "no_source":
      copy = {
        tone: "amber",
        title: t("No store is connected yet, so there is nothing to copy."),
        text: t("Connect the store you're copying from in three short steps. Our team can also set it up for you free."),
      };
      actions = <Link className="zsss-ss-btn" to="/app/start">{t("Connect a store")}</Link>;
      break;
    case "pair_revoked":
      copy = {
        tone: "red",
        title: t("The pairing with {shop} no longer works.", { shop }),
        text: t("That store's connection code was changed. Copy the new code from ZS StoreSync → Settings on {shop} and connect again.", { shop }),
      };
      actions = <Link className="zsss-ss-btn" to="/app/start">{t("Connect again")}</Link>;
      break;
    case "source_gone":
      copy = {
        tone: "red",
        title: t("ZS StoreSync is no longer installed on {shop}, so its data can't be read.", { shop }),
        text: t("Install the app on that store again, then connect it here."),
      };
      actions = <Link className="zsss-ss-btn" to="/app/start">{t("Reconnect")}</Link>;
      break;
    case "no_run":
      copy = {
        tone: "amber",
        title: t("{shop} is connected, but nothing has been copied yet.", { shop }),
        text: t("Preview first if you like, then start your first migration."),
      };
      actions = (
        <>
          <Link className="zsss-ss-btn" to="/app/migrate">{t("Start a migration")}</Link>
          <Link className="zsss-ss-btn ghost" to="/app/preview">{t("Preview first")}</Link>
        </>
      );
      break;
    case "run_failed":
      copy = {
        tone: "red",
        title: t("Your last migration from {shop} failed.", { shop }),
        text: status.error ? t(status.error) : t("Open History to see what happened, then run it again."),
      };
      actions = <Link className="zsss-ss-btn" to="/app/history">{t("Open History")}</Link>;
      break;
    case "limit_reached":
      copy = {
        tone: "red",
        title: t("You have reached this month's limit for {type}: {n} on the {plan}.", {
          type: t(status.typeLabel),
          n: Number(status.limit).toLocaleString(locale),
          plan: t(status.planLabel),
        }),
        text: t("It resets on {date}. A bigger plan copies more right away.", {
          date: new Date(status.resetsAt).toLocaleDateString(locale, { month: "short", day: "numeric" }),
        }),
      };
      actions = <Link className="zsss-ss-btn" to="/app/plan">{t("See plans")}</Link>;
      break;
    case "run_partial":
      copy = {
        tone: "amber",
        title: t("Your last migration from {shop} finished, but {n} items failed.", { shop, n: status.failed }),
        text: status.parts?.length
          ? t("Failed: {list}. The report lists each item and why.", {
              list: status.parts.map((p) => `${t(p.label)} (${p.failed})`).join(", "),
            })
          : t("The report lists each item and why."),
      };
      actions = (
        <>
          <button type="button" className="zsss-ss-btn" onClick={report}>{t("Download report")}</button>
          <Link className="zsss-ss-btn ghost" to="/app/history">{t("Open History")}</Link>
        </>
      );
      break;
    case "schedule_paused":
      copy = {
        tone: "red",
        title: t("Your automatic sync from {shop} is paused.", { shop }),
        text: status.reason ? t(status.reason) : "",
      };
      actions = <Link className="zsss-ss-btn" to="/app/sync">{t("Open Sync")}</Link>;
      break;
    default:
      break;
  }

  const hereAlready = blocked && (OWN_PAGE[status.code] || []).includes(path);
  const show = copy && !hereAlready && !dismissed && !welcome;

  return (
    <>
      <style>{CSS}</style>
      {fixed && (
        <div className="zsss-ss green" role="status">
          <div className="zsss-ss-i">✓</div>
          <div className="zsss-ss-t"><b>{t("All set: nothing is blocking your migrations now.")}</b></div>
          <button type="button" className="zsss-ss-x" aria-label={t("Close")} onClick={() => setFixed(false)}>×</button>
        </div>
      )}
      {show && (
        <div className={`zsss-ss ${copy.tone}`} role="alert">
          <div className="zsss-ss-i">!</div>
          <div className="zsss-ss-t"><b>{copy.title}</b>{copy.text}</div>
          <div className="zsss-ss-a">
            {actions}
            {dKey && <button type="button" className="zsss-ss-x" aria-label={t("Close")} onClick={dismiss}>×</button>}
          </div>
        </div>
      )}
      {welcome && (
        <div className="zsss-wl-back" role="dialog" aria-modal="true" aria-labelledby="zsss-wl-t">
          <div className="zsss-wl">
            <h2 id="zsss-wl-t">{t("Welcome to ZS StoreSync")}</h2>
            <p>{t("ZS StoreSync copies data from one of your Shopify stores into another. Three steps:")}</p>
            <ol>
              <li>{t("Install ZS StoreSync on both stores.")}</li>
              <li>{t("On the store you copy FROM, open Settings and copy its connection code.")}</li>
              <li>{t("On the store you copy TO, open Get Started and paste the code. Then pick what to copy and start.")}</li>
            </ol>
            <p>{t("Stuck anywhere? A bar at the top of every page tells you what is missing and how to fix it. Our team can also set it up for you free.")}</p>
            <div className="zsss-wl-f">
              <button type="button" className="zsss-ss-btn ghost" onClick={closeWelcome}>{t("Close")}</button>
              <Link className="zsss-ss-btn" to="/app/start" onClick={closeWelcome}>{t("Get started")}</Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
