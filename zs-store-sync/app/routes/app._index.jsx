import { useRef, useState, useEffect } from "react";
import { Link as RouterLink, useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getUsage, PLAN_LABEL } from "../credits.server";
import { failStaleJobs } from "../jobs.server";
import { recordFeedback } from "../feedback.server";
import { brandStyles } from "./zs-styles.js";
import {
  ArrowLeftRight, Package, Layers, FileText, Image, Users,
  ShoppingCart, Boxes, Tag, Zap, ShieldCheck, BookOpen,
  HelpCircle, Mail, Rocket, PlayCircle,
  Percent, Menu, Shuffle, Newspaper,
  Star, MessageSquareHeart, X, PartyPopper,
} from "lucide-react";

// Public app-store listing — deep-linked to open the "Write a review" modal.
const APP_STORE_REVIEW_URL =
  "https://apps.shopify.com/zs-storesync#modal-show=WriteReviewModal";

// ─── Loader (live DB) ────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // jobs left "running" by a server restart are marked failed
  await failStaleJobs(shop);

  const dbJobs = await db.migrationJob.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 6,
  });

  const jobs = dbJobs.map((j) => ({
    id: j.id,
    source: j.sourceShop,
    target: j.targetShop,
    summary: j.summary || `${j.itemCount ?? 0} items`,
    status: j.status,
    type: (j.dataTypes || "").split(",")[0] || "Products",
    createdAt: j.createdAt,
  }));

  const usage = await getUsage(shop);
  const limits = usage.limits;
  // Total limit = sum of all per-type limits for this plan
  const monthlyLimit = Object.values(limits).reduce((a, b) => a + b, 0);
  // Total used = sum of all per-type usage
  const monthlyUsed = Object.values(usage.usage).reduce((a, b) => a + b, 0);
  const monthlyPct = Math.min(Math.round((monthlyUsed / monthlyLimit) * 100), 100);

  const totalMigrated = await db.migrationJob.aggregate({
    where: { shop },
    _sum: { createdCount: true },
  });

  const planName = PLAN_LABEL[usage.plan] ?? "Free Plan";

  return {
    stats: {
      totalJobs: await db.migrationJob.count({ where: { shop } }),
      itemsMigrated: totalMigrated._sum.createdCount || 0,
      monthlyUsed,
      monthlyLimit,
      lastRun: jobs[0]?.createdAt
        ? new Date(jobs[0].createdAt).toLocaleDateString()
        : "—",
    },
    plan: {
      current: usage.plan,
      name: planName,
      monthlyLimit,
      monthlyUsed,
      monthlyPct,
    },
    jobs,
  };
};

// ─── Action: record merchant feedback ────────────────────────────────────────
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  if (form.get("intent") === "feedback") {
    const rating = Number(form.get("rating"));
    const message = form.get("message") || "";
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return { ok: false, error: "Invalid rating" };
    }
    const result = await recordFeedback({
      shop: session.shop,
      rating,
      message,
    });
    return result;
  }

  return { ok: false };
};

