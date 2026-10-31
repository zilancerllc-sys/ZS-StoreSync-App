// Lists every English string the UI can show, so the dictionaries in
// app/i18n/*.json can be checked for gaps:
//
//   node scripts/i18n-extract.mjs            → missing keys per language
//   node scripts/i18n-extract.mjs --keys     → all keys, one JSON array
//
// Collected: literal first arguments of t("…"), plus string values the UI
// passes through t() indirectly — action errors, schedule notices, and the
// label tables (plan names, data types, days, cadences, FAQ copy).
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
const SOURCES = [
  "app/routes",
  "app/components",
  "app/schedules.server.js",
  "app/schedule-config.js",
  "app/credits.server.js",
  "app/undo.server.js",
  "app/instant-sync.server.js",
  "app/lib/affiliate.server.js",
  "app/routes/webhooks.app.uninstalled.jsx",
];

function files(p) {
  const abs = path.join(ROOT, p);
  if (fs.statSync(abs).isFile()) return [abs];
  return fs
    .readdirSync(abs)
    .filter((f) => /\.(jsx?|mjs)$/.test(f))
    .map((f) => path.join(abs, f));
}

const unescape = (s) => s.replace(/\\(["'\\])/g, "$1");
const keys = new Set();

for (const file of [...new Set(SOURCES.flatMap(files))]) {
  const src = fs.readFileSync(file, "utf8");

  for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(unescape(m[1]));

  // Messages that reach the screen without a literal t("…") at the call site.
  for (const m of src.matchAll(
    /\b(?:error|lastError|tagline|featureLabel|badge|q|a|text|name|label)\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"/g,
  )) {
    const s = unescape(m[1]);
    if (/^[A-Z★].*[a-z]/.test(s) && !/^https?:|^[A-Z_]+$/.test(s)) keys.add(s);
  }

  // Label tables: { key: "Label" } and ["Sunday", …]
  for (const block of src.matchAll(
    /(?:FREQUENCY_LABEL|PLAN_LABEL|TYPE_LABEL|STATUS_LABEL|MODE_LABEL|PLAN_NAME)\s*=\s*\{([\s\S]*?)\};/g,
  )) {
    for (const m of block[1].matchAll(/:\s*"([^"]+)"/g)) keys.add(m[1]);
  }
  for (const block of src.matchAll(/DAYS\s*=\s*\[([^\]]*)\]/g)) {
    for (const m of block[1].matchAll(/"([^"]+)"/g)) keys.add(m[1]);
  }
}

const all = [...keys].sort();

if (process.argv.includes("--keys")) {
  console.log(JSON.stringify(all, null, 2));
} else {
  const dir = path.join(ROOT, "app/i18n");
  let missingTotal = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const dict = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const missing = all.filter((k) => !dict[k]);
    const stale = Object.keys(dict).filter((k) => !keys.has(k));
    // A translation must keep exactly the key's {placeholders}, or values and
    // bold fragments silently vanish from the sentence.
    const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    const broken = Object.entries(dict).filter(([k, v]) => holes(k) !== holes(v));
    missingTotal += missing.length + broken.length;
    console.log(
      `${f}: ${all.length - missing.length}/${all.length} translated, ${stale.length} unused, ${broken.length} placeholder mismatches`,
    );
    for (const k of missing.slice(0, 5)) console.log(`   missing: ${k.slice(0, 80)}`);
    for (const k of stale.slice(0, 5)) console.log(`   unused: ${k.slice(0, 80)}`);
    for (const [k] of broken.slice(0, 5)) console.log(`   placeholders differ: ${k.slice(0, 80)}`);
  }
  process.exitCode = missingTotal ? 1 : 0;
}
