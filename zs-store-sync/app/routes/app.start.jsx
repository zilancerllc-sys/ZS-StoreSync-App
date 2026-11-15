import { useState, useEffect } from "react";
import {
  useLoaderData,
  useFetcher,
  useRevalidator,
  Link as RouterLink,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  codeAttemptBlockedFor,
  getConnectionCode,
  isShopDomain,
  listConnections,
  listPullingStores,
  recordCodeFailure,
  verifyConnectionCode,
} from "../connection.server";
import { logAppEvent } from "../lib/app-events.server";
import { toShopDomain } from "../lib/shop-domain";
import { copyText } from "../lib/copy-text";
import { brandStyles } from "./zs-styles.js";
import { useT } from "../i18n";
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  Loader2,
  RotateCw,
  Store,
  AlertCircle,
  Upload,
  ShieldCheck,
} from "lucide-react";

const APP_HANDLE = "zs-storesync";
const LISTING_URL = "https://apps.shopify.com/zs-storesync";

// Deep link straight to a page of this app on another store the merchant owns.
// The source store's code lives in its own copy of the app, and having to find
// that by hand is exactly where first-time setup stalls.
function adminAppUrl(shopDomain, path) {
  const handle = String(shopDomain || "").replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${handle}/apps/${APP_HANDLE}${path}`;
}

// The page re-reads itself whenever the merchant comes back to the tab, so log
// a side choice once an hour per store instead of on every revalidation.
const choiceLogged = new Map();
function logChoice(shop, role) {
  const key = `${shop}:${role}`;
  const last = choiceLogged.get(key) || 0;
  if (Date.now() - last < 60 * 60 * 1000) return;
  choiceLogged.set(key, Date.now());
  if (choiceLogged.size > 5000) choiceLogged.clear();
  logAppEvent(shop, "setup", `chose copy ${role}`);
}

// ─── Loader ──────────────────────────────────────────────────────────────────
// Setup is one question first: is THIS store the one with the data (copy
// FROM) or the one receiving it (copy INTO)? Both stores run the same app and
// the old page only ever asked the INTO question, so a merchant who opened it
// on the store with their products had no way to tell what to do there.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const asked = new URL(request.url).searchParams.get("role");

  const [connections, pulling, jobCount] = await Promise.all([
    listConnections(shop),
    listPullingStores(shop),
    db.migrationJob.count({ where: { shop } }),
  ]);
  const ready = connections.filter((c) => c.codeVerified && c.authorized);

  // No choice made: pick the side this store already plays, else ask.
  const role =
    asked === "from" || asked === "to"
      ? asked
      : ready.length
        ? "to"
        : pulling.length
          ? "from"
          : null;

  // The code is created only once the merchant says this is the store with
  // the data — the setup bar reads "code shown, never used" off its existence.
  const code = role === "from" ? await getConnectionCode(shop) : null;
  if (asked === role && role) logChoice(shop, role);

  return {
    shop,
    role,
    code,
    pulling: pulling.map((p) => p.ownerShop),
    readySources: ready.map((c) => c.sourceShop),
    // A merchant who has already run a migration doesn't need the walkthrough;
    // the page still works, it just doesn't pretend they're new.
    hasMigrated: jobCount > 0,
  };
};

// ─── Action ──────────────────────────────────────────────────────────────────
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");
  const raw = String(form.get("sourceShop") || "").trim();
  const sourceShop = toShopDomain(raw);

  if (!isShopDomain(sourceShop)) {
    return {
      ok: false,
      error: raw.includes(".")
        ? "That looks like a custom domain. Use the store's .myshopify.com address: open ZS StoreSync on that store, choose “Copy FROM this store”, and copy the address shown there."
        : "Enter the other store's address, like my-store.myshopify.com",
    };
  }
  if (sourceShop === shop) {
    return {
      ok: false,
      error:
        "That's this store. Enter the OTHER store, the one that has the data. If this store has the data, choose “Copy FROM this store” instead.",
    };
  }

  // ── Is the app installed on the source store yet? ──────────────────────────
  if (intent === "check") {
    const srcSession = await db.session.findFirst({
      where: { shop: sourceShop, isOnline: false },
    });
    const installed = !!srcSession?.accessToken;
    logAppEvent(shop, "setup", `checked source: ${installed ? "installed" : "not installed"}`);
    return {
      ok: true,
      step: "check",
      sourceShop,
      installed,
      // /auth/login sends the merchant to that store's own install screen.
      installUrl: `/auth/login?shop=${encodeURIComponent(sourceShop)}`,
      codeUrl: adminAppUrl(sourceShop, "/app/start?role=from"),
    };
  }

  // ── Pair the two stores with the source's connection code ─────────────────
  if (intent === "connect") {
    const code = String(form.get("code") || "").trim();
    if (!code) return { ok: false, error: "Paste the connection code from the other store." };

    const waitMin = codeAttemptBlockedFor(shop, sourceShop);
    if (waitMin) {
      return {
        ok: false,
        error: "Too many incorrect codes. Wait 15 minutes, then try again.",
      };
    }

    const codeOk = await verifyConnectionCode(sourceShop, code);
    if (!codeOk) {
      recordCodeFailure(shop, sourceShop);
      logAppEvent(shop, "setup", "wrong code");
      return {
        ok: false,
        wrongCode: true,
        error:
          "That code doesn't match {shop}. Open ZS StoreSync on {shop}, choose “Copy FROM this store”, and copy the code shown there. If the code was changed in Settings, use the new one.",
        errorShop: sourceShop,
      };
    }

    const srcSession = await db.session.findFirst({
      where: { shop: sourceShop, isOnline: false },
    });
    const authorized = !!srcSession?.accessToken;

    await db.storeConnection.upsert({
      where: { ownerShop_sourceShop: { ownerShop: shop, sourceShop } },
      update: { authorized, codeVerified: true },
      create: { ownerShop: shop, sourceShop, authorized, codeVerified: true },
    });

    if (!authorized) {
      return {
        ok: false,
        error: "The code is right, but ZS StoreSync isn't installed on that store any more. Install it there, then pair again.",
      };
    }
    logAppEvent(shop, "setup", `paired with ${sourceShop}`);
    return { ok: true, step: "connected", sourceShop };
  }

  return { ok: false, error: "Unknown action." };
};

const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');
  .zs-root{--zs-font-display:"Fraunces",serif;--zs-font-body:"Hanken Grotesk",sans-serif;--zs-r-sm:10px;--zs-r-md:14px;--zs-r-lg:20px;--zs-shadow-sm:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);--zs-shadow-clay:0 10px 30px rgba(169,139,118,.28);font-family:var(--zs-font-body);color:var(--zs-dark);}
  .zs-section-wrap{width:100vw;position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;padding:1.5rem;box-sizing:border-box;}
  .zs-wrap{max-width:780px;margin:0 auto;}
  .zs-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:6px;}
  .zs-title{font-family:var(--zs-font-display);font-size:26px;font-weight:600;margin:0 0 6px;}
  .zs-sub{font-size:14px;color:var(--zs-dark-2);margin:0 0 22px;line-height:1.6;}

  .zs-roles{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;}
  .zs-role{display:block;text-decoration:none;color:inherit;background:var(--zs-white);border:2px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:20px;box-shadow:var(--zs-shadow-sm);transition:border-color .15s,transform .15s;}
  .zs-role:hover{border-color:var(--zs-clay);transform:translateY(-2px);}
  .zs-role .ico{width:44px;height:44px;border-radius:12px;background:var(--zs-clay-soft);color:var(--zs-clay-deep);display:flex;align-items:center;justify-content:center;margin-bottom:12px;}
  .zs-role h3{font-family:var(--zs-font-display);font-size:19px;font-weight:600;margin:0 0 6px;}
  .zs-role p{font-size:13.5px;color:var(--zs-dark-2);margin:0 0 14px;line-height:1.55;}
  .zs-role .go{display:inline-flex;align-items:center;gap:6px;font-weight:700;font-size:13.5px;color:var(--zs-clay-deep);}
  .zs-help{font-size:13px;color:var(--zs-muted);line-height:1.6;}

  .zs-dir{display:flex;align-items:center;gap:14px;background:var(--zs-cream-tint);border:1px solid var(--zs-border);border-radius:var(--zs-r-md);padding:14px 16px;margin-bottom:22px;flex-wrap:wrap;}
  .zs-dir .box{flex:1;min-width:170px;}
  .zs-dir .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--zs-muted);font-weight:700;margin-bottom:3px;}
  .zs-dir .val{font-size:13.5px;font-weight:600;color:var(--zs-dark);word-break:break-all;}
  .zs-dir .val.empty{color:var(--zs-muted);font-weight:400;font-style:italic;}
  .zs-dir .arrow{color:var(--zs-clay);flex-shrink:0;}

  .zs-step{display:flex;gap:14px;padding:18px 0;border-top:1px solid var(--zs-border);}
  .zs-step:first-of-type{border-top:none;padding-top:4px;}
  .zs-num{width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;background:var(--zs-cream-soft);color:var(--zs-muted);border:1px solid var(--zs-border);}
  .zs-step.active .zs-num{background:var(--zs-clay);color:#fff;border-color:var(--zs-clay);}
  .zs-step.done .zs-num{background:var(--zs-sage-soft);color:var(--zs-sage-deep);border-color:var(--zs-sage-deep);}
  .zs-step-body{flex:1;min-width:0;}
  .zs-step h3{font-size:15.5px;font-weight:700;margin:3px 0 4px;color:var(--zs-dark);}
  .zs-step.idle h3{color:var(--zs-muted);}
  .zs-step p{font-size:13.5px;color:var(--zs-dark-2);margin:0 0 12px;line-height:1.6;}
  .zs-step.idle p{color:var(--zs-muted);}

  .zs-row{display:flex;gap:9px;flex-wrap:wrap;align-items:center;}
  .zs-input{flex:1;min-width:210px;padding:11px 13px;border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);font-size:14px;font-family:inherit;color:var(--zs-dark);background:var(--zs-cream-soft);outline:none;}
  .zs-input:focus{border-color:var(--zs-clay);}
  .zs-input::placeholder{color:#c4b6a4;font-weight:400;}
  .zs-input.code{text-transform:uppercase;letter-spacing:3px;font-weight:700;font-size:18px;max-width:240px;}
  .zs-btn{background:var(--zs-clay);color:#fff;border:none;padding:11px 18px;border-radius:var(--zs-r-sm);font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:7px;box-shadow:var(--zs-shadow-clay);text-decoration:none;}
  .zs-btn:disabled{opacity:.5;cursor:not-allowed;}
  .zs-btn.ghost{background:var(--zs-cream-soft);color:var(--zs-clay-deep);border:1px solid var(--zs-border);box-shadow:none;}
  .zs-btn.done{background:var(--zs-sage-deep);}
  .zs-link{background:none;border:0;padding:0;color:var(--zs-clay-deep);font-weight:600;font-size:13px;cursor:pointer;text-decoration:underline;font-family:inherit;}
  .zs-ok{display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:600;color:var(--zs-sage-deep);}
  .zs-err{display:flex;gap:8px;align-items:flex-start;background:#fbeaea;color:#9a3412;border:1px solid #f3d2d2;padding:11px 13px;border-radius:var(--zs-r-sm);font-size:13px;margin-top:10px;line-height:1.5;}
  .zs-err svg{flex-shrink:0;margin-top:2px;}
  .zs-hint{font-size:12.5px;color:var(--zs-muted);margin-top:9px;line-height:1.55;}
  .zs-spin{animation:zsRot 1s linear infinite;}@keyframes zsRot{to{transform:rotate(360deg);}}

  .zs-code-box{display:flex;align-items:center;gap:14px;background:var(--zs-dark);border-radius:var(--zs-r-md);padding:18px 22px;flex-wrap:wrap;}
  .zs-code-box .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:rgba(255,255,255,.55);font-weight:700;margin-bottom:4px;}
  .zs-code{font-family:var(--zs-font-display);font-size:38px;font-weight:600;letter-spacing:5px;color:#fff;line-height:1.1;}
  .zs-code-box .grow{flex:1;min-width:200px;}
  .zs-domain{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px;background:var(--zs-cream-soft);border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);padding:10px 12px;font-size:14px;}
  .zs-domain b{word-break:break-all;flex:1;min-width:180px;}
  .zs-note{display:flex;gap:9px;align-items:flex-start;background:var(--zs-cream-tint);border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);padding:11px 13px;font-size:12.5px;color:var(--zs-clay-deep);line-height:1.55;margin-top:12px;}
  .zs-note svg{flex-shrink:0;margin-top:2px;}
  .zs-wait{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--zs-cream-soft);border:1px dashed var(--zs-camel);border-radius:var(--zs-r-md);padding:14px 16px;font-size:13.5px;color:var(--zs-dark-2);margin-top:20px;}
  .zs-done-card{background:var(--zs-sage-soft);border:1px solid var(--zs-sage-deep);border-radius:var(--zs-r-md);padding:18px;margin-top:20px;}
  .zs-done-card h3{font-family:var(--zs-font-display);font-size:18px;margin:0 0 5px;color:var(--zs-sage-deep);}
  .zs-done-card p{font-size:13.5px;color:var(--zs-sage-deep);margin:0 0 13px;line-height:1.55;}
  .zs-done-card ul{margin:0 0 12px;padding-left:18px;font-size:13.5px;color:var(--zs-sage-deep);}
  .zs-switch{margin-top:24px;padding-top:14px;border-top:1px solid var(--zs-border);font-size:13px;color:var(--zs-muted);}
  @keyframes zsFadeUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
  .zs-reveal{animation:zsFadeUp .5s ease forwards;}
  @media(max-width:640px){.zs-roles{grid-template-columns:1fr;}.zs-code{font-size:30px;letter-spacing:3px;}}
`;

// A button that copies a value and says so only when the copy really worked.
function CopyButton({ value, label, ghost }) {
  const t = useT();
  const [state, setState] = useState("idle"); // idle | ok | fail
  const onClick = async () => {
    const ok = await copyText(value);
    setState(ok ? "ok" : "fail");
    setTimeout(() => setState("idle"), 2200);
  };
  return (
    <button
      type="button"
      className={`zs-btn ${ghost ? "ghost" : ""} ${state === "ok" ? "done" : ""}`}
      onClick={onClick}
    >
      {state === "ok" ? <Check size={15} /> : <Copy size={15} />}
      {state === "ok"
        ? t("Copied")
        : state === "fail"
          ? t("Select it and copy by hand")
          : label}
    </button>
  );
}

// Re-read the page when the merchant comes back to this tab — they finish the
// other half of setup in the other store's admin.
function useRefreshOnReturn() {
  const revalidator = useRevalidator();
  useEffect(() => {
    const on = () => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [revalidator]);
  return revalidator;
}

// ─── Which store is this? ────────────────────────────────────────────────────
function ChooseRole({ shop }) {
  const t = useT();
  return (
    <>
      <div className="zs-eyebrow">{t("Setup · about 2 minutes")}</div>
      <h2 className="zs-title">{t("Which store is this?")}</h2>
      <p className="zs-sub">
        {t("ZS StoreSync copies data from one of your stores into another. Install it on both stores, then tell it which side {shop} is on.", {
          shop: <b>{shop}</b>,
        })}
      </p>
      <div className="zs-roles">
        <RouterLink className="zs-role" to="/app/start?role=from">
          <div className="ico"><Upload size={22} /></div>
          <h3>{t("Copy FROM this store")}</h3>
          <p>{t("This store already has the products, pages and other data. You'll get a code to give to the other store.")}</p>
          <span className="go">{t("This store has the data")} <ArrowRight size={15} /></span>
        </RouterLink>
        <RouterLink className="zs-role" to="/app/start?role=to">
          <div className="ico"><Download size={22} /></div>
          <h3>{t("Copy INTO this store")}</h3>
          <p>{t("This is the new or second store that should receive the data. You'll enter the other store's address and code.")}</p>
          <span className="go">{t("This store receives the data")} <ArrowRight size={15} /></span>
        </RouterLink>
      </div>
      <p className="zs-help">
        {t("Not sure? Choose “Copy FROM” on the store that has your products today, and “Copy INTO” on the store you are filling. Migrations are always started from the store you copy INTO.")}
      </p>
    </>
  );
}

// ─── This store is the source ────────────────────────────────────────────────
function FromStore({ shop, code, pulling }) {
  const t = useT();
  const revalidator = useRefreshOnReturn();
  const checking = revalidator.state !== "idle";

  return (
    <>
      <div className="zs-eyebrow">{t("Setup · copy FROM this store")}</div>
      <h2 className="zs-title">
        {pulling.length ? t("This store is connected") : t("Give this code to the other store")}
      </h2>
      <p className="zs-sub">
        {t("{shop} is the store with the data. Nothing is copied from here until the other store enters this code, and nothing in this store is changed.", {
          shop: <b>{shop}</b>,
        })}
      </p>

      <div className="zs-dir">
        <div className="box">
          <div className="lbl">{t("Copy from (this store)")}</div>
          <div className="val">{shop}</div>
        </div>
        <ArrowRight size={20} className="arrow" />
        <div className="box">
          <div className="lbl">{t("Into")}</div>
          <div className={`val ${pulling.length ? "" : "empty"}`}>
            {pulling.length ? pulling.join(", ") : t("the other store (not connected yet)")}
          </div>
        </div>
      </div>

      <div className="zs-step active">
        <div className="zs-num">1</div>
        <div className="zs-step-body">
          <h3>{t("Install ZS StoreSync on the store you copy INTO")}</h3>
          <p>{t("Already installed there? Skip to step 2. If not, log in to that store and install it from the Shopify App Store.")}</p>
          <div className="zs-row">
            <a className="zs-btn ghost" href={LISTING_URL} target="_blank" rel="noreferrer">
              <ExternalLink size={15} /> {t("Open ZS StoreSync on the App Store")}
            </a>
          </div>
          <div className="zs-hint">
            {t("Copies count against the plan of the store you copy INTO. This store can stay on the Free plan.")}
          </div>
        </div>
      </div>

      <div className="zs-step active">
        <div className="zs-num">2</div>
        <div className="zs-step-body">
          <h3>{t("Copy these two things")}</h3>
          <div className="zs-code-box">
            <div className="grow">
              <div className="lbl">{t("Connection code")}</div>
              <div className="zs-code">{code}</div>
            </div>
            <CopyButton value={code} label={t("Copy code")} />
          </div>
          <div className="zs-domain">
            <span>{t("This store's address:")}</span>
            <b>{shop}</b>
            <CopyButton value={shop} label={t("Copy address")} ghost />
          </div>
          <div className="zs-note">
            <ShieldCheck size={15} />
            <span>
              {t("Anyone with this code can copy this store's data into their store, so only use it on stores you own. You can change it any time in Settings, which disconnects every store that used the old one.")}
            </span>
          </div>
        </div>
      </div>

      <div className="zs-step active">
        <div className="zs-num">3</div>
        <div className="zs-step-body">
          <h3>{t("Paste them in the other store")}</h3>
          <p>
            {t("In the store you copy INTO, open ZS StoreSync → Get Started → “Copy INTO this store”. Paste the address and the code. You then pick what to copy and start it from that store.")}
          </p>
        </div>
      </div>

      {pulling.length ? (
        <div className="zs-done-card">
          <h3>{t("Connected")}</h3>
          <p>{t("These stores can copy from {shop}. Start migrations and syncs from inside each of them:", { shop })}</p>
          <ul>
            {pulling.map((p) => (
              <li key={p}>
                <a href={adminAppUrl(p, "/app/migrate")} target="_blank" rel="noreferrer">{p}</a>
              </li>
            ))}
          </ul>
          <RouterLink className="zs-btn ghost" to="/app/settings">{t("Manage connected stores")}</RouterLink>
        </div>
      ) : (
        <div className="zs-wait" role="status">
          {checking ? <Loader2 size={16} className="zs-spin" /> : <RotateCw size={16} />}
          <span style={{ flex: 1 }}>
            {t("Waiting for the other store to enter the code. This page checks again when you come back to this tab.")}
          </span>
          <button type="button" className="zs-btn ghost" onClick={() => revalidator.revalidate()} disabled={checking}>
            {t("Check now")}
          </button>
        </div>
      )}

      <div className="zs-switch">
        {t("Wrong side? This store should receive the data:")}{" "}
        <RouterLink to="/app/start?role=to">{t("switch to “Copy INTO this store”")}</RouterLink>
      </div>
    </>
  );
}

// ─── This store is the target ────────────────────────────────────────────────
function IntoStore({ shop, readySources, hasMigrated }) {
  const t = useT();
  const checkFetcher = useFetcher();
  const connectFetcher = useFetcher();

  const [source, setSource] = useState("");
  const [code, setCode] = useState("");

  const checked = checkFetcher.data?.ok ? checkFetcher.data : null;
  const connected = connectFetcher.data?.ok ? connectFetcher.data : null;
  const checking = checkFetcher.state !== "idle";
  const connecting = connectFetcher.state !== "idle";

  // A source paired on an earlier visit means setup is already done.
  const alreadyDone = readySources.length > 0;
  const doneSource = connected?.sourceShop || (!checked && readySources[0]) || null;

  useEffect(() => {
    if (checked?.sourceShop) setSource(checked.sourceShop);
  }, [checked?.sourceShop]);

  // Once they start checking a NEW source, that store's own progress wins.
  const step1Done = !!checked || alreadyDone;
  const step2Done = checked ? !!checked.installed : alreadyDone;
  const step3Done = !!connected || (alreadyDone && !checked);

  const stepClass = (done, active) =>
    `zs-step ${done ? "done" : active ? "active" : "idle"}`;

  const cErr = connectFetcher.data && !connectFetcher.data.ok ? connectFetcher.data : null;

  return (
    <>
      <div className="zs-eyebrow">{t("Setup · copy INTO this store")}</div>
      <h2 className="zs-title">
        {step3Done ? t("You're connected") : t("Connect the store that has the data")}
      </h2>
      <p className="zs-sub">
        {t("Data is copied {into} {shop}, the store you're in now, {from} the other store. That store hands over a short code, which is what stops anyone else copying its data.", {
          into: <b>{t("into")}</b>,
          from: <b>{t("from")}</b>,
          shop: <b>{shop}</b>,
        })}
      </p>

      <div className="zs-dir">
        <div className="box">
          <div className="lbl">{t("Copy from")}</div>
          <div className={`val ${doneSource || checked?.sourceShop ? "" : "empty"}`}>
            {doneSource || checked?.sourceShop || t("not chosen yet")}
          </div>
        </div>
        <ArrowRight size={20} className="arrow" />
        <div className="box">
          <div className="lbl">{t("Into (this store)")}</div>
          <div className="val">{shop}</div>
        </div>
      </div>

      {/* ── Step 1: name the source ───────────────────────────────── */}
      <div className={stepClass(step1Done, !step1Done)}>
        <div className="zs-num">{step1Done ? <Check size={15} /> : 1}</div>
        <div className="zs-step-body">
          <h3>{t("Which store has the data?")}</h3>
          <p>
            {t("Paste its address. Its .myshopify.com address, its admin link, or just its store name all work. Not {shop}: that's where the data lands.", {
              shop: <b>{shop}</b>,
            })}
          </p>
          <checkFetcher.Form method="post" className="zs-row">
            <input type="hidden" name="intent" value="check" />
            <input
              className="zs-input"
              name="sourceShop"
              placeholder="my-old-store.myshopify.com"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              aria-label={t("Address of the store that has the data")}
              autoComplete="off"
            />
            <button className="zs-btn" disabled={checking || !source.trim()}>
              {checking ? (
                <>
                  <Loader2 size={15} className="zs-spin" /> {t("Checking…")}
                </>
              ) : (
                <>
                  <Store size={15} /> {alreadyDone ? t("Connect another store") : t("Continue")}
                </>
              )}
            </button>
          </checkFetcher.Form>
          <div className="zs-hint">
            {t("Where to find it: open ZS StoreSync on that store and choose “Copy FROM this store”. Its address and code are shown there with Copy buttons.")}
          </div>
          {checkFetcher.data?.error && (
            <div className="zs-err" role="alert">
              <AlertCircle size={15} /> <span>{t(checkFetcher.data.error)}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Step 2: install on the source ─────────────────────────── */}
      <div className={stepClass(step2Done, !!checked && !step2Done)}>
        <div className="zs-num">{step2Done ? <Check size={15} /> : 2}</div>
        <div className="zs-step-body">
          <h3>{t("ZS StoreSync installed on that store")}</h3>
          {step2Done ? (
            <div className="zs-ok">
              <Check size={16} />{" "}
              {t("Installed on {shop}", { shop: checked?.sourceShop || doneSource })}
            </div>
          ) : !checked ? (
            <p>{t("We check this as soon as you enter the address.")}</p>
          ) : (
            <>
              <p>
                {t("ZS StoreSync isn't installed on {shop} yet. Install it there (you need to be logged in to that store), then come back here and press “Check again”.", {
                  shop: <b>{checked.sourceShop}</b>,
                })}
              </p>
              <div className="zs-row">
                <a className="zs-btn" href={checked.installUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={15} /> {t("Install on {shop}", { shop: checked.sourceShop })}
                </a>
                <checkFetcher.Form method="post">
                  <input type="hidden" name="intent" value="check" />
                  <input type="hidden" name="sourceShop" value={checked.sourceShop} />
                  <button className="zs-btn ghost" disabled={checking}>
                    <RotateCw size={14} /> {t("Check again")}
                  </button>
                </checkFetcher.Form>
              </div>
              <div className="zs-hint">
                {t("Or install it from the {listing} while logged in to that store.", {
                  listing: (
                    <a href={LISTING_URL} target="_blank" rel="noreferrer">
                      {t("Shopify App Store")}
                    </a>
                  ),
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Step 3: code ─────────────────────────────────────────── */}
      <div className={stepClass(step3Done, step2Done && !step3Done)}>
        <div className="zs-num">{step3Done ? <Check size={15} /> : 3}</div>
        <div className="zs-step-body">
          <h3>{t("Paste the code from that store")}</h3>
          {step3Done ? (
            <div className="zs-ok">
              <Check size={16} /> {t("{shop} is paired with this store", { shop: doneSource })}
            </div>
          ) : !step2Done || !checked ? (
            <p>{t("The other store shows its code once the app is installed there.")}</p>
          ) : (
            <>
              <p>
                {t("Open ZS StoreSync on {shop} and choose “Copy FROM this store”: the code is shown in large letters with a Copy button. The button below opens that page in a new tab.", {
                  shop: <b>{checked.sourceShop}</b>,
                })}
              </p>
              <div className="zs-row" style={{ marginBottom: 12 }}>
                <a className="zs-btn ghost" href={checked.codeUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={15} /> {t("Show the code on {shop}", { shop: checked.sourceShop })}
                </a>
              </div>
              <connectFetcher.Form method="post" className="zs-row">
                <input type="hidden" name="intent" value="connect" />
                <input type="hidden" name="sourceShop" value={checked.sourceShop} />
                <input
                  className="zs-input code"
                  name="code"
                  placeholder="ZS7K-92QT"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  aria-label={t("Connection code from the other store")}
                  autoComplete="off"
                  maxLength={20}
                />
                <button className="zs-btn" disabled={connecting || !code.trim()}>
                  {connecting ? (
                    <>
                      <Loader2 size={15} className="zs-spin" /> {t("Pairing…")}
                    </>
                  ) : (
                    <>
                      <KeyRound size={15} /> {t("Pair stores")}
                    </>
                  )}
                </button>
              </connectFetcher.Form>
              <div className="zs-hint">
                {t("8 letters and numbers, like ZS7K-92QT. Spaces, dashes and small letters don't matter.")}
              </div>
              {cErr?.error && (
                <div className="zs-err" role="alert">
                  <AlertCircle size={15} />{" "}
                  <span>{t(cErr.error, cErr.errorShop ? { shop: cErr.errorShop } : undefined)}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {step3Done && (
        <div className="zs-done-card">
          <h3>{t("Ready to copy")}</h3>
          <p>
            {t("{source} is paired with {shop}. Pick what to copy and start it. Anything that already exists here is skipped, so you can run it again safely.", {
              source: doneSource,
              shop,
            })}
          </p>
          <div className="zs-row">
            <RouterLink className="zs-btn" to="/app/migrate">
              <ArrowRight size={15} />
              {hasMigrated ? t("Go to New Migration") : t("Run my first migration")}
            </RouterLink>
            <RouterLink className="zs-btn ghost" to="/app/preview">
              {t("Preview counts first")}
            </RouterLink>
          </div>
        </div>
      )}

      <div className="zs-switch">
        {t("Wrong side? This store has the data:")}{" "}
        <RouterLink to="/app/start?role=from">{t("switch to “Copy FROM this store”")}</RouterLink>
      </div>
    </>
  );
}

export default function Start() {
  const t = useT();
  const { shop, role, code, pulling, readySources, hasMigrated } = useLoaderData();

  return (
    <s-page heading={t("Get started")}>
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap zs-reveal" key={role || "choose"}>
            {role === "from" ? (
              <FromStore shop={shop} code={code} pulling={pulling} />
            ) : role === "to" ? (
              <IntoStore shop={shop} readySources={readySources} hasMigrated={hasMigrated} />
            ) : (
              <ChooseRole shop={shop} />
            )}
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
