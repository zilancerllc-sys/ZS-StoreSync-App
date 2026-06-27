import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getConnectionCode,
  regenerateConnectionCode,
} from "../connection.server";
import { brandStyles } from "./zs-styles.js";
import {
  KeyRound,
  Copy,
  Check,
  RefreshCw,
  ShieldCheck,
  Info,
  Loader2,
} from "lucide-react";

// ─── Loader ──────────────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const code = await getConnectionCode(session.shop);
  return { shop: session.shop, code };
};

// ─── Action: regenerate code ──────────────────────────────────────────────────
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "regenerate") {
    const code = await regenerateConnectionCode(session.shop);
    return { ok: true, code };
  }
  return { ok: false };
};

const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');
  .zs-root{--zs-font-display:"Fraunces",serif;--zs-font-body:"Hanken Grotesk",sans-serif;--zs-r-sm:10px;--zs-r-md:14px;--zs-r-lg:20px;--zs-shadow-sm:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);--zs-shadow-clay:0 10px 30px rgba(169,139,118,.28);font-family:var(--zs-font-body);color:var(--zs-dark);}
  .zs-section-wrap{width:100vw;position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;padding:1.5rem;box-sizing:border-box;}
  .zs-wrap{max-width:760px;margin:0 auto;}
  .zs-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:6px;}
  .zs-title{font-family:var(--zs-font-display);font-size:22px;font-weight:600;margin:0 0 4px;}
  .zs-sub{font-size:13px;color:var(--zs-muted);margin:0 0 20px;line-height:1.5;}
  .zs-card{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:1.8rem;box-shadow:var(--zs-shadow-sm);}
  .zs-card-head{display:flex;align-items:center;gap:11px;margin-bottom:8px;}
  .zs-card-head .ico{width:44px;height:44px;border-radius:12px;background:var(--zs-clay-soft);color:var(--zs-clay-deep);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .zs-card-head h3{font-family:var(--zs-font-display);font-size:18px;font-weight:600;margin:0;}
  .zs-card-head p{font-size:12.5px;color:var(--zs-muted);margin:2px 0 0;}
  .zs-code-box{display:flex;align-items:center;gap:12px;margin-top:20px;background:var(--zs-dark);border-radius:var(--zs-r-md);padding:20px 24px;}
  .zs-code{font-family:var(--zs-font-display);font-size:34px;font-weight:600;letter-spacing:4px;color:#fff;flex:1;}
  .zs-copy{background:var(--zs-clay);color:#fff;border:none;padding:11px 18px;border-radius:var(--zs-r-sm);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:7px;box-shadow:var(--zs-shadow-clay);transition:transform .15s,background .15s;}
  .zs-copy:hover{transform:translateY(-2px);background:var(--zs-clay-deep);}
  .zs-copy.done{background:var(--zs-sage-deep);}
  .zs-note{display:flex;gap:10px;align-items:flex-start;background:var(--zs-cream-tint);border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);padding:13px 15px;font-size:13px;color:var(--zs-clay-deep);line-height:1.55;margin-top:18px;}
  .zs-note svg{flex-shrink:0;margin-top:2px;}
  .zs-steps{margin:18px 0 0;padding:0;list-style:none;counter-reset:s;}
  .zs-steps li{position:relative;padding:0 0 14px 38px;counter-increment:s;font-size:13.5px;color:var(--zs-dark-2);line-height:1.5;}
  .zs-steps li::before{content:counter(s);position:absolute;left:0;top:-2px;width:26px;height:26px;border-radius:50%;background:var(--zs-clay-soft);color:var(--zs-clay-deep);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;}
  .zs-regen{margin-top:22px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:18px;border-top:1px solid var(--zs-border);flex-wrap:wrap;}
  .zs-regen-txt{font-size:12.5px;color:var(--zs-muted);max-width:420px;line-height:1.5;}
  .zs-regen-btn{background:var(--zs-cream-soft);color:var(--zs-clay-deep);border:1px solid var(--zs-border);padding:9px 16px;border-radius:var(--zs-r-sm);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:7px;transition:background .15s;}
  .zs-regen-btn:hover{background:var(--zs-clay-soft);}
  .zs-spin{animation:zsRot 1s linear infinite;}@keyframes zsRot{to{transform:rotate(360deg);}}
  @keyframes zsFadeUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
  .zs-reveal{animation:zsFadeUp .5s ease forwards;}
`;

export default function Settings() {
  const { shop, code: initialCode } = useLoaderData();
  const fetcher = useFetcher();
  const [copied, setCopied] = useState(false);

  const code = fetcher.data?.code || initialCode;
  const regenerating = fetcher.state !== "idle";

  const copy = () => {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <s-page heading="Settings">
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap zs-reveal">
            <div className="zs-eyebrow">Settings</div>
            <h2 className="zs-title">Store Connection Code</h2>
            <p className="zs-sub">
              This code lets you securely connect <b>{shop}</b> as a source
              store when migrating into another store you own.
            </p>

            <div className="zs-card">
              <div className="zs-card-head">
                <div className="ico">
                  <KeyRound size={22} />
                </div>
                <div>
                  <h3>Your connection code</h3>
                  <p>
                    Keep it private — anyone with this code can connect this
                    store as a source.
                  </p>
                </div>
              </div>

              <div className="zs-code-box">
                <span className="zs-code">{code}</span>
                <button
                  className={`zs-copy ${copied ? "done" : ""}`}
                  onClick={copy}
                >
                  {copied ? (
                    <>
                      <Check size={15} /> Copied
                    </>
                  ) : (
                    <>
                      <Copy size={15} /> Copy
                    </>
                  )}
                </button>
              </div>

              <div className="zs-note">
                <ShieldCheck size={16} />
                <span>
                  For your security, ZS StoreSync will only pull data from this
                  store if the person connecting it provides this exact code.
                  Only share it with stores you control.
                </span>
              </div>

              <ol className="zs-steps">
                <li>
                  Open ZS StoreSync on the store you want to migrate <b>into</b>
                  .
                </li>
                <li>
                  Go to <b>New Migration</b> and enter this store's domain.
                </li>
                <li>
                  When asked, paste this connection code to authorize the
                  transfer.
                </li>
              </ol>

              <fetcher.Form method="post" className="zs-regen">
                <input type="hidden" name="intent" value="regenerate" />
                <span className="zs-regen-txt">
                  Regenerating creates a new code and immediately revokes the
                  old one. Any store using the old code will need the new one.
                </span>
                <button className="zs-regen-btn" disabled={regenerating}>
                  {regenerating ? (
                    <>
                      <Loader2 size={14} className="zs-spin" /> Generating…
                    </>
                  ) : (
                    <>
                      <RefreshCw size={14} /> Regenerate code
                    </>
                  )}
                </button>
              </fetcher.Form>
            </div>

            <div className="zs-note" style={{ marginTop: 16 }}>
              <Info size={16} />
              <span>
                Tip: The store you migrate <b>into</b> doesn't need a code —
                only the
                <b> source</b> store (the one being copied from) requires it.
              </span>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