// (styles + component are identical to the standalone homepage file)
const pageStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,500&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');
  .zs-root { --zs-font-display:"Fraunces",Georgia,serif; --zs-font-body:"Hanken Grotesk",-apple-system,sans-serif;
    --zs-r-sm:10px; --zs-r-md:14px; --zs-r-lg:20px;
    --zs-shadow-sm:0 1px 2px rgba(58,49,40,.04),0 2px 8px rgba(58,49,40,.05);
    --zs-shadow-md:0 4px 14px rgba(58,49,40,.06),0 18px 40px rgba(58,49,40,.06);
    --zs-shadow-clay:0 10px 30px rgba(169,139,118,.28);
    --rose:var(--zs-clay); --rose-soft:var(--zs-clay-soft);
    --shadow-rose:0 8px 24px rgba(169,139,118,0.18);
    font-family:var(--zs-font-body); -webkit-font-smoothing:antialiased; color:var(--zs-dark); }
  .zs-section-wrap{width:100vw;position:relative;left:50%;right:50%;margin-left:-50vw;margin-right:-50vw;padding:1.5rem;box-sizing:border-box;}
  .zs-wrap{max-width:1400px;margin:0 auto;width:100%;}
  .zs-stack>*+*{margin-top:30px;}
  @keyframes zsFadeUp{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:translateY(0);}}
  .zs-reveal{opacity:0;animation:zsFadeUp .6s cubic-bezier(.2,.7,.2,1) forwards;}
  .zs-d1{animation-delay:.04s;}.zs-d2{animation-delay:.12s;}.zs-d3{animation-delay:.20s;}.zs-d4{animation-delay:.28s;}.zs-d5{animation-delay:.36s;}.zs-d6{animation-delay:.44s;}
  .zs-sec-head{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;margin-bottom:16px;}
  .zs-sec-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:6px;}
  .zs-sec-title{font-family:var(--zs-font-display);font-size:22px;font-weight:600;color:var(--zs-dark);line-height:1.1;letter-spacing:-.01em;margin:0;}
  .zs-sec-link{font-size:12px;font-weight:600;color:var(--zs-clay);text-decoration:none;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;transition:gap .18s,opacity .18s;}
  .zs-sec-link:hover{gap:8px;opacity:.85;}
  .zs-hero{background:linear-gradient(112deg,#221d18 0%,var(--zs-dark) 43%,#4a2f1b 100%);border-radius:var(--zs-r-lg);padding:1.9rem 3rem;position:relative;overflow:hidden;box-shadow:var(--zs-shadow-md);min-height:280px;display:flex;align-items:center;}
  .zs-hero::before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 90% 18%,rgba(226,158,73,.62) 0%,rgba(169,139,118,.32) 19%,transparent 45%),radial-gradient(circle at 3% 94%,rgba(186,191,148,.18) 0%,transparent 48%);pointer-events:none;}
  .zs-hero::after{content:"";position:absolute;inset:0;opacity:.38;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:44px 44px;mask-image:radial-gradient(circle at 78% 54%,#000 0%,transparent 72%);}
  .zs-hero-wave{position:absolute;top:-8%;right:-2%;bottom:-8%;width:72%;z-index:1;pointer-events:none;-webkit-mask-image:linear-gradient(90deg,transparent 0%,rgba(0,0,0,.12) 13%,#000 35%,#000 100%);mask-image:linear-gradient(90deg,transparent 0%,rgba(0,0,0,.12) 13%,#000 35%,#000 100%);}
  .zs-hero-wave svg{display:block;width:100%;height:100%;}
  @keyframes zsWaveFloat{0%,100%{transform:translateY(0);}50%{transform:translateY(-10px);}}
  .zs-hero-wave svg{animation:zsWaveFloat 9s ease-in-out infinite;}
  .zs-hero-left{position:relative;z-index:2;}
  .zs-hero-right{position:relative;z-index:2;display:flex;align-items:center;justify-content:center;}
  .zs-hero-chip{display:inline-flex;align-items:center;gap:7px;background:rgba(186,191,148,.16);color:var(--zs-cream);border:1px solid rgba(186,191,148,.34);font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:6px 14px;border-radius:30px;margin-bottom:18px;}
  .zs-hero-chip-dot{width:6px;height:6px;border-radius:50%;background:var(--zs-sage);box-shadow:0 0 0 4px rgba(186,191,148,.22);}
  .zs-hero h1{font-family:var(--zs-font-display);font-size:42px;font-weight:600;color:#fff;margin:0 0 14px;line-height:1.04;letter-spacing:-.02em;}
  .zs-hero h1 em{font-style:italic;font-weight:500;color:var(--zs-camel);}
  .zs-hero-lead{color:rgba(255,255,255,.62);font-size:15px;line-height:1.62;max-width:460px;margin:0 0 22px;}
  .zs-hero-btns{display:flex;gap:12px;flex-wrap:wrap;align-items:center;}
  .zs-btn-primary{background:var(--zs-clay);color:#fff;border:none;padding:13px 26px;border-radius:var(--zs-r-sm);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:8px;box-shadow:var(--zs-shadow-clay);transition:transform .18s,box-shadow .18s,background .18s;}
  .zs-btn-primary:hover{transform:translateY(-2px);background:var(--zs-clay-deep);box-shadow:0 14px 36px rgba(169,139,118,.40);}
  .zs-btn-ghost-white{background:rgba(255,255,255,.06);color:rgba(255,255,255,.85);border:1px solid rgba(255,255,255,.18);padding:13px 24px;border-radius:var(--zs-r-sm);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-flex;align-items:center;transition:all .18s;}
  .zs-btn-ghost-white:hover{border-color:rgba(255,255,255,.45);background:rgba(255,255,255,.1);color:#fff;}
  .zs-sync{width:240px;height:240px;position:relative;display:flex;align-items:center;justify-content:center;}
  .zs-sync svg{width:100%;height:100%;overflow:visible;}
  @keyframes zsDash{to{stroke-dashoffset:-200;}}
  .zs-sync-flow{stroke-dasharray:6 10;animation:zsDash 3.5s linear infinite;}
  @keyframes zsPulse{0%,100%{transform:scale(1);opacity:1;}50%{transform:scale(1.06);opacity:.92;}}
  .zs-sync-node{position:absolute;width:70px;height:70px;border-radius:18px;display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 12px 30px rgba(0,0,0,.3),inset 0 2px 8px rgba(255,255,255,.16);animation:zsPulse 4s ease-in-out infinite;}
  .zs-sync-node.src{left:0;background:linear-gradient(150deg,var(--zs-camel),var(--zs-clay-deep));}
  .zs-sync-node.dst{right:0;background:linear-gradient(150deg,var(--zs-sage),var(--zs-sage-deep));animation-delay:1.2s;}
  .zs-sync-mid{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:50px;height:50px;border-radius:50%;background:var(--zs-clay);color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(169,139,118,.5);z-index:3;}
  .zs-stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}
  .zs-stat{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-md);padding:1rem 1.1rem;box-shadow:var(--zs-shadow-sm);transition:transform .18s,border-color .18s,box-shadow .18s;position:relative;min-width:0;display:flex;align-items:center;gap:14px;}
  .zs-stat:hover{transform:translateY(-2px);border-color:var(--zs-camel);box-shadow:var(--zs-shadow-md);}
  .zs-stat-icon{width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .zs-stat-icon.clay{background:var(--zs-clay-soft);color:var(--zs-clay-deep);}
  .zs-stat-icon.camel{background:var(--zs-camel-soft);color:var(--zs-clay);}
  .zs-stat-icon.sage{background:var(--zs-sage-soft);color:var(--zs-sage-deep);}
  .zs-stat-icon.cream{background:var(--zs-cream-tint);color:var(--zs-clay-deep);}
  .zs-stat-body{display:flex;flex-direction:column;min-width:0;flex:1;}
  .zs-stat-value{font-family:var(--zs-font-display);font-size:22px;font-weight:600;color:var(--zs-dark);line-height:1;letter-spacing:-.01em;}
  .zs-stat-label{font-size:10px;color:var(--zs-muted);font-weight:600;margin-top:5px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .zs-types-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}
  .zs-type{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-md);padding:1.1rem 1.2rem;display:flex;align-items:center;gap:12px;box-shadow:var(--zs-shadow-sm);transition:transform .18s,border-color .18s,box-shadow .18s;}
  .zs-type:hover{transform:translateY(-2px);border-color:var(--zs-sage);box-shadow:var(--zs-shadow-md);}
  .zs-type-icon{width:40px;height:40px;border-radius:11px;background:var(--zs-cream-soft);color:var(--zs-clay-deep);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .zs-type-name{font-size:14px;font-weight:600;color:var(--zs-dark);}
  .zs-type-sub{font-size:11px;color:var(--zs-muted);margin-top:2px;}
  .zs-type-lock{margin-left:auto;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--zs-camel);background:var(--zs-camel-soft);padding:3px 8px;border-radius:20px;}
  .zs-nav-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;}
  .zs-nav-card{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:1.75rem;text-decoration:none;display:flex;flex-direction:column;position:relative;overflow:hidden;box-shadow:var(--zs-shadow-sm);transition:transform .2s,border-color .2s,box-shadow .2s;}
  .zs-nav-card::after{content:"";position:absolute;bottom:0;left:0;right:0;height:3px;background:var(--zs-grad);transform:scaleX(0);transition:transform .26s;transform-origin:left;}
  .zs-nav-card:hover{transform:translateY(-4px);border-color:transparent;box-shadow:var(--zs-shadow-md);}
  .zs-nav-card:hover::after{transform:scaleX(1);}
  .zs-nav-card-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px;}
  .zs-nav-card-icon{width:54px;height:54px;border-radius:15px;display:flex;align-items:center;justify-content:center;}
  .zs-nav-card-icon.clay{background:var(--zs-clay-soft);color:var(--zs-clay-deep);}
  .zs-nav-card-icon.camel{background:var(--zs-camel-soft);color:var(--zs-clay);}
  .zs-nav-card-icon.sage{background:var(--zs-sage-soft);color:var(--zs-sage-deep);}
  .zs-nav-card-arrow{width:32px;height:32px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--zs-bg);color:var(--zs-camel);font-size:15px;transition:background .18s,color .18s,transform .18s;}
  .zs-nav-card:hover .zs-nav-card-arrow{background:var(--zs-clay);color:#fff;transform:translateX(3px);}
  .zs-nav-card-title{font-family:var(--zs-font-display);font-size:19px;font-weight:600;color:var(--zs-dark);margin-bottom:8px;letter-spacing:-.01em;}
  .zs-nav-card-desc{font-size:13px;color:var(--zs-muted);line-height:1.6;margin-bottom:18px;flex:1;}
  .zs-nav-card-meta{font-size:11px;font-weight:500;color:var(--zs-camel);padding-top:14px;border-top:1px solid var(--zs-border);}
  .zs-split{display:grid;grid-template-columns:1.45fr 1fr;gap:24px;align-items:start;}
  .zs-panel{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:1.6rem;box-shadow:var(--zs-shadow-sm);}
  .zs-recent-item{display:flex;align-items:center;justify-content:space-between;padding:13px 14px;border-radius:var(--zs-r-sm);border:1px solid transparent;transition:background .15s,border-color .15s;}
  .zs-recent-item+.zs-recent-item{margin-top:4px;}
  .zs-recent-item:hover{background:var(--zs-bg);border-color:var(--zs-border);}
  .zs-recent-left{display:flex;align-items:center;gap:13px;}
  .zs-recent-icon{width:40px;height:40px;border-radius:11px;background:var(--zs-sage-soft);color:var(--zs-sage-deep);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .zs-recent-name{font-size:14px;font-weight:600;color:var(--zs-dark);display:flex;align-items:center;gap:7px;}
  .zs-recent-sub{font-size:12px;color:var(--zs-muted);margin-top:3px;}
  .zs-route{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--zs-muted);}
  .zs-route b{font-weight:600;color:var(--zs-dark);}
  .zs-badge-done{background:var(--zs-sage-soft);color:var(--zs-sage-deep);font-size:11px;font-weight:600;padding:4px 11px;border-radius:20px;display:inline-flex;align-items:center;gap:6px;}
  .zs-badge-done::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--zs-sage-deep);}
  .zs-badge-run{background:var(--zs-cream-tint);color:var(--zs-clay-deep);font-size:11px;font-weight:600;padding:4px 11px;border-radius:20px;display:inline-flex;align-items:center;gap:6px;}
  .zs-badge-run::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--zs-clay);}
  .zs-badge-fail{background:#fbeaea;color:#9a3412;font-size:11px;font-weight:600;padding:4px 11px;border-radius:20px;display:inline-flex;align-items:center;gap:6px;}
  .zs-badge-fail::before{content:"";width:6px;height:6px;border-radius:50%;background:#9a3412;}
  .zs-plan-card{background:var(--zs-dark);border-radius:var(--zs-r-lg);padding:1.75rem;position:relative;overflow:hidden;box-shadow:var(--zs-shadow-md);}
  .zs-plan-card::before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 100% 0%,rgba(186,191,148,.28) 0%,transparent 55%);pointer-events:none;}
  .zs-plan-inner{position:relative;z-index:1;}
  .zs-plan-eyebrow{font-size:11px;font-weight:700;color:var(--zs-camel);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:10px;}
  .zs-plan-name{font-family:var(--zs-font-display);font-size:27px;font-weight:600;color:#fff;margin-bottom:7px;letter-spacing:-.01em;}
  .zs-plan-desc{font-size:13px;color:rgba(255,255,255,.55);line-height:1.55;margin-bottom:22px;}
  .zs-plan-meters{display:flex;flex-direction:column;gap:16px;margin-bottom:24px;}
  .zs-plan-meter-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;}
  .zs-plan-meter-label{font-size:12px;color:rgba(255,255,255,.5);}
  .zs-plan-meter-value{font-size:12px;font-weight:600;color:#fff;}
  .zs-plan-meter-bar{height:5px;border-radius:20px;background:rgba(255,255,255,.1);overflow:hidden;}
  .zs-plan-meter-fill{height:100%;border-radius:20px;background:var(--zs-grad);}
  .zs-plan-upgrade-btn{width:100%;box-sizing:border-box;background:var(--zs-clay);color:#fff;border:none;padding:13px;border-radius:var(--zs-r-sm);font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;transition:transform .18s,box-shadow .18s,background .18s;box-shadow:var(--zs-shadow-clay);text-align:center;text-decoration:none;display:block;}
  .zs-plan-upgrade-btn:hover{transform:translateY(-2px);background:var(--zs-clay-deep);box-shadow:0 14px 36px rgba(169,139,118,.4);}
  .zs-plan-upgrade-note{font-size:11px;color:rgba(255,255,255,.35);text-align:center;margin-top:10px;}
  .zs-resources-grid{display:grid;grid-template-columns:1.7fr 1fr 1fr;gap:16px;}
  .zs-video-card{background:var(--zs-dark);border-radius:var(--zs-r-lg);min-height:220px;position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;cursor:pointer;box-shadow:var(--zs-shadow-sm);transition:transform .2s,box-shadow .2s;text-decoration:none;}
  .zs-video-card:hover{transform:translateY(-3px);box-shadow:var(--zs-shadow-md);}
  .zs-video-card::before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 50% 38%,rgba(169,139,118,.36) 0%,transparent 58%);}
  .zs-video-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-70%);width:62px;height:62px;border-radius:50%;background:rgba(255,255,255,.12);border:1.5px solid rgba(255,255,255,.34);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;color:#fff;transition:all .2s;}
  .zs-video-card:hover .zs-video-play{background:var(--zs-clay);border-color:var(--zs-clay);transform:translate(-50%,-70%) scale(1.08);}
  .zs-video-info{position:relative;z-index:1;padding:1.4rem 1.6rem;}
  .zs-video-tag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--zs-camel);margin-bottom:8px;}
  .zs-video-title{font-family:var(--zs-font-display);font-size:18px;font-weight:600;color:#fff;margin-bottom:5px;}
  .zs-video-sub{font-size:12px;color:rgba(255,255,255,.5);}
  .zs-link-card{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:1.4rem;box-shadow:var(--zs-shadow-sm);}
  .zs-link-card-title{font-size:13px;font-weight:700;color:var(--zs-dark);margin-bottom:14px;display:flex;align-items:center;gap:8px;}
  .zs-res-link{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:var(--zs-r-sm);font-size:13px;color:var(--zs-dark);font-weight:500;text-decoration:none;transition:all .15s;cursor:pointer;}
  .zs-res-link+.zs-res-link{margin-top:2px;}
  .zs-res-link:hover{background:var(--zs-clay-soft);color:var(--zs-clay-deep);padding-left:16px;}
  .zs-res-link span:last-child{color:var(--zs-camel);}
  .zs-res-link:hover span:last-child{color:var(--zs-clay-deep);}
  .zs-empty{padding:2.75rem 1.5rem;text-align:center;border:1px dashed var(--zs-border);border-radius:var(--zs-r-md);}
  .zs-empty-icon{color:var(--zs-camel);margin-bottom:12px;display:flex;justify-content:center;}
  .zs-empty-title{font-family:var(--zs-font-display);font-size:17px;font-weight:600;color:var(--zs-dark);margin-bottom:6px;}
  .zs-empty-sub{font-size:13px;color:var(--zs-muted);}
  @media(max-width:1100px){.zs-stats-grid{grid-template-columns:repeat(2,1fr);}.zs-types-grid{grid-template-columns:repeat(2,1fr);}.zs-nav-grid{grid-template-columns:1fr;}.zs-resources-grid{grid-template-columns:1fr;}}
  @media(max-width:720px){.zs-split{grid-template-columns:1fr;}}
  @media(max-width:600px){.zs-hero{padding:1.8rem 1.35rem;min-height:0;}.zs-hero-wave{width:120%;opacity:.45;}.zs-hero h1{font-size:32px;}.zs-stats-grid{grid-template-columns:1fr;}.zs-types-grid{grid-template-columns:1fr;}}

  /* More Apps Recommendation section */
  .more-apps{background:var(--zs-white);border:1px solid var(--zs-border);border-radius:18px;padding:1.4rem 1.6rem 1.5rem;box-shadow:var(--zs-shadow-sm);position:relative;overflow:hidden;}
  .more-apps::before{content:"";position:absolute;top:0;right:0;width:300px;height:160px;background:radial-gradient(circle at 90% 0%,rgba(169,139,118,.07) 0%,transparent 60%);pointer-events:none;}
  .ma-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1.1rem;position:relative;z-index:1;}
  .ma-eyebrow{display:inline-flex;align-items:center;gap:7px;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--rose);margin-bottom:5px;}
  .ma-eyebrow::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--rose);box-shadow:0 0 0 3px var(--rose-soft);}
  .ma-title{font-family:var(--zs-font-display);font-size:20px;font-weight:600;color:var(--zs-dark);letter-spacing:-.015em;line-height:1.1;margin:0;}
  .ma-title em{font-style:italic;color:var(--rose);font-weight:500;}
  .ma-arrows{display:flex;gap:8px;flex-shrink:0;}
  .ma-arr{width:32px;height:32px;border-radius:9px;border:1px solid var(--zs-border);background:var(--zs-white);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--zs-dark);font-size:14px;transition:all .15s;font-family:inherit;}
  .ma-arr:hover:not(:disabled){border-color:var(--rose);color:var(--rose);transform:translateY(-1px);}
  .ma-arr:disabled{opacity:.35;cursor:not-allowed;}
  .ma-slider{overflow-x:auto;position:relative;z-index:1;scroll-behavior:smooth;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:12px 4px;margin:-12px -4px;}
  .ma-slider::-webkit-scrollbar {display:none;}
  .ma-track{display:flex;gap:12px;}
  .ma-card{flex:0 0 calc((100% - 24px) / 3);background:var(--zs-white);border:1px solid var(--zs-border);border-radius:12px;padding:.95rem 1rem 1rem;transition:transform .18s,box-shadow .18s,border-color .18s;position:relative;overflow:hidden;display:flex;flex-direction:column;}
  .ma-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--rose);transform:scaleY(0);transform-origin:bottom;transition:transform .22s;}
  .ma-card:hover{transform:translateY(-2px);box-shadow:var(--shadow-rose);border-color:transparent;}
  .ma-card:hover::before{transform:scaleY(1);}
  .ma-card-top{display:flex;align-items:center;gap:10px;margin-bottom:10px;}
  .ma-icon{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0;color:#fff;overflow:hidden;}
  .ma-icon.rose{background:linear-gradient(145deg,#c2426a,#8e3a52);box-shadow:0 3px 10px rgba(185,55,94,.24);}
  .ma-icon.gold{background:linear-gradient(145deg,#c8a86e,#9a7840);box-shadow:0 3px 10px rgba(190,154,96,.24);}
  .ma-icon.sage{background:linear-gradient(145deg,#8aa86a,#5f7e42);box-shadow:0 3px 10px rgba(127,160,90,.24);}
  .ma-icon.dark{background:linear-gradient(145deg,#4a4441,#2a2422);}
  .ma-icon.plum{background:linear-gradient(145deg,#7a5a8a,#4f3a5e);box-shadow:0 3px 10px rgba(120,90,140,.24);}
  .ma-icon img{width:100%;height:100%;object-fit:cover;border-radius:inherit;}
  .ma-name-wrap{flex:1;min-width:0;}
  .ma-name{font-family:var(--zs-font-display);font-size:14px;font-weight:600;color:var(--zs-dark);line-height:1.2;letter-spacing:-.005em;}
  .ma-cat{font-size:10px;color:var(--zs-muted);font-weight:600;margin-top:2px;text-transform:uppercase;letter-spacing:.5px;}
  .ma-desc{font-size:12.5px;color:var(--zs-muted);line-height:1.5;margin-bottom:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
  .ma-card-bottom{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:10px;border-top:1px solid var(--zs-border);}
  .ma-pill{font-size:10.5px;font-weight:700;color:#3a4a28;background:var(--zs-sage-soft);padding:4px 10px;border-radius:20px;letter-spacing:.2px;white-space:nowrap;}
  .ma-cta{font-size:12px;font-weight:600;color:var(--rose);text-decoration:none;display:inline-flex;align-items:center;gap:4px;padding:5px 11px;border:1px solid var(--rose-soft);border-radius:18px;background:var(--zs-white);transition:all .15s;white-space:nowrap;}
  .ma-cta:hover{background:var(--rose);color:#fff;border-color:var(--rose);}
  .ma-cta-arr{font-size:13px;line-height:1;transition:transform .15s;}
  .ma-cta:hover .ma-cta-arr{transform:translateX(2px);}
  @media(max-width:860px){.ma-card{flex:0 0 calc((100% - 12px) / 2);}}
  @media(max-width:560px){.ma-card{flex:0 0 100%;}}

  /* ── Feedback CTA banner ─────────────────────────────────────────────── */
  .zs-fb-banner{display:flex;align-items:center;gap:20px;background:var(--zs-white);border:1px solid var(--zs-border);border-radius:var(--zs-r-lg);padding:1.5rem 3rem 1.5rem 1.8rem;box-shadow:var(--zs-shadow-sm);position:relative;overflow:hidden;}
  .zs-fb-banner-close{position:absolute;top:12px;right:12px;z-index:2;width:28px;height:28px;border-radius:8px;border:none;background:transparent;color:var(--zs-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s;}
  .zs-fb-banner-close:hover{background:var(--zs-bg);color:var(--zs-dark);}
  .zs-fb-banner::before{content:"";position:absolute;top:0;right:0;width:340px;height:100%;background:radial-gradient(circle at 100% 0%,rgba(226,158,73,.10) 0%,transparent 62%);pointer-events:none;}
  .zs-fb-icon{width:58px;height:58px;border-radius:16px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(150deg,var(--zs-camel),var(--zs-clay-deep));box-shadow:0 8px 22px rgba(169,139,118,.32);}
  .zs-fb-copy{flex:1;min-width:0;position:relative;z-index:1;}
  .zs-fb-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:var(--zs-clay);margin-bottom:5px;}
  .zs-fb-title{font-family:var(--zs-font-display);font-size:20px;font-weight:600;color:var(--zs-dark);letter-spacing:-.01em;margin:0 0 4px;}
  .zs-fb-sub{font-size:13px;color:var(--zs-muted);line-height:1.55;margin:0;max-width:560px;}
  .zs-fb-cta{flex-shrink:0;position:relative;z-index:1;background:var(--zs-clay);color:#fff;border:none;padding:12px 22px;border-radius:var(--zs-r-sm);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:8px;box-shadow:var(--zs-shadow-clay);transition:transform .18s,box-shadow .18s,background .18s;}
  .zs-fb-cta:hover{transform:translateY(-2px);background:var(--zs-clay-deep);box-shadow:0 14px 36px rgba(169,139,118,.40);}
  @media(max-width:640px){.zs-fb-banner{flex-direction:column;align-items:flex-start;text-align:left;}.zs-fb-cta{width:100%;justify-content:center;}}

  /* ── Feedback modal ──────────────────────────────────────────────────── */
  .zs-fb-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(34,29,24,.52);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:1.25rem;animation:zsFbFade .2s ease forwards;}
  @keyframes zsFbFade{from{opacity:0;}to{opacity:1;}}
  @keyframes zsFbPop{from{opacity:0;transform:translateY(12px) scale(.97);}to{opacity:1;transform:translateY(0) scale(1);}}
  .zs-fb-modal{background:var(--zs-white);border-radius:var(--zs-r-lg);box-shadow:0 30px 80px rgba(34,29,24,.35);width:100%;max-width:440px;padding:2rem 2rem 1.8rem;position:relative;animation:zsFbPop .28s cubic-bezier(.2,.7,.2,1) forwards;font-family:var(--zs-font-body);}
  .zs-fb-close{position:absolute;top:16px;right:16px;width:30px;height:30px;border-radius:8px;border:none;background:transparent;color:var(--zs-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s;}
  .zs-fb-close:hover{background:var(--zs-bg);color:var(--zs-dark);}
  .zs-fb-modal-title{font-family:var(--zs-font-display);font-size:21px;font-weight:600;color:var(--zs-dark);letter-spacing:-.01em;margin:0 0 6px;padding-right:28px;}
  .zs-fb-modal-sub{font-size:13.5px;color:var(--zs-muted);line-height:1.55;margin:0 0 20px;}
  .zs-stars{display:flex;gap:8px;justify-content:center;margin:6px 0 18px;}
  .zs-star-btn{background:none;border:none;cursor:pointer;padding:4px;line-height:0;color:var(--zs-border);transition:transform .12s,color .12s;}
  .zs-star-btn:hover{transform:scale(1.14);}
  .zs-star-btn.on{color:#e29e49;}
  .zs-fb-textarea{width:100%;box-sizing:border-box;min-height:120px;resize:vertical;border:1.5px solid var(--zs-border);border-radius:var(--zs-r-md);padding:13px 15px;font-family:inherit;font-size:14px;color:var(--zs-dark);background:var(--zs-bg);transition:border-color .15s,box-shadow .15s;margin-bottom:16px;}
  .zs-fb-textarea:focus{outline:none;border-color:var(--zs-clay);box-shadow:0 0 0 3px var(--zs-clay-soft);background:var(--zs-white);}
  .zs-fb-actions{display:flex;gap:10px;justify-content:flex-end;align-items:center;}
  .zs-fb-btn{padding:11px 20px;border-radius:var(--zs-r-sm);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;border:none;transition:transform .15s,background .15s,box-shadow .15s,opacity .15s;display:inline-flex;align-items:center;gap:7px;text-decoration:none;}
  .zs-fb-btn.primary{background:var(--zs-clay);color:#fff;box-shadow:var(--zs-shadow-clay);}
  .zs-fb-btn.primary:hover{transform:translateY(-2px);background:var(--zs-clay-deep);}
  .zs-fb-btn.primary:disabled{opacity:.55;cursor:not-allowed;transform:none;box-shadow:none;}
  .zs-fb-btn.ghost{background:transparent;color:var(--zs-muted);border:1px solid var(--zs-border);}
  .zs-fb-btn.ghost:hover{border-color:var(--zs-camel);color:var(--zs-dark);}
  .zs-fb-celebrate{width:64px;height:64px;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(150deg,var(--zs-camel),var(--zs-clay-deep));box-shadow:0 10px 28px rgba(169,139,118,.35);}
  .zs-fb-center{text-align:center;}
  .zs-fb-thanks-ico{width:56px;height:56px;border-radius:50%;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;color:var(--zs-sage-deep);background:var(--zs-sage-soft);}
`;

// ─── Decorative flowing dot-wave for the hero (right side) ────────────────────
const HERO_WAVE_W = 1100;
const HERO_WAVE_H = 430;
const heroWaveDots = (() => {
  const dots = [];
  const strands = 38;   // flow lines top → bottom
  const cols = 92;      // dots per line left → right
  for (let s = 0; s < strands; s++) {
    const t = s / (strands - 1);               // 0 (top) → 1 (bottom)
    const baseY = 12 + t * (HERO_WAVE_H - 24);
    for (let c = 0; c < cols; c++) {
      const tx = c / (cols - 1);               // 0 (left) → 1 (right)
      const x = tx * HERO_WAVE_W;
      const ridge = Math.exp(-Math.pow((tx - 0.72) / 0.18, 2)) * 54;
      const trough = Math.exp(-Math.pow((tx - 0.9) / 0.16, 2)) * 44;
      const amp = 12 + tx * 46 + ridge;
      const y =
        baseY +
        Math.sin(tx * Math.PI * 2.55 + s * 0.4) * amp +
        Math.sin(tx * Math.PI * 5.8 + s * 0.23) * amp * 0.22 -
        ridge * (0.8 - t) +
        trough * t;
      const focus = Math.exp(-Math.pow((tx - 0.86) / 0.22, 2)) * (0.95 - t * 0.34);
      const glow = Math.pow(tx, 1.25) * (0.32 + focus);
      dots.push({
        x: +x.toFixed(1),
        y: +y.toFixed(1),
        r: +(0.62 + glow * 1.2).toFixed(2),
        o: +(0.045 + glow * 0.72).toFixed(3),
      });
    }
  }
  return dots;
})();

function HeroWave() {
  return (
    <div className="zs-hero-wave" aria-hidden="true">
      <svg viewBox={`0 0 ${HERO_WAVE_W} ${HERO_WAVE_H}`} preserveAspectRatio="xMidYMid slice">
        {heroWaveDots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={d.r} fill="#E9C896" opacity={d.o} />
        ))}
      </svg>
    </div>
  );
}

const RECOMMENDED_APPS = [
  {
    name: "ZS Smart Content AI",
    category: "Marketing",
    description: "Generate high-quality product descriptions, SEO copy, and ad texts with AI straight from your Shopify admin.",
    link: "https://apps.shopify.com/zs-smart-content-ai",
    icon: "https://cdn.shopify.com/s/files/1/1013/3821/8865/files/ZS_Smart_Content_Logo.png?v=1780889058",
    colorClass: "rose",
    badge: "Free plan available",
  },
  {
    name: "ZS Sections: Theme Sections",
    category: "Store Design",
    description: "Drag and drop professionally designed, high-converting theme sections onto your store without any coding.",
    link: "https://apps.shopify.com/zs-sections",
    icon: "https://cdn.shopify.com/s/files/1/0639/6657/6725/files/ZS_sections_app_icon_5.png?v=1778330085",
    colorClass: "gold",
    badge: "Free plan available",
  },
  {
    name: "ZS Bundles App & Upsells",
    category: "Upsell & AOV",
    description: "Increase average order value with product bundles, volume discounts, and smart cart upsell recommendations.",
    link: "https://apps.shopify.com/zs-bundles",
    icon: "https://cdn.shopify.com/s/files/1/0813/8879/8190/files/favicon_84dd8a2f-dd90-4da4-8e40-4c9302f68cc5.png?v=1781849995",
    colorClass: "sage",
    badge: "Free plan available",
  },
  {
    name: "ZS B2B Gateway",
    category: "B2B & Wholesale",
    description: "Build professional wholesale signup forms and restrict access to specific pages or products based on tags.",
    link: "https://apps.shopify.com/zs-b2b-gateway",
    icon: "https://cdn.shopify.com/s/files/1/0827/7481/9064/files/b2b_1.png?v=1779244866",
    colorClass: "dark",
    badge: "Free trial available",
  },
  {
    name: "ZS Wishlist",
    category: "Conversion",
    description: "Enable guest and customer wishlists, sending automated reminders for price drops and back-in-stock items.",
    link: "https://apps.shopify.com/zs-wishlist",
    icon: "https://cdn.shopify.com/s/files/1/0768/2369/1419/files/imgi_1_favicon.png?v=1781845297",
    colorClass: "rose",
    badge: "Free plan available",
  },
  {
    name: "ZS Spin View",
    category: "Product 3D & 360",
    description: "Convert more visitors with interactive 360-degree product spins generated automatically using AI.",
    link: "https://apps.shopify.com/zs-spin-view",
    icon: "https://cdn.shopify.com/app-store/listing_images/9a4e12c15d721c7f7a030cf4b67e5756/icon/CK7TjLuH1pQDEAE=.png",
    colorClass: "plum",
    badge: "Free plan available",
  },
];

// ─── Star row ─────────────────────────────────────────────────────────────────
// Module-level so it keeps a stable identity across renders (defining it inside
// the modal would remount it on every hover and drop the hover state).
// eslint-disable-next-line react/prop-types
function StarRow({ value, hover, onPick, onHover, interactive }) {
  return (
    <div className="zs-stars" onMouseLeave={interactive ? () => onHover(0) : undefined}>
      {[1, 2, 3, 4, 5].map((n) => {
        const active = (interactive ? hover || value : value) >= n;
        return (
          <button
            key={n}
            type="button"
            className={`zs-star-btn${active ? " on" : ""}`}
            onClick={interactive ? () => onPick(n) : undefined}
            onMouseEnter={interactive ? () => onHover(n) : undefined}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            disabled={!interactive}
          >
            <Star size={30} fill={active ? "#e29e49" : "none"} strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}

// ─── Feedback rating modal ────────────────────────────────────────────────────
// Flow: pick stars → 1-3 asks for a written note that we email to the team;
// 4-5 invites the merchant to leave a public App Store review.
// eslint-disable-next-line react/prop-types
function FeedbackModal({ onClose }) {
  const fetcher = useFetcher();
  const [step, setStep] = useState("rate"); // rate | write | rock | thanks
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [message, setMessage] = useState("");

  const submitting = fetcher.state !== "idle";

  // Advance to the thank-you screen once a written submission succeeds.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && step === "write") {
      setStep("thanks");
    }
  }, [fetcher.state, fetcher.data, step]);

  // Close on Escape for keyboard users.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock background scroll while the modal is open.
  useEffect(() => {
    const { body, documentElement: html } = document;
    const prevBody = body.style.overflow;
    const prevHtml = html.style.overflow;
    body.style.overflow = "hidden";
    html.style.overflow = "hidden";
    return () => {
      body.style.overflow = prevBody;
      html.style.overflow = prevHtml;
    };
  }, []);

  const pickRating = (n) => {
    setRating(n);
    setStep(n <= 3 ? "write" : "rock");
  };

  const sendWritten = () => {
    fetcher.submit(
      { intent: "feedback", rating: String(rating), message },
      { method: "post" },
    );
  };

  const shareOnAppStore = () => {
    window.open(APP_STORE_REVIEW_URL, "_blank", "noopener,noreferrer");
    onClose();
  };

  return (
    // Backdrop click-to-close is a convenience; Escape and the ✕ button provide
    // the keyboard-accessible paths.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <div
      className="zs-fb-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Share your feedback"
    >
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div className="zs-fb-modal" onClick={(e) => e.stopPropagation()}>
        <button className="zs-fb-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>

        {step === "rate" && (
          <>
            <h3 className="zs-fb-modal-title">What do you think of ZS StoreSync?</h3>
            <p className="zs-fb-modal-sub">
              Your rating helps us keep improving. It only takes a moment.
            </p>
            <StarRow
              value={rating}
              hover={hover}
              onPick={pickRating}
              onHover={setHover}
              interactive
            />
          </>
        )}

        {step === "write" && (
          <>
            <h3 className="zs-fb-modal-title">Help us do better</h3>
            <p className="zs-fb-modal-sub">
              Sorry it&apos;s not a 5-star experience yet. Tell us what went wrong
              or what&apos;s missing — it goes straight to our team.
            </p>
            <StarRow value={rating} interactive={false} />
            <textarea
              className="zs-fb-textarea"
              placeholder="Write your feedback…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              // Focusing the note field on open is expected in a modal context.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            <div className="zs-fb-actions">
              <button className="zs-fb-btn ghost" onClick={onClose} type="button">
                Cancel
              </button>
              <button
                className="zs-fb-btn primary"
                onClick={sendWritten}
                disabled={submitting || message.trim().length === 0}
                type="button"
              >
                {submitting ? "Sending…" : "Send feedback"}
              </button>
            </div>
          </>
        )}

        {step === "rock" && (
          <div className="zs-fb-center">
            <div className="zs-fb-celebrate">
              <PartyPopper size={30} />
            </div>
            <h3 className="zs-fb-modal-title" style={{ paddingRight: 0 }}>
              You rock! 🎉
            </h3>
            <p className="zs-fb-modal-sub">
              It&apos;s awesome to see you succeed with ZS StoreSync. Just one
              click to share a quick review on the Shopify App Store — a small
              click for you, a big leap for us.
            </p>
            <div className="zs-fb-actions" style={{ justifyContent: "center" }}>
              <button className="zs-fb-btn ghost" onClick={onClose} type="button">
                Maybe later
              </button>
              <button className="zs-fb-btn primary" onClick={shareOnAppStore} type="button">
                Yes, share on App Store
              </button>
            </div>
          </div>
        )}

        {step === "thanks" && (
          <div className="zs-fb-center">
            <div className="zs-fb-thanks-ico">
              <MessageSquareHeart size={26} />
            </div>
            <h3 className="zs-fb-modal-title" style={{ paddingRight: 0 }}>
              Thank you!
            </h3>
            <p className="zs-fb-modal-sub">
              We&apos;ve received your feedback and our team will take a close
              look. We appreciate you helping us improve.
            </p>
            <div className="zs-fb-actions" style={{ justifyContent: "center" }}>
              <button className="zs-fb-btn primary" onClick={onClose} type="button">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Index() {
  const { stats, plan, jobs } = useLoaderData();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Session-only dismissal — the banner returns on the next page load.
  const [feedbackDismissed, setFeedbackDismissed] = useState(false);

  const sliderRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const checkScrollLimits = () => {
    if (sliderRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = sliderRef.current;
      setCanScrollLeft(scrollLeft > 1);
      setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
    }
  };

  useEffect(() => {
    const container = sliderRef.current;
    if (container) {
      container.addEventListener("scroll", checkScrollLimits);
      checkScrollLimits();
      window.addEventListener("resize", checkScrollLimits);
    }
    return () => {
      if (container) {
        container.removeEventListener("scroll", checkScrollLimits);
      }
      window.removeEventListener("resize", checkScrollLimits);
    };
  }, []);

  const handleSliderScroll = (direction) => {
    if (sliderRef.current) {
      const container = sliderRef.current;
      const card = container.querySelector(".ma-card");
      if (card) {
        const cardWidth = card.getBoundingClientRect().width;
        const gap = 12;
        const scrollAmount = cardWidth + gap;
        container.scrollBy({
          left: direction === "left" ? -scrollAmount : scrollAmount,
          behavior: "smooth"
        });
      }
    }
  };

  const statCards = [
    { icon: <ArrowLeftRight size={18} />, cls: "clay", label: "Total Migrations", value: stats.totalJobs },
    { icon: <Boxes size={18} />, cls: "camel", label: "Items Migrated", value: Number(stats.itemsMigrated).toLocaleString() },
    { icon: <Zap size={18} />, cls: "sage", label: "Used This Month", value: `${stats.monthlyUsed}/${stats.monthlyLimit}` },
    { icon: <ShieldCheck size={18} />, cls: "cream", label: "Last Run", value: stats.lastRun },
  ];

  const dataTypes = [
    { icon: <Package size={18} />, name: "Products", sub: "Variants & images" },
    { icon: <Layers size={18} />, name: "Collections", sub: "Smart & manual" },
    { icon: <FileText size={18} />, name: "Pages", sub: "Content pages" },
    { icon: <Percent size={18} />, name: "Discounts", sub: "Codes & automatic" },
    { icon: <Image size={18} />, name: "Files", sub: "Media library" },
    { icon: <Menu size={18} />, name: "Menus", sub: "Navigation" },
    { icon: <Shuffle size={18} />, name: "Redirects", sub: "URL redirects" },
    { icon: <Boxes size={18} />, name: "Metaobjects", sub: "Definitions & entries" },
    { icon: <Newspaper size={18} />, name: "Blog Posts", sub: "Blogs & articles" },
    { icon: <Tag size={18} />, name: "Metafields", sub: "On products & more" },
    { icon: <ShoppingCart size={18} />, name: "Orders", sub: "Incl. drafts · Protected data" },
    { icon: <Users size={18} />, name: "Customers", sub: "Protected data" },
  ];

  const featureCards = [
    { icon: <ArrowLeftRight size={26} />, cls: "clay", title: "New Migration", desc: "Connect a source store and copy products, collections, pages, files & metafields into this store — duplicates skipped automatically.", href: "/app/migrate", meta: "Store → Store · No data stored on our servers" },
    { icon: <Zap size={26} />, cls: "camel", title: "Sync Changes", desc: "Already migrated before? Pull only what's new since last time — added products, no re-runs of everything.", href: "/app/sync", meta: "Smart delta · Matches by SKU & handle" },
    { icon: <PlayCircle size={26} />, cls: "sage", title: "Preview & Compare", desc: "See exactly what will transfer before you run it. Compare source vs target counts at a glance.", href: "/app/preview", meta: "Dry run · Zero changes to your store" },
  ];

  const planMeters = [
    { label: "Items this month", value: `${plan.monthlyUsed} / ${plan.monthlyLimit}`, pct: plan.monthlyPct },
  ];

  const upgradeCta =
    plan.current === "free" ? "Upgrade to Starter — $12.99" :
    plan.current === "starter" ? "Upgrade to Growth — $24.99" :
    plan.current === "growth" ? "Upgrade to Pro — $39.99" : "Manage Plan";

  const typeIcon = (t) => ({
    products:<Package size={17}/>,collections:<Layers size={17}/>,pages:<FileText size={17}/>,
    files:<Image size={17}/>,orders:<ShoppingCart size={17}/>,customers:<Users size={17}/>,
    metaobjects:<Boxes size={17}/>,metafields:<Tag size={17}/>,discounts:<Percent size={17}/>,
    menus:<Menu size={17}/>,redirects:<Shuffle size={17}/>,blogPosts:<Newspaper size={17}/>,
  }[t] || <ArrowLeftRight size={17}/>);

  return (
    <s-page heading="ZS StoreSync">
      <style dangerouslySetInnerHTML={{ __html: brandStyles + pageStyles }} />
      <div className="zs-section-wrap">
        <div className="zs-root">
          <div className="zs-wrap zs-stack">

            <div className="zs-hero zs-reveal zs-d1">
              <HeroWave />
              <div className="zs-hero-left">
                <span className="zs-hero-chip"><span className="zs-hero-chip-dot" />Store → Store · Nothing stored on our servers</span>
                <h1>Move your store&apos;s <em>content</em>,<br />store to store.</h1>
                <p className="zs-hero-lead">Copy products, collections, pages, discounts, files, menus, redirects, blog posts, metaobjects & metafields from one Shopify store into another — duplicates skipped, changes synced, no spreadsheets, no developer.</p>
                <div className="zs-hero-btns">
                  <RouterLink to="/app/migrate" className="zs-btn-primary">Start a Migration <span>→</span></RouterLink>
                  <RouterLink to="/app/preview" className="zs-btn-ghost-white">Preview First</RouterLink>
                </div>
              </div>
            </div>

            <div className="zs-reveal zs-d2">
              <div className="zs-sec-head"><div><div className="zs-sec-eyebrow">Overview</div><h2 className="zs-sec-title">Migration Activity</h2></div></div>
              <div className="zs-stats-grid">
                {statCards.map(({ icon, cls, label, value }) => (
                  <div key={label} className="zs-stat">
                    <div className={`zs-stat-icon ${cls}`}>{icon}</div>
                    <div className="zs-stat-body"><div className="zs-stat-value">{value}</div><div className="zs-stat-label">{label}</div></div>
                  </div>
                ))}
              </div>
            </div>

            <div className="zs-reveal zs-d3">
              <div className="zs-sec-head">
                <div><div className="zs-sec-eyebrow">Supported Data</div><h2 className="zs-sec-title">What StoreSync Moves</h2></div>
                <RouterLink to="/app/plan" className="zs-sec-link">See plans →</RouterLink>
              </div>
              <div className="zs-types-grid">
                {dataTypes.map(({ icon, name, sub }) => (
                  <div key={name} className="zs-type">
                    <div className="zs-type-icon">{icon}</div>
                    <div><div className="zs-type-name">{name}</div><div className="zs-type-sub">{sub}</div></div>
                  </div>
                ))}
              </div>
            </div>

            <div className="zs-reveal zs-d4">
              <div className="zs-sec-head"><div><div className="zs-sec-eyebrow">Get Started</div><h2 className="zs-sec-title">Run a Transfer</h2></div></div>
              <div className="zs-nav-grid">
                {featureCards.map(({ icon, cls, title, desc, href, meta }) => (
                  <RouterLink key={href} to={href} className="zs-nav-card">
                    <div className="zs-nav-card-top"><div className={`zs-nav-card-icon ${cls}`}>{icon}</div><span className="zs-nav-card-arrow">→</span></div>
                    <div className="zs-nav-card-title">{title}</div>
                    <div className="zs-nav-card-desc">{desc}</div>
                    <div className="zs-nav-card-meta">{meta}</div>
                  </RouterLink>
                ))}
              </div>
            </div>

            <div className="zs-split zs-reveal zs-d5">
              <div className="zs-panel">
                <div className="zs-sec-head">
                  <div><div className="zs-sec-eyebrow">Activity</div><h2 className="zs-sec-title">Recent Migrations</h2></div>
                  <RouterLink to="/app/history" className="zs-sec-link">View all →</RouterLink>
                </div>
                {jobs.length === 0 ? (
                  <div className="zs-empty">
                    <div className="zs-empty-icon"><ArrowLeftRight size={34} /></div>
                    <div className="zs-empty-title">No migrations yet</div>
                    <div className="zs-empty-sub">Start your first transfer using the options above.</div>
                  </div>
                ) : (
                  jobs.slice(0, 5).map((j) => (
                    <div key={j.id} className="zs-recent-item">
                      <div className="zs-recent-left">
                        <div className="zs-recent-icon">{typeIcon(j.type)}</div>
                        <div>
                          <div className="zs-recent-name">{j.type}<span className="zs-route">· <b>{j.source}</b> → <b>{j.target}</b></span></div>
                          <div className="zs-recent-sub">{j.summary}</div>
                        </div>
                      </div>
                      <span
                        className={
                          j.status === "running"
                            ? "zs-badge-run"
                            : j.status === "failed"
                              ? "zs-badge-fail"
                              : "zs-badge-done"
                        }
                      >
                        {j.status === "running"
                          ? "Running"
                          : j.status === "failed"
                            ? "Failed"
                            : j.status === "partial"
                              ? "Partial"
                              : "Done"}
                      </span>
                    </div>
                  ))
                )}
              </div>

              <div className="zs-plan-card">
                <div className="zs-plan-inner">
                  <div className="zs-plan-eyebrow">Current Plan</div>
                  <div className="zs-plan-name">{plan.name}</div>
                  <div className="zs-plan-desc">Monthly item quota. Upgrade for higher limits, files, orders & customers. Cancel anytime.</div>
                  <div className="zs-plan-meters">
                    {planMeters.map(({ label, value, pct }) => (
                      <div key={label}>
                        <div className="zs-plan-meter-row"><span className="zs-plan-meter-label">{label}</span><span className="zs-plan-meter-value">{value}</span></div>
                        <div className="zs-plan-meter-bar"><div className="zs-plan-meter-fill" style={{ width: `${pct}%` }} /></div>
                      </div>
                    ))}
                  </div>
                  <RouterLink to="/app/plan" className="zs-plan-upgrade-btn">{upgradeCta}</RouterLink>
                  <div className="zs-plan-upgrade-note">Cancel anytime · No commitment</div>
                </div>
              </div>
            </div>

            <div className="zs-reveal zs-d6">
              <div className="zs-sec-head"><div><div className="zs-sec-eyebrow">Learn</div><h2 className="zs-sec-title">Resources &amp; Support</h2></div></div>
              <div className="zs-resources-grid">
                <a href="https://zs-storesync.zilancer.com/tutorials" target="_blank" rel="noreferrer" className="zs-video-card">
                  <div className="zs-video-play"><PlayCircle size={26} /></div>
                  <div className="zs-video-info">
                    <span className="zs-video-tag">Quick Start</span>
                    <div className="zs-video-title">Your First Store-to-Store Migration</div>
                    <div className="zs-video-sub">5 min · Connect, preview, and run a full transfer</div>
                  </div>
                </a>
                <div className="zs-link-card">
                  <div className="zs-link-card-title"><BookOpen size={14} /> Documentation</div>
                  {[
                    { icon:<HelpCircle size={13}/>, label:"Setup Guide", href:"https://zs-storesync.zilancer.com/documentation" },
                    { icon:<HelpCircle size={13}/>, label:"How Sync Works", href:"https://zs-storesync.zilancer.com/documentation" },
                    { icon:<HelpCircle size={13}/>, label:"FAQ", href:"https://zs-storesync.zilancer.com/faq" },
                  ].map(({ icon, label, href }) => (
                    <a key={label} href={href} target="_blank" rel="noreferrer" className="zs-res-link">
                      <span style={{display:"inline-flex",alignItems:"center",gap:"6px"}}>{icon} {label}</span><span>→</span>
                    </a>
                  ))}
                </div>
                <div className="zs-link-card">
                  <div className="zs-link-card-title"><Mail size={14} /> Support &amp; Updates</div>
                  {[
                    { icon:<Mail size={13}/>, label:"Email Support", href:"mailto:contact@zilancer.com", mail:true },
                    { icon:<Rocket size={13}/>, label:"Changelog", href:"https://zs-storesync.zilancer.com/changelog" },
                  ].map(({ icon, label, href, mail }) =>
                    mail ? (
                      <a key={label} href={href} className="zs-res-link" target="_top">
                        <span style={{display:"inline-flex",alignItems:"center",gap:"6px"}}>{icon} {label}</span><span>→</span>
                      </a>
                    ) : (
                      <a key={label} href={href} target="_blank" rel="noreferrer" className="zs-res-link">
                        <span style={{display:"inline-flex",alignItems:"center",gap:"6px"}}>{icon} {label}</span><span>→</span>
                      </a>
                    )
                  )}
                </div>
              </div>
            </div>

            {!feedbackDismissed && (
              <div className="zs-reveal zs-d7">
                <div className="zs-fb-banner">
                  <button
                    className="zs-fb-banner-close"
                    type="button"
                    onClick={() => setFeedbackDismissed(true)}
                    aria-label="Dismiss feedback"
                  >
                    <X size={16} />
                  </button>
                  <div className="zs-fb-icon"><MessageSquareHeart size={28} /></div>
                  <div className="zs-fb-copy">
                    <div className="zs-fb-eyebrow">Your opinion matters</div>
                    <h2 className="zs-fb-title">Enjoying ZS StoreSync?</h2>
                    <p className="zs-fb-sub">
                      We value your opinion — it helps us evaluate our performance and
                      make sure we&apos;re meeting your expectations. Share a quick rating
                      and let us know how we&apos;re doing.
                    </p>
                  </div>
                  <button
                    className="zs-fb-cta"
                    type="button"
                    onClick={() => setFeedbackOpen(true)}
                  >
                    <Star size={16} /> Give feedback
                  </button>
                </div>
              </div>
            )}

            <div className="zs-reveal zs-d7">
              <section className="more-apps">
                <div className="ma-head">
                  <div>
                    <div className="ma-eyebrow">From the Zilancer Studio</div>
                    <h2 className="ma-title">More apps to <em>grow your store</em></h2>
                  </div>
                  <div className="ma-arrows">
                    <button
                      className="ma-arr"
                      onClick={() => handleSliderScroll("left")}
                      disabled={!canScrollLeft}
                      aria-label="Previous"
                    >
                      ‹
                    </button>
                    <button
                      className="ma-arr"
                      onClick={() => handleSliderScroll("right")}
                      disabled={!canScrollRight}
                      aria-label="Next"
                    >
                      ›
                    </button>
                  </div>
                </div>

                <div className="ma-slider" ref={sliderRef}>
                  <div className="ma-track">
                    {RECOMMENDED_APPS.map((app) => (
                      <div key={app.name} className="ma-card">
                        <div className="ma-card-top">
                          <div className={`ma-icon ${app.colorClass}`}>
                            <img src={app.icon} alt={app.name} />
                          </div>
                          <div className="ma-name-wrap">
                            <div className="ma-name">{app.name}</div>
                            <div className="ma-cat">{app.category}</div>
                          </div>
                        </div>
                        <p className="ma-desc">{app.description}</p>
                        <div className="ma-card-bottom">
                          <span className="ma-pill">{app.badge}</span>
                          <a
                            href={app.link}
                            target="_blank"
                            rel="noreferrer"
                            className="ma-cta"
                          >
                            Learn more <span className="ma-cta-arr">&rarr;</span>
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </div>

          </div>

          {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
