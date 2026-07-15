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
import { getUsage, filterAllowedTypes } from "../credits.server";
import {
  verifyConnectionCode,
  getVerifiedConnection,
} from "../connection.server";
import { startMigrationJob, getActiveJob } from "../jobs.server";
import { brandStyles } from "./zs-styles.js";
import {
  ArrowLeftRight,
  Package,
  Layers,
  FileText,
  Image,
  Users,
  ShoppingCart,
  Boxes,
  Tag,
  Link2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RotateCw,
  Percent,
  Menu,
  Shuffle,
  Newspaper,
  KeyRound,
  Trash2,
  Check,
} from "lucide-react";

// ─── Loader ──────────────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const connections = await db.storeConnection.findMany({
    where: { ownerShop: shop },
    orderBy: { createdAt: "desc" },
  });

  for (const c of connections) {
    const srcSession = await db.session.findFirst({
      where: { shop: c.sourceShop, isOnline: false },
    });
    const has = !!srcSession?.accessToken;
    if (has !== c.authorized) {
      await db.storeConnection.update({
        where: { id: c.id },
        data: { authorized: has },
      });
      c.authorized = has;
    }
  }

  const usage = await getUsage(shop);

  return {
    shop,
    connections: connections.map((c) => ({
      id: c.id,
      sourceShop: c.sourceShop,
      label: c.label,
      authorized: c.authorized,
      codeVerified: c.codeVerified,
      // Pre-format on the server so the client renders identical text.
      // Calling toLocaleDateString() during render causes an SSR/client
      // hydration mismatch (different timezone/locale) which breaks
      // interactivity (e.g. clicking a store to select it) on this route.
      lastUsedLabel: c.lastUsedAt
        ? new Intl.DateTimeFormat("en-US", {
            year: "numeric",
            month: "numeric",
            day: "numeric",
            timeZone: "UTC",
          }).format(c.lastUsedAt)
        : null,
    })),
    plan: usage.plan,
    allowedTypes: usage.allowedTypes,
    limits: usage.limits,
    remaining: usage.remaining,
    allowsOverage: usage.allowsOverage,
  };
};

