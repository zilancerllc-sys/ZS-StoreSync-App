/* eslint-disable react/prop-types */
// Free setup bar at the top of every app page. One click opens WhatsApp with a
// message the merchant reviews and sends themselves (app, store, email), so
// nothing is sent on their behalf. Dismissible for 7 days: Built for Shopify
// asks that admin banners can be closed.
import { useEffect, useState } from "react";

const WHATSAPP = "8801408270201";
const HIDE_KEY = "zs_setup_bar_hidden_until";
const HIDE_DAYS = 7;

const CSS = `
.zs-sb-wrap{padding:10px 12px 2px}
.zs-sb{position:relative;overflow:hidden;display:flex;align-items:center;gap:16px;flex-wrap:wrap;
  background:linear-gradient(90deg,#0b5a2a 0%,#0e6b31 45%,#0b5a2a 100%);border:2px solid #39d353;
  border-radius:999px;padding:8px 46px 8px 22px;color:#fff;box-shadow:0 6px 18px rgba(14,107,49,.22);
  font-family:inherit;line-height:1.3}
.zs-sb::before,.zs-sb::after{content:"";position:absolute;width:90px;height:90px;border-radius:50%;
  background:radial-gradient(circle at 50% 50%,rgba(76,217,100,.45),rgba(76,217,100,0) 70%);pointer-events:none}
.zs-sb::before{left:-30px;bottom:-45px}.zs-sb::after{right:-30px;top:-45px}
.zs-sb-gift{font-size:30px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.25))}
.zs-sb-sep{width:1px;align-self:stretch;background:rgba(255,255,255,.45);margin:4px 0}
.zs-sb-head{font-weight:800;font-size:19px;white-space:nowrap;letter-spacing:-.2px}
.zs-sb-hl{background:#f5e732;color:#0b5a2a;border-radius:8px;padding:2px 8px;margin-right:6px}
.zs-sb-text{flex:1 1 280px;font-size:16px}
.zs-sb-app{color:#5dff7a;font-weight:800}
.zs-sb-free{color:#f5e732;font-weight:800;position:relative;white-space:nowrap}
.zs-sb-free::after{content:"";position:absolute;left:-6px;right:-10px;bottom:-6px;height:6px;
  border-bottom:2px solid #f5e732;border-radius:0 0 50% 50%}
.zs-sb-btn{display:inline-flex;align-items:center;gap:8px;background:#fff;color:#0b5a2a;font-weight:800;
  font-size:15px;text-decoration:none;padding:8px 16px 8px 10px;border-radius:999px;white-space:nowrap;
  box-shadow:0 3px 10px rgba(0,0,0,.18);transition:transform .15s}
.zs-sb-btn:hover{transform:translateY(-1px)}
.zs-sb-wa{width:26px;height:26px;border-radius:50%;background:#25D366;display:inline-flex;align-items:center;justify-content:center}
.zs-sb-x{position:absolute;right:14px;top:50%;transform:translateY(-50%);background:transparent;border:0;
  color:#fff;font-size:20px;line-height:1;cursor:pointer;padding:4px;opacity:.75}
.zs-sb-x:hover{opacity:1}
@media (max-width:760px){
  .zs-sb{border-radius:18px;padding:12px 40px 12px 14px;gap:10px}
  .zs-sb-sep{display:none}.zs-sb-head{font-size:17px}.zs-sb-text{font-size:14px;flex-basis:100%}
}
`;

export default function SetupBar({ appName, shop, email }) {
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    try {
      const until = Number(localStorage.getItem(HIDE_KEY) || 0);
      setHidden(until > Date.now());
    } catch {
      setHidden(false);
    }
  }, []);

  if (hidden) return null;

  const message =
    `Hi! Please set up ${appName} on my store for free.\n` +
    `Store: ${shop || ""}` +
    (email ? `\nEmail: ${email}` : "");
  const href = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(message)}`;

  const close = () => {
    try {
      localStorage.setItem(HIDE_KEY, String(Date.now() + HIDE_DAYS * 864e5));
    } catch {
      // Storage blocked: hide for this visit only.
    }
    setHidden(true);
  };

  return (
    <div className="zs-sb-wrap">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="zs-sb" role="region" aria-label="Free setup">
        <span className="zs-sb-gift" aria-hidden="true">🎁</span>
        <span className="zs-sb-sep" aria-hidden="true" />
        <span className="zs-sb-head">
          <span className="zs-sb-hl">Free Setup,</span>Zero Cost!
        </span>
        <span className="zs-sb-sep" aria-hidden="true" />
        <span className="zs-sb-text">
          Let our team set up <span className="zs-sb-app">{appName}</span> in your store for{" "}
          <span className="zs-sb-free">FREE</span>.
        </span>
        <a className="zs-sb-btn" href={href} target="_blank" rel="noopener noreferrer">
          <span className="zs-sb-wa" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff">
              <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm4.5 12.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.5-.3z" />
            </svg>
          </span>
          Chat on WhatsApp
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        </a>
        <button type="button" className="zs-sb-x" onClick={close} aria-label="Close">×</button>
      </div>
    </div>
  );
}
