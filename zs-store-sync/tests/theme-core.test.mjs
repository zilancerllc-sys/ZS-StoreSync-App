import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync, crc32 } from "node:zlib";
import {
  isCustomizationFile,
  fileTooBig,
  themeReferences,
  appBlockHandles,
  isThemeApprovalError,
  buildZip,
  copyName,
} from "../app/lib/theme-core.js";

test("customization files of a Theme Store theme", () => {
  for (const f of ["templates/index.json", "templates/customers/account.json", "sections/header-group.json", "config/settings_data.json", "locales/en.default.json"]) {
    assert.equal(isCustomizationFile(f), true, f);
  }
  for (const f of ["sections/header.liquid", "assets/base.css", "layout/theme.liquid", "config/settings_schema.json", "snippets/x.liquid", "templates/page.liquid"]) {
    assert.equal(isCustomizationFile(f), false, f);
  }
});

test("Shopify size limits", () => {
  assert.equal(fileTooBig("assets/video.mp4", 21 * 1024 * 1024), "over Shopify's 20 MB asset limit");
  assert.equal(fileTooBig("assets/a.css", 1000), null);
  assert.equal(fileTooBig("sections/x.liquid", 300 * 1024), "over 256 KB");
  assert.equal(fileTooBig("templates/index.json", 600 * 1024), "over 512 KB");
  assert.equal(fileTooBig("config/settings_data.json", 1.4 * 1024 * 1024), null);
  assert.equal(fileTooBig("locales/de.json", 2 * 1024 * 1024), "over 1.5 MB");
});

test("references and app blocks are found", () => {
  const json = JSON.stringify({
    a: "shopify://products/red-shirt",
    b: "shopify://collections/sale",
    c: "shopify://shop_images/banner%20big.jpg",
    d: "shopify://linklists/main-menu",
    e: "shopify://products/red-shirt",
    f: { type: "shopify://apps/judge-me-reviews/blocks/review_widget/61cc-uuid" },
    g: { type: "shopify://apps/klaviyo/blocks/form/1" },
  });
  const refs = themeReferences(json);
  assert.equal(refs.length, 4);
  assert.deepEqual(refs.find((r) => r.kind === "shop_images"), { kind: "shop_images", handle: "banner big.jpg" });
  assert.deepEqual(appBlockHandles(json).sort(), ["judge-me-reviews", "klaviyo"]);
});

test("approval errors are told apart from real failures", () => {
  assert.equal(isThemeApprovalError("This action requires an exemption from Shopify"), true);
  assert.equal(isThemeApprovalError("GraphQL error: Access denied for themeCreate field. Required access: write_themes"), true);
  assert.equal(isThemeApprovalError("name: is too long"), false);
});

test("zip archive is well-formed and round-trips", () => {
  const files = [
    { name: "layout/theme.liquid", data: Buffer.from("<html>{{ content_for_layout }}</html>".repeat(20)) },
    { name: "assets/a.png", data: Buffer.from([1, 2, 3]) },
  ];
  const zip = buildZip(files);
  // end of central directory: 2 entries
  const end = zip.subarray(zip.length - 22);
  assert.equal(end.readUInt32LE(0), 0x06054b50);
  assert.equal(end.readUInt16LE(10), 2);
  // first entry decompresses to the original
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const method = zip.readUInt16LE(8);
  const compSize = zip.readUInt32LE(18);
  const nameLen = zip.readUInt16LE(26);
  const body = zip.subarray(30 + nameLen, 30 + nameLen + compSize);
  const out = method === 8 ? inflateRawSync(body) : body;
  assert.deepEqual(out, files[0].data);
  assert.equal(zip.readUInt32LE(14), crc32(files[0].data) >>> 0);
  assert.equal(zip.subarray(30, 30 + nameLen).toString(), "layout/theme.liquid");
});

test("theme names stay within 50 characters", () => {
  assert.equal(copyName("Dawn"), "Dawn (copy)");
  assert.ok(copyName("x".repeat(80)).length <= 50);
});
