// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — theme copy: the pure parts (unit-tested)
//
//  Rules (Shopify theme limits and licensing, checked 2026-11-15):
//    - a theme is always created UNPUBLISHED; the merchant previews and
//      publishes it themselves
//    - a Theme Store theme (themeStoreId set) is licensed per store: only the
//      merchant's customizations (templates, section groups, settings, locale
//      strings) are copied, onto a copy of the SAME theme already on the target
//    - a custom theme is copied whole, after the merchant confirms they own it
//      or have a licence for the target store
//    - files over Shopify's limits are skipped and listed
// ═════════════════════════════════════════════════════════════════════════════
import { Buffer } from "node:buffer";
import { deflateRawSync, crc32 } from "node:zlib";

export const LIMITS = {
  assetBytes: 20 * 1024 * 1024,
  liquidBytes: 256 * 1024,
  jsonBytes: 512 * 1024,
  settingsDataBytes: 1.5 * 1024 * 1024,
  localeBytes: 1.5 * 1024 * 1024,
  zipBytes: 50 * 1024 * 1024,
  upsertBatch: 50,
};

// Files that hold the merchant's customizations of a Theme Store theme.
export function isCustomizationFile(filename) {
  return (
    /^templates\/.+\.json$/.test(filename) ||
    /^templates\/customers\/.+\.json$/.test(filename) ||
    /^sections\/.+\.json$/.test(filename) ||
    filename === "config/settings_data.json" ||
    /^locales\/.+\.json$/.test(filename)
  );
}

// → null if the file may be copied, else the reason it can't.
export function fileTooBig(filename, size) {
  const n = Number(size) || 0;
  if (filename === "config/settings_data.json") return n > LIMITS.settingsDataBytes ? "over 1.5 MB" : null;
  if (filename.startsWith("locales/")) return n > LIMITS.localeBytes ? "over 1.5 MB" : null;
  if (filename.startsWith("assets/")) return n > LIMITS.assetBytes ? "over Shopify's 20 MB asset limit" : null;
  if (filename.endsWith(".json")) return n > LIMITS.jsonBytes ? "over 512 KB" : null;
  if (filename.endsWith(".liquid")) return n > LIMITS.liquidBytes ? "over 256 KB" : null;
  return null;
}

// What a theme file is pointing at, by handle — products, collections, pages,
// blogs, menus and Files images — so the copy can check they exist on the
// target. "shopify://products/red-shirt" etc. in JSON settings.
const REF_RE = /shopify:\/\/(products|collections|pages|blogs|shop_images|linklists)\/([^"\\\s]+)/g;
export function themeReferences(text) {
  const out = new Map();
  for (const m of String(text || "").matchAll(REF_RE)) {
    const key = `${m[1]}/${decodeURIComponent(m[2])}`;
    out.set(key, { kind: m[1], handle: decodeURIComponent(m[2]) });
  }
  return [...out.values()];
}

// App blocks / embeds only work when the same app is installed on the target.
// "shopify://apps/judge-me-reviews/blocks/review_widget/61ccd3b1-..." → "judge-me-reviews"
const APP_RE = /shopify:\/\/apps\/([^/"\\]+)\/blocks\//g;
export function appBlockHandles(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(APP_RE)) out.add(m[1]);
  return [...out];
}

// Until Shopify grants the write_themes exemption every theme write is
// refused; that must read as "waiting for approval", not as a broken app.
export function isThemeApprovalError(message) {
  return /exemption|write_themes|access denied|not approved|requires.*approval|ACCESS_DENIED|forbidden|not authorized/i.test(
    String(message || ""),
  );
}

// ── Minimal ZIP writer (deflate), enough for a theme archive ────────────────
// files: [{ name, data: Buffer }] → Buffer
export function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosTime = 0; // 00:00:00
  const dosDate = (1 << 5) | 1; // 1980-01-01
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const comp = deflateRawSync(raw);
    const useDeflate = comp.length < raw.length;
    const body = useDeflate ? comp : raw;
    const crc = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// Theme names are at most 50 characters on Shopify.
export function copyName(name) {
  const suffix = " (copy)";
  return `${String(name || "Theme").slice(0, 50 - suffix.length)}${suffix}`;
}