// ─── Action ──────────────────────────────────────────────────────────────────
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  // ── Connect / verify a source store (requires connection code) ─────────────
  if (intent === "connect") {
    let sourceShop = String(form.get("sourceShop") || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    const code = String(form.get("code") || "").trim();

    if (!sourceShop)
      return { ok: false, error: "Please enter a store domain." };
    if (!sourceShop.includes(".")) {
      return {
        ok: false,
        error: "Enter a full domain like store.myshopify.com",
      };
    }
    if (sourceShop === shop) {
      return {
        ok: false,
        error: "Source and target cannot be the same store.",
      };
    }
    if (!code) {
      return { ok: false, error: "Enter the source store's connection code." };
    }

    // SECURITY: the source store's owner must share its connection code. This
    // prevents anyone who merely knows a domain from pulling that store's data.
    const codeOk = await verifyConnectionCode(sourceShop, code);
    if (!codeOk) {
      return {
        ok: false,
        error:
          "That connection code doesn't match this store. Ask the source store's owner for the code in ZS StoreSync → Settings on that store.",
      };
    }

    const existingSession = await db.session.findFirst({
      where: { shop: sourceShop, isOnline: false },
    });
    const authorized = !!existingSession?.accessToken;

    await db.storeConnection.upsert({
      where: { ownerShop_sourceShop: { ownerShop: shop, sourceShop } },
      update: { authorized, codeVerified: true },
      create: { ownerShop: shop, sourceShop, authorized, codeVerified: true },
    });

    if (!authorized) {
      const installUrl = `/auth/login?shop=${encodeURIComponent(sourceShop)}`;
      return { ok: true, needsAuth: true, installUrl, sourceShop };
    }
    return { ok: true, needsAuth: false, authorized: true, sourceShop };
  }

  // ── Re-check authorization for a specific source ──────────────────────────
  if (intent === "recheck") {
    const sourceShop = String(form.get("sourceShop") || "").trim();
    const srcSession = await db.session.findFirst({
      where: { shop: sourceShop, isOnline: false },
    });
    const authorized = !!srcSession?.accessToken;
    await db.storeConnection.updateMany({
      where: { ownerShop: shop, sourceShop },
      data: { authorized },
    });
    if (!authorized) {
      const installUrl = `/auth/login?shop=${encodeURIComponent(sourceShop)}`;
      return { ok: true, needsAuth: true, installUrl, sourceShop };
    }
    return { ok: true, needsAuth: false, authorized: true, sourceShop };
  }

  // ── Disconnect a source store ──────────────────────────────────────────────
  if (intent === "disconnect") {
    const sourceShop = String(form.get("sourceShop") || "").trim();
    if (!sourceShop) return { ok: false, error: "No store specified." };

    // Remove the pairing for this owner only. The source store's session is
    // its own app install — deleting it would log that store out of the app,
    // so we never touch it here. (Sessions are cleaned up by the uninstall
    // and shop/redact webhooks on the source store itself.)
    await db.storeConnection.deleteMany({
      where: { ownerShop: shop, sourceShop },
    });

    return { ok: true, disconnected: true, sourceShop };
  }

  // ── Run a migration (background job — the client polls for status) ─────────
  if (intent === "migrate") {
    const sourceShop = String(form.get("sourceShop") || "").trim();
    const types = String(form.get("types") || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    if (!sourceShop || types.length === 0) {
      return {
        ok: false,
        error: "Pick a source store and at least one data type.",
      };
    }

    // SECURITY: only migrate from a source that was paired with a valid code.
    const conn = await getVerifiedConnection(shop, sourceShop);
    if (!conn) {
      return {
        ok: false,
        error:
          "This source store hasn't been verified with a connection code. Reconnect it above using its code.",
      };
    }

    const { allowed, blocked } = await filterAllowedTypes(shop, types);
    if (allowed.length === 0) {
      return {
        ok: false,
        error: `Your plan doesn't include: ${blocked.join(", ")}. Upgrade to continue.`,
      };
    }

    const usage = await getUsage(shop);
    const planLimits = usage.limits;
    const usedSoFar = usage.usage;
    const allowsOverage = usage.allowsOverage;

    const migrateLimits = {};
    const exhaustedTypes = [];
    for (const t of allowed) {
      const remaining = Math.max((planLimits[t] || 0) - (usedSoFar[t] || 0), 0);
      if (allowsOverage) {
        migrateLimits[t] = Infinity;
      } else {
        if (remaining <= 0) exhaustedTypes.push(t);
        migrateLimits[t] = remaining;
      }
    }

    if (!allowsOverage && exhaustedTypes.length > 0) {
      return {
        ok: false,
        error: `Monthly limit reached for: ${exhaustedTypes.join(", ")}. Upgrade your plan for more.`,
      };
    }

    const srcSession = await db.session.findFirst({
      where: { shop: sourceShop, isOnline: false },
    });
    if (!srcSession?.accessToken) {
      return {
        ok: false,
        error: "Source store not authorized. Connect it again.",
        needsAuth: true,
        installUrl: `/auth/login?shop=${encodeURIComponent(sourceShop)}`,
      };
    }

    // one job at a time per shop
    const active = await getActiveJob(shop);
    if (active) {
      return {
        ok: false,
        error:
          "A migration or sync is already running for this store. Wait for it to finish (see History).",
      };
    }

    const jobId = await startMigrationJob({
      shop,
      sourceShop,
      mode: "migrate",
      types: allowed,
      limits: migrateLimits,
    });

    return { ok: true, started: true, jobId, blocked };
  }

  return { ok: false, error: "Unknown action." };
};

// ─── Styles ──────────────────────────────────────────────────────────────────
const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,500&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');
  .zs-root { --zs-font-display:"Fraunces",Georgia,serif; --zs-font-body:"Hanken Grotesk",-apple-system,sans-serif;
    --zs-r-sm:10px; --zs-r-md:14px; --zs-r-lg:20px;
    --zs-shadow-sm:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);
    --zs-shadow-md:0 4px 14px rgba(58,49,40,.06),0 18px 40px rgba(58,49,40,.06);
    --zs-shadow-clay:0 10px 30px rgba(169,139,118,.28);
    font-family:var(--zs-font-body); -webkit-font-smoothing:antialiased; color:var(--zs-dark); }
  .zs-section-wrap{width:100vw;position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;padding:1.5rem;box-sizing:border-box;}
  .zs-wrap{max-width:1400px;margin:0 auto;width:100%;}
  .zs-stack>*+*{margin-top:24px;}
  @keyframes zsFadeUp{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:translateY(0);}}
  .zs-reveal{opacity:0;animation:zsFadeUp .55s cubic-bezier(.2,.7,.2,1) forwards;}
  .zs-d1{animation-delay:.04s;}.zs-d2{animation-delay:.12s;}.zs-d3{animation-delay:.20s;}
  .zs-sec-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:6px;}
  .zs-sec-title{font-family:var(--zs-font-display);font-size:22px;font-weight:600;color:var(--zs-dark);margin:0 0 4px;letter-spacing:-.01em;}
  .zs-sec-sub{font-size:13px;color:var(--zs-muted);margin:0 0 16px;line-height:1.5;}
  .zs-card{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:1.6rem;box-shadow:var(--zs-shadow-sm);}
  .zs-card-head{display:flex;align-items:center;gap:10px;margin-bottom:6px;}
  .zs-card-head h3{font-family:var(--zs-font-display);font-size:17px;font-weight:600;margin:0;color:var(--zs-dark);}
  .zs-step-num{width:26px;height:26px;border-radius:50%;background:var(--zs-clay);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;}
  .zs-connect-row{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;}
  .zs-input{flex:1;min-width:220px;padding:12px 14px;border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);font-size:14px;font-family:inherit;color:var(--zs-dark);background:var(--zs-cream-soft);outline:none;transition:border-color .15s;}
  .zs-input:focus{border-color:var(--zs-clay);}
  .zs-input.code{max-width:240px;text-transform:uppercase;letter-spacing:1px;font-weight:600;}
  .zs-btn{background:var(--zs-clay);color:#fff;border:none;padding:12px 22px;border-radius:var(--zs-r-sm);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:8px;box-shadow:var(--zs-shadow-clay);transition:transform .15s,background .15s;text-decoration:none;}
  .zs-btn:hover{transform:translateY(-2px);background:var(--zs-clay-deep);}
  .zs-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
  .zs-btn-ghost{background:var(--zs-cream-soft);color:var(--zs-clay-deep);border:1px solid var(--zs-border);box-shadow:none;}
  .zs-btn-ghost:hover{background:var(--zs-clay-soft);}
  .zs-code-hint{display:flex;align-items:center;gap:7px;margin-top:10px;font-size:12px;color:var(--zs-muted);}
  .zs-code-hint svg{color:var(--zs-camel);flex-shrink:0;}
  .zs-conn-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--zs-muted);margin:18px 0 10px;}
  .zs-conn-list{display:flex;flex-direction:column;gap:8px;}
  .zs-conn{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border:1.5px solid var(--zs-border);border-radius:var(--zs-r-sm);cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s;position:relative;}
  .zs-conn:hover{border-color:var(--zs-camel);background:var(--zs-cream-soft);}
  .zs-conn.sel{border-color:var(--zs-clay);background:var(--zs-clay-soft);box-shadow:0 0 0 3px rgba(169,139,118,.12);}
  .zs-conn.unauth{opacity:.92;}
  .zs-conn-left{display:flex;align-items:center;gap:11px;min-width:0;}
  .zs-conn-ico{width:36px;height:36px;border-radius:10px;background:var(--zs-sage-soft);color:var(--zs-sage-deep);display:flex;align-items:center;justify-content:center;flex-shrink:0;position:relative;}
  .zs-conn.sel .zs-conn-ico{background:var(--zs-clay);color:#fff;}
  .zs-conn-name{font-size:14px;font-weight:600;color:var(--zs-dark);display:flex;align-items:center;gap:8px;}
  .zs-conn-sub{font-size:11px;color:var(--zs-muted);margin-top:2px;}
  .zs-conn-right{display:flex;align-items:center;gap:8px;flex-shrink:0;}
  .zs-sel-tag{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--zs-clay-deep);background:#fff;border:1px solid var(--zs-clay);padding:3px 9px;border-radius:20px;display:inline-flex;align-items:center;gap:4px;}
  .zs-pill{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:4px 10px;border-radius:20px;border:none;font-family:inherit;cursor:default;display:inline-flex;align-items:center;gap:5px;}
  .zs-pill.ok{background:var(--zs-sage-soft);color:var(--zs-sage-deep);}
  .zs-pill.no{background:var(--zs-cream-tint);color:var(--zs-clay-deep);cursor:pointer;transition:background .15s;}
  .zs-pill.no:hover{background:var(--zs-clay-soft);}
  .zs-remove{width:30px;height:30px;border-radius:8px;border:1px solid var(--zs-border);background:#fff;color:var(--zs-muted);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .15s;flex-shrink:0;}
  .zs-remove:hover{border-color:#e0a0a0;background:#fbeaea;color:#9a3412;}
  .zs-confirm{display:flex;align-items:center;gap:8px;}
  .zs-confirm-txt{font-size:11px;color:#9a3412;font-weight:600;}
  .zs-confirm-yes{background:#9a3412;color:#fff;border:none;padding:5px 11px;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;}
  .zs-confirm-no{background:#fff;color:var(--zs-muted);border:1px solid var(--zs-border);padding:5px 11px;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;}
  .zs-types{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px;}
  .zs-type-chk{display:flex;align-items:center;gap:9px;padding:12px;border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);cursor:pointer;transition:all .15s;user-select:none;}
  .zs-type-chk:hover{border-color:var(--zs-camel);}
  .zs-type-chk.on{border-color:var(--zs-clay);background:var(--zs-clay-soft);}
  .zs-type-chk.locked{opacity:.45;cursor:not-allowed;}
  .zs-type-chk .ico{width:32px;height:32px;border-radius:9px;background:var(--zs-cream-soft);color:var(--zs-clay-deep);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .zs-type-chk .nm{font-size:13px;font-weight:600;color:var(--zs-dark);}
  .zs-type-chk .lk{font-size:9px;font-weight:700;color:var(--zs-camel);text-transform:uppercase;}
  .zs-banner{display:flex;align-items:flex-start;gap:10px;padding:13px 15px;border-radius:var(--zs-r-sm);font-size:13px;line-height:1.5;margin-top:14px;}
  .zs-banner.err{background:#fbeaea;color:#9a3412;border:1px solid #f3d2d2;}
  .zs-banner.ok{background:var(--zs-sage-soft);color:var(--zs-sage-deep);border:1px solid #d9e0c4;}
  .zs-banner.info{background:var(--zs-cream-tint);color:var(--zs-clay-deep);border:1px solid var(--zs-border);}
  .zs-banner .gbtn{margin-left:auto;flex-shrink:0;background:var(--zs-clay);color:#fff;border:none;padding:7px 13px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px;}
  .zs-log{margin-top:14px;background:var(--zs-dark);border-radius:var(--zs-r-md);padding:14px 16px;max-height:280px;overflow:auto;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.7;color:rgba(255,255,255,.8);}
  .zs-log div{white-space:pre-wrap;}
  .zs-result{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px;}
  .zs-result .box{background:var(--zs-cream-soft);border:1px solid var(--zs-border);border-radius:var(--zs-r-sm);padding:14px;text-align:center;}
  .zs-result .v{font-family:var(--zs-font-display);font-size:24px;font-weight:600;color:var(--zs-dark);}
  .zs-result .l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--zs-muted);margin-top:4px;}
  .zs-spin{animation:zsRot 1s linear infinite;}
  @keyframes zsRot{to{transform:rotate(360deg);}}
  @media(max-width:780px){.zs-types{grid-template-columns:repeat(2,1fr);}.zs-result{grid-template-columns:repeat(2,1fr);}.zs-input.code{max-width:none;}}
`;

const ALL_TYPES = [
  { id: "products", name: "Products", icon: <Package size={16} /> },
  { id: "collections", name: "Collections", icon: <Layers size={16} /> },
  { id: "pages", name: "Pages", icon: <FileText size={16} /> },
  { id: "discounts", name: "Discounts", icon: <Percent size={16} /> },
  { id: "files", name: "Files", icon: <Image size={16} /> },
  { id: "menus", name: "Menus", icon: <Menu size={16} /> },
  { id: "redirects", name: "Redirects", icon: <Shuffle size={16} /> },
  { id: "metaobjects", name: "Metaobjects", icon: <Boxes size={16} /> },
  { id: "blogPosts", name: "Blog Posts", icon: <Newspaper size={16} /> },
  { id: "metafields", name: "Metafields", icon: <Tag size={16} /> },
  { id: "orders", name: "Orders", icon: <ShoppingCart size={16} /> },
  { id: "customers", name: "Customers", icon: <Users size={16} /> },
];

export default function Migrate() {
  const { connections, allowedTypes, remaining, limits, plan, allowsOverage } =
    useLoaderData();
  const connectFetcher = useFetcher();
  const recheckFetcher = useFetcher();
  const disconnectFetcher = useFetcher();
  const runFetcher = useFetcher();
  const jobFetcher = useFetcher();
  const revalidator = useRevalidator();
  const [activeJobId, setActiveJobId] = useState(null);

  const [selectedSource, setSelectedSource] = useState(
    connections.find((c) => c.authorized)?.sourceShop || "",
  );
  const [domain, setDomain] = useState("");
  const [code, setCode] = useState("");
  const [picked, setPicked] = useState(["products", "collections", "pages"]);
  const [authOpenedFor, setAuthOpenedFor] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);

  const connecting = connectFetcher.state !== "idle";
  const rechecking = recheckFetcher.state !== "idle";

  const job = jobFetcher.data?.job;
  const jobRunning =
    !!activeJobId && (!job || job.id !== activeJobId || !job.finished);
  const running = runFetcher.state !== "idle" || jobRunning;

  // when the action reports the job started, begin polling it
  useEffect(() => {
    if (runFetcher.data?.started && runFetcher.data.jobId) {
      setActiveJobId(runFetcher.data.jobId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runFetcher.data]);

  // poll the job status every 2.5s until it reaches a terminal state
  useEffect(() => {
    if (!activeJobId) return undefined;
    if (job?.id === activeJobId && job?.finished) {
      revalidator.revalidate(); // refresh remaining quota numbers
      return undefined;
    }
    const t = setInterval(() => {
      if (jobFetcher.state === "idle") {
        jobFetcher.load(`/app/jobs/${activeJobId}`);
      }
    }, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId, job?.id, job?.finished]);

  const openAuth = (url, shopName) => {
    const full = `${window.location.origin}${url}`;
    window.open(full, "_blank", "noopener,noreferrer");
    setAuthOpenedFor(shopName);
  };

  useEffect(() => {
    const d = connectFetcher.data;
    if (d?.needsAuth && d?.installUrl) {
      openAuth(d.installUrl, d.sourceShop);
    } else if (d?.authorized) {
      setSelectedSource(d.sourceShop);
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectFetcher.data]);

  useEffect(() => {
    const d = recheckFetcher.data;
    if (d?.authorized) {
      setSelectedSource(d.sourceShop);
      setAuthOpenedFor(null);
      revalidator.revalidate();
    } else if (d?.needsAuth && d?.installUrl) {
      openAuth(d.installUrl, d.sourceShop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recheckFetcher.data]);

  // after disconnect, clear selection if it was the removed one + refresh
  useEffect(() => {
    const d = disconnectFetcher.data;
    if (d?.disconnected) {
      if (selectedSource === d.sourceShop) setSelectedSource("");
      setConfirmRemove(null);
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disconnectFetcher.data]);

  const toggleType = (id) => {
    if (!allowedTypes.includes(id)) return;
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  const doDisconnect = (sourceShop) => {
    const fd = new FormData();
    fd.append("intent", "disconnect");
    fd.append("sourceShop", sourceShop);
    disconnectFetcher.submit(fd, { method: "post" });
  };

  const cData = connectFetcher.data;
  const result = runFetcher.data;
  const authedConns = connections.filter((c) => c.authorized);

  return (
    <s-page heading="New Migration">
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap zs-stack">
            <div className="zs-reveal zs-d1">
              <div className="zs-sec-eyebrow">Store → Store</div>
              <h2 className="zs-sec-title">Start a Migration</h2>
              <p className="zs-sec-sub">
                Connect the store you want to copy <em>from</em>, choose what to
                move, and run it into this store. Duplicates are skipped
                automatically · <b>{plan.toUpperCase()}</b> plan
                {allowsOverage ? " · overage billed per item" : ""}.
              </p>
            </div>

            {/* Step 1 */}
            <div className="zs-card zs-reveal zs-d1">
              <div className="zs-card-head">
                <span className="zs-step-num">1</span>
                <h3>Connect a source store</h3>
              </div>
              <p className="zs-sec-sub" style={{ margin: 0 }}>
                Enter the Shopify domain of the store you want to pull data
                from, plus its connection code. You can connect several and pick
                one each time.
              </p>

              <connectFetcher.Form method="post">
                <input type="hidden" name="intent" value="connect" />
                <div className="zs-connect-row">
                  <input
                    className="zs-input"
                    name="sourceShop"
                    placeholder="my-old-store.myshopify.com"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                  />
                  <input
                    className="zs-input code"
                    name="code"
                    placeholder="Code · ZS7K-92QT"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <button className="zs-btn" disabled={connecting}>
                    {connecting ? (
                      <>
                        <Loader2 size={15} className="zs-spin" /> Connecting…
                      </>
                    ) : (
                      <>
                        <Link2 size={15} /> Connect
                      </>
                    )}
                  </button>
                </div>
              </connectFetcher.Form>

              <div className="zs-code-hint">
                <KeyRound size={14} />
                <span>
                  The source store's owner finds its connection code in ZS
                  StoreSync → Settings on that store.
                </span>
              </div>

              {cData?.error && (
                <div className="zs-banner err">
                  <AlertCircle size={16} /> {cData.error}
                </div>
              )}

              {authOpenedFor && (
                <div className="zs-banner info">
                  <Link2 size={16} />
                  <span>
                    Opened <b>{authOpenedFor}</b> in a new tab. Approve the app
                    there, then come back and click <b>“I’ve authorized”</b>.
                  </span>
                  <button
                    className="gbtn"
                    onClick={() => {
                      const fd = new FormData();
                      fd.append("intent", "recheck");
                      fd.append("sourceShop", authOpenedFor);
                      recheckFetcher.submit(fd, { method: "post" });
                    }}
                  >
                    {rechecking ? (
                      <>
                        <Loader2 size={13} className="zs-spin" /> Checking…
                      </>
                    ) : (
                      <>
                        <RotateCw size={13} /> I’ve authorized
                      </>
                    )}
                  </button>
                </div>
              )}

              {connections.length > 0 && (
                <>
                  <div className="zs-conn-label">
                    Connected stores — click one to select it as the source
                  </div>
                  <div className="zs-conn-list">
                    {connections.map((c) => {
                      const isSel = selectedSource === c.sourceShop;
                      const isConfirming = confirmRemove === c.sourceShop;
                      return (
                        <div
                          key={c.id}
                          className={`zs-conn ${isSel ? "sel" : ""} ${c.authorized ? "" : "unauth"}`}
                          onClick={() =>
                            !isConfirming && setSelectedSource(c.sourceShop)
                          }
                        >
                          <div className="zs-conn-left">
                            <div className="zs-conn-ico">
                              {isSel ? (
                                <Check size={17} />
                              ) : (
                                <Package size={17} />
                              )}
                            </div>
                            <div>
                              <div className="zs-conn-name">
                                {c.sourceShop}
                                {isSel && (
                                  <span className="zs-sel-tag">
                                    <Check size={10} /> Selected
                                  </span>
                                )}
                              </div>
                              <div className="zs-conn-sub">
                                {c.lastUsedLabel
                                  ? `Last used ${c.lastUsedLabel}`
                                  : "Never used"}
                              </div>
                            </div>
                          </div>

                          <div
                            className="zs-conn-right"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {isConfirming ? (
                              <div className="zs-confirm">
                                <span className="zs-confirm-txt">
                                  Disconnect?
                                </span>
                                <button
                                  className="zs-confirm-yes"
                                  onClick={() => doDisconnect(c.sourceShop)}
                                >
                                  {disconnectFetcher.state !== "idle"
                                    ? "…"
                                    : "Yes, remove"}
                                </button>
                                <button
                                  className="zs-confirm-no"
                                  onClick={() => setConfirmRemove(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <>
                                {c.authorized ? (
                                  <span className="zs-pill ok">
                                    <CheckCircle2 size={12} /> Authorized
                                  </span>
                                ) : (
                                  <button
                                    className="zs-pill no"
                                    onClick={() => {
                                      const fd = new FormData();
                                      fd.append("intent", "recheck");
                                      fd.append("sourceShop", c.sourceShop);
                                      recheckFetcher.submit(fd, {
                                        method: "post",
                                      });
                                    }}
                                  >
                                    <Link2 size={11} /> Needs auth — authorize
                                  </button>
                                )}
                                <button
                                  className="zs-remove"
                                  title="Disconnect this store"
                                  onClick={() => setConfirmRemove(c.sourceShop)}
                                >
                                  <Trash2 size={15} />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            {/* Step 2 */}
            <div className="zs-card zs-reveal zs-d2">
              <div className="zs-card-head">
                <span className="zs-step-num">2</span>
                <h3>Choose what to migrate</h3>
              </div>
              <div className="zs-types">
                {ALL_TYPES.map((t) => {
                  const locked = !allowedTypes.includes(t.id);
                  const on = picked.includes(t.id);
                  const left = remaining[t.id] ?? 0;
                  const lim = limits[t.id] ?? 0;
                  return (
                    <div
                      key={t.id}
                      className={`zs-type-chk ${on ? "on" : ""} ${locked ? "locked" : ""}`}
                      onClick={() => toggleType(t.id)}
                    >
                      <div className="ico">{t.icon}</div>
                      <div>
                        <div className="nm">{t.name}</div>
                        {locked ? (
                          <div className="lk">Upgrade</div>
                        ) : allowsOverage ? (
                          <div
                            className="lk"
                            style={{ color: "var(--zs-sage-deep)" }}
                          >
                            {lim} /mo · +overage
                          </div>
                        ) : (
                          <div
                            className="lk"
                            style={{ color: "var(--zs-muted)" }}
                          >
                            {left}/{lim} left
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Step 3 */}
            <div className="zs-card zs-reveal zs-d3">
              <div className="zs-card-head">
                <span className="zs-step-num">3</span>
                <h3>Run the migration</h3>
              </div>
              <p className="zs-sec-sub" style={{ margin: "0 0 4px" }}>
                {selectedSource
                  ? `Copying from ${selectedSource} → this store.`
                  : authedConns.length > 0
                    ? "Select a source store above first."
                    : "Connect and authorize a source store above first."}
              </p>

              <runFetcher.Form method="post">
                <input type="hidden" name="intent" value="migrate" />
                <input type="hidden" name="sourceShop" value={selectedSource} />
                <input type="hidden" name="types" value={picked.join(",")} />
                <button
                  className="zs-btn"
                  disabled={!selectedSource || picked.length === 0 || running}
                  style={{ marginTop: 12 }}
                >
                  {running ? (
                    <>
                      <Loader2 size={15} className="zs-spin" /> Migrating…
                    </>
                  ) : (
                    <>
                      <ArrowLeftRight size={15} /> Run Migration
                    </>
                  )}
                </button>
              </runFetcher.Form>

              {result?.error && (
                <div className="zs-banner err">
                  <AlertCircle size={16} /> {result.error}
                </div>
              )}

              {jobRunning && (
                <>
                  <div className="zs-banner info">
                    <Loader2 size={16} className="zs-spin" />
                    <span>
                      Migration running in the background — live progress below.
                      You can leave this page; the run continues and appears in{" "}
                      <b>History</b>.
                    </span>
                  </div>
                  {job?.logs?.length > 0 && (
                    <div className="zs-log">
                      {job.logs.map((l, i) => (
                        <div key={i}>{l}</div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {job?.finished && job.id === activeJobId && (
                <>
                  {job.status === "failed" ? (
                    <div className="zs-banner err">
                      <AlertCircle size={16} /> Migration failed
                      {job.error ? ` — ${job.error}` : "."}
                    </div>
                  ) : (
                    <div className="zs-banner ok">
                      <CheckCircle2 size={16} />
                      Migration finished — {job.summary}
                      {job.status === "partial" ? " (some items failed)" : ""}
                    </div>
                  )}
                  <div className="zs-result">
                    <div className="box">
                      <div className="v">{job.created}</div>
                      <div className="l">Created</div>
                    </div>
                    <div className="box">
                      <div className="v">{job.skipped}</div>
                      <div className="l">Skipped</div>
                    </div>
                    <div className="box">
                      <div className="v">{job.failed}</div>
                      <div className="l">Failed</div>
                    </div>
                    <div className="box">
                      <div className="v">{job.total}</div>
                      <div className="l">Total</div>
                    </div>
                  </div>
                  {job.logs?.length > 0 && (
                    <div className="zs-log">
                      {job.logs.map((l, i) => (
                        <div key={i}>{l}</div>
                      ))}
                    </div>
                  )}
                  <div style={{ marginTop: 14 }}>
                    <RouterLink
                      to="/app/history"
                      className="zs-btn zs-btn-ghost"
                    >
                      View migration history →
                    </RouterLink>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
