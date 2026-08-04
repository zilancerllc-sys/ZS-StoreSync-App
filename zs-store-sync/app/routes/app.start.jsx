import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, Link as RouterLink } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { verifyConnectionCode } from "../connection.server";
import { brandStyles } from "./zs-styles.js";
import {
  ArrowLeftRight,
  Check,
  ExternalLink,
  KeyRound,
  Loader2,
  RotateCw,
  Store,
  AlertCircle,
} from "lucide-react";

const APP_HANDLE = "zs-storesync";

// Deep link straight to a page of this app on another store the merchant owns.
// The source store's code lives in its own copy of the app, and having to find
// that by hand is exactly where first-time setup stalls.
function adminAppUrl(shopDomain, path) {
  const handle = String(shopDomain || "").replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${handle}/apps/${APP_HANDLE}${path}`;
}

function normalizeDomain(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

// ─── Loader ──────────────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const connections = await db.storeConnection.findMany({
    where: { ownerShop: shop },
    orderBy: { createdAt: "desc" },
  });
  const ready = connections.filter((c) => c.codeVerified && c.authorized);
  const jobCount = await db.migrationJob.count({ where: { shop } });

  return {
    shop,
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
  const sourceShop = normalizeDomain(form.get("sourceShop"));

  if (!sourceShop || !sourceShop.includes(".")) {
    return { ok: false, error: "Enter the full domain, like my-store.myshopify.com" };
  }
  if (sourceShop === shop) {
    return {
      ok: false,
      error: "That's this store. Enter the OTHER store — the one you're copying from.",
    };
  }

  // ── Is the app installed on the source store yet? ──────────────────────────
  if (intent === "check") {
    const srcSession = await db.session.findFirst({
      where: { shop: sourceShop, isOnline: false },
    });
    return {
      ok: true,
      step: "check",
      sourceShop,
      installed: !!srcSession?.accessToken,
      installUrl: `/auth/login?shop=${encodeURIComponent(sourceShop)}`,
      settingsUrl: adminAppUrl(sourceShop, "/app/settings"),
    };
  }

  // ── Pair the two stores with the source's connection code ─────────────────
  if (intent === "connect") {
    const code = String(form.get("code") || "").trim();
    if (!code) return { ok: false, error: "Paste the connection code from the source store." };

    const codeOk = await verifyConnectionCode(sourceShop, code);
    if (!codeOk) {
      return {
        ok: false,
        error:
          "That code doesn't match this store. Open ZS StoreSync → Settings on the source store and copy the code shown there.",
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
        error: "The code is right, but the app isn't installed on that store yet. Do step 2 first.",
      };
    }
    return { ok: true, step: "connected", sourceShop };
  }

  return { ok: false, error: "Unknown action." };
};

const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');
  .zs-root{--zs-font-display:"Fraunces",serif;--zs-font-body:"Hanken Grotesk",sans-serif;--zs-r-sm:10px;--zs-r-md:14px;--zs-r-lg:20px;--zs-shadow-sm:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);--zs-shadow-clay:0 10px 30px rgba(169,139,118,.28);font-family:var(--zs-font-body);color:var(--zs-dark);}
  .zs-section-wrap{width:100vw;position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;padding:1.5rem;box-sizing:border-box;}
  .zs-wrap{max-width:760px;margin:0 auto;}
  .zs-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:6px;}
  .zs-title{font-family:var(--zs-font-display);font-size:24px;font-weight:600;margin:0 0 6px;}
  .zs-sub{font-size:13.5px;color:var(--zs-muted);margin:0 0 22px;line-height:1.6;}

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
  .zs-step h3{font-size:15px;font-weight:600;margin:3px 0 4px;color:var(--zs-dark);}
  .zs-step.idle h3{color:var(--zs-muted);}
  .zs-step p{font-size:13px;color:var(--zs-muted);margin:0 0 12px;line-height:1.6;}

  .zs-row{display:flex;gap:9px;flex-wrap:wrap;align-items:center;}
  .zs-input{flex:1;min-width:210px;padding:11px 13px;border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);font-size:14px;font-family:inherit;color:var(--zs-dark);background:var(--zs-cream-soft);outline:none;}
  .zs-input:focus{border-color:var(--zs-clay);}
  .zs-input.code{text-transform:uppercase;letter-spacing:2px;font-weight:700;max-width:230px;}
  .zs-btn{background:var(--zs-clay);color:#fff;border:none;padding:11px 18px;border-radius:var(--zs-r-sm);font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:7px;box-shadow:var(--zs-shadow-clay);text-decoration:none;}
  .zs-btn:disabled{opacity:.5;cursor:not-allowed;}
  .zs-btn.ghost{background:var(--zs-cream-soft);color:var(--zs-clay-deep);border:1px solid var(--zs-border);box-shadow:none;}
  .zs-ok{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--zs-sage-deep);}
  .zs-err{display:flex;gap:8px;align-items:flex-start;background:#fbeaea;color:#9a3412;border:1px solid #f3d2d2;padding:11px 13px;border-radius:var(--zs-r-sm);font-size:12.5px;margin-top:10px;line-height:1.5;}
  .zs-hint{font-size:12px;color:var(--zs-muted);margin-top:9px;line-height:1.55;}
  .zs-spin{animation:zsRot 1s linear infinite;}@keyframes zsRot{to{transform:rotate(360deg);}}
  .zs-done-card{background:var(--zs-sage-soft);border:1px solid var(--zs-sage-deep);border-radius:var(--zs-r-md);padding:18px;margin-top:20px;}
  .zs-done-card h3{font-family:var(--zs-font-display);font-size:17px;margin:0 0 5px;color:var(--zs-sage-deep);}
  .zs-done-card p{font-size:13px;color:var(--zs-sage-deep);margin:0 0 13px;}
  @keyframes zsFadeUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
  .zs-reveal{animation:zsFadeUp .5s ease forwards;}
`;

export default function Start() {
  const { shop, readySources, hasMigrated } = useLoaderData();
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
  const doneSource = connected?.sourceShop || readySources[0] || null;

  // Re-checking after the merchant installs on the source store is the one
  // thing they will do outside this tab, so keep the field in sync.
  useEffect(() => {
    if (checked?.sourceShop) setSource(checked.sourceShop);
  }, [checked?.sourceShop]);

  const step2Done = !!checked?.installed;
  const step3Done = !!connected || alreadyDone;

  const stepClass = (done, active) =>
    `zs-step ${done ? "done" : active ? "active" : "idle"}`;

  return (
    <s-page heading="Get started">
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap zs-reveal">
            <div className="zs-eyebrow">Setup</div>
            <h2 className="zs-title">
              {step3Done ? "You're connected" : "Set up your first migration"}
            </h2>
            <p className="zs-sub">
              ZS StoreSync copies data <b>into</b> the store you are looking at
              right now, from another store you own. Both stores need the app,
              and the store you copy <b>from</b> has to hand over a short code —
              that is what stops anyone else pulling its data.
            </p>

            <div className="zs-dir">
              <div className="box">
                <div className="lbl">Copy from (source)</div>
                <div className={`val ${doneSource || source ? "" : "empty"}`}>
                  {doneSource || source || "not chosen yet"}
                </div>
              </div>
              <ArrowLeftRight size={20} className="arrow" />
              <div className="box">
                <div className="lbl">Into (this store)</div>
                <div className="val">{shop}</div>
              </div>
            </div>

            {/* ── Step 1: name the source ───────────────────────────────── */}
            <div className={stepClass(!!checked, !checked)}>
              <div className="zs-num">{checked ? <Check size={15} /> : 1}</div>
              <div className="zs-step-body">
                <h3>Which store are you copying from?</h3>
                <p>
                  Enter the other store&apos;s domain. Not this one —{" "}
                  <b>{shop}</b> is where the data will land.
                </p>
                <checkFetcher.Form method="post" className="zs-row">
                  <input type="hidden" name="intent" value="check" />
                  <input
                    className="zs-input"
                    name="sourceShop"
                    placeholder="my-old-store.myshopify.com"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    aria-label="Source store domain"
                  />
                  <button className="zs-btn" disabled={checking || !source.trim()}>
                    {checking ? (
                      <>
                        <Loader2 size={15} className="zs-spin" /> Checking…
                      </>
                    ) : (
                      <>
                        <Store size={15} /> Continue
                      </>
                    )}
                  </button>
                </checkFetcher.Form>
                {checkFetcher.data?.error && (
                  <div className="zs-err">
                    <AlertCircle size={15} /> {checkFetcher.data.error}
                  </div>
                )}
              </div>
            </div>

            {/* ── Step 2: install on the source ─────────────────────────── */}
            <div className={stepClass(step2Done, !!checked && !step2Done)}>
              <div className="zs-num">{step2Done ? <Check size={15} /> : 2}</div>
              <div className="zs-step-body">
                <h3>Install ZS StoreSync on that store</h3>
                {!checked ? (
                  <p>Finish step 1 first.</p>
                ) : step2Done ? (
                  <div className="zs-ok">
                    <Check size={16} /> Installed on {checked.sourceShop}
                  </div>
                ) : (
                  <>
                    <p>
                      The app isn&apos;t on <b>{checked.sourceShop}</b> yet. Install
                      it there, then come back and re-check.
                    </p>
                    <div className="zs-row">
                      <a className="zs-btn" href={checked.installUrl} target="_blank" rel="noreferrer">
                        <ExternalLink size={15} /> Install on source store
                      </a>
                      <checkFetcher.Form method="post">
                        <input type="hidden" name="intent" value="check" />
                        <input type="hidden" name="sourceShop" value={checked.sourceShop} />
                        <button className="zs-btn ghost" disabled={checking}>
                          <RotateCw size={14} /> I&apos;ve installed it
                        </button>
                      </checkFetcher.Form>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ── Step 3: code ─────────────────────────────────────────── */}
            <div className={stepClass(step3Done, step2Done && !step3Done)}>
              <div className="zs-num">{step3Done ? <Check size={15} /> : 3}</div>
              <div className="zs-step-body">
                <h3>Copy the code from the source store</h3>
                {!step2Done ? (
                  <p>Finish step 2 first.</p>
                ) : step3Done ? (
                  <div className="zs-ok">
                    <Check size={16} /> {doneSource} is paired with this store
                  </div>
                ) : (
                  <>
                    <p>
                      Open ZS StoreSync on <b>{checked.sourceShop}</b>, go to
                      Settings, and copy the code shown there. The link below
                      takes you straight to it.
                    </p>
                    <div className="zs-row" style={{ marginBottom: 12 }}>
                      <a className="zs-btn ghost" href={checked.settingsUrl} target="_blank" rel="noreferrer">
                        <ExternalLink size={15} /> Open Settings on {checked.sourceShop}
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
                        aria-label="Connection code from the source store"
                      />
                      <button className="zs-btn" disabled={connecting || !code.trim()}>
                        {connecting ? (
                          <>
                            <Loader2 size={15} className="zs-spin" /> Pairing…
                          </>
                        ) : (
                          <>
                            <KeyRound size={15} /> Pair stores
                          </>
                        )}
                      </button>
                    </connectFetcher.Form>
                    <div className="zs-hint">
                      Typing it out is fine — spaces and dashes don&apos;t matter.
                    </div>
                    {connectFetcher.data?.error && (
                      <div className="zs-err">
                        <AlertCircle size={15} /> {connectFetcher.data.error}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {step3Done && (
              <div className="zs-done-card">
                <h3>Ready to migrate</h3>
                <p>
                  {doneSource} is paired with {shop}. Pick what to copy and run
                  it — anything that already exists is skipped, so you can run it
                  as many times as you like.
                </p>
                <RouterLink className="zs-btn" to="/app/migrate">
                  <ArrowLeftRight size={15} />
                  {hasMigrated ? "Go to New Migration" : "Run my first migration"}
                </RouterLink>
              </div>
            )}
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
