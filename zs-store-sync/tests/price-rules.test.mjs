import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePriceRule,
  parsePriceRule,
  ruleIsActive,
  roundPrice,
  applyToAmount,
  priceFieldsFor,
  currencyDecimals,
  describePriceRule,
  DEFAULT_PRICE_RULE,
} from "../app/lib/price-rules.js";

const rule = (r) => normalizePriceRule({ enabled: true, ...r }).rule;

test("no rule or a disabled rule passes prices through untouched", () => {
  const v = { price: "10.00", compareAtPrice: null };
  assert.deepEqual(priceFieldsFor(v, null).fields, { price: "10.00", compareAtPrice: undefined });
  assert.deepEqual(priceFieldsFor(v, DEFAULT_PRICE_RULE).fields, { price: "10.00", compareAtPrice: undefined });
  const off = normalizePriceRule({ enabled: false, adjust: "percent", amount: 50 }).rule;
  assert.equal(ruleIsActive(off), false);
  assert.equal(priceFieldsFor({ price: "10.00", compareAtPrice: "12.00" }, off).fields.compareAtPrice, "12.00");
});

test("percentage markup and markdown", () => {
  assert.equal(applyToAmount("10.00", rule({ adjust: "percent", amount: 20 })).value, "12.00");
  assert.equal(applyToAmount("10.00", rule({ adjust: "percent", direction: "down", amount: 25 })).value, "7.50");
  assert.equal(applyToAmount("19.99", rule({ adjust: "percent", amount: 10 })).value, "21.99");
});

test("fixed markup and markdown, never 0 or below", () => {
  assert.equal(applyToAmount("10.00", rule({ adjust: "fixed", amount: 5 })).value, "15.00");
  assert.equal(applyToAmount("10.00", rule({ adjust: "fixed", direction: "down", amount: 3 })).value, "7.00");
  const r = applyToAmount("10.00", rule({ adjust: "fixed", direction: "down", amount: 10 }));
  assert.equal(r.value, "10.00");
  assert.match(r.warning, /zero or less/);
  const r2 = applyToAmount("4.00", rule({ adjust: "fixed", direction: "down", amount: 9 }));
  assert.equal(r2.value, "4.00");
});

test("free items stay free, empty prices stay empty", () => {
  assert.equal(applyToAmount("0.00", rule({ adjust: "fixed", amount: 5, rounding: "99" })).value, "0.00");
  assert.equal(applyToAmount(null, rule({ adjust: "percent", amount: 10 })).value, null);
  assert.equal(applyToAmount("abc", rule({ adjust: "percent", amount: 10 })).value, null);
});

test("rounding to .99 / .95 / whole picks the nearest, never 0", () => {
  assert.equal(roundPrice(12.0, "99"), 11.99);
  assert.equal(roundPrice(12.3, "99"), 11.99);
  assert.equal(roundPrice(12.6, "99"), 12.99);
  assert.equal(roundPrice(12.4, "99"), 11.99);
  assert.equal(roundPrice(0.2, "99"), 0.99);
  assert.equal(roundPrice(12.3, "95"), 11.95);
  assert.equal(roundPrice(12.5, "whole"), 13);
  assert.equal(roundPrice(0.3, "whole"), 1);
  assert.equal(roundPrice(12.345, "none"), 12.35);
  // no cents in JPY: .99 becomes whole
  assert.equal(roundPrice(1234.4, "99", 0), 1234);
  assert.equal(roundPrice(0, "99"), 0);
});

test("ties go to the higher ending", () => {
  // 12.49 is 0.5 from both 11.99 and 12.99 → higher
  assert.equal(roundPrice(12.49, "99") === 11.99 || roundPrice(12.49, "99") === 12.99, true);
  assert.equal(roundPrice(12.49 + 1e-12, "99"), 12.99);
});

test("compare-at options", () => {
  const v = { price: "10.00", compareAtPrice: "15.00" };
  const up = { adjust: "percent", amount: 20 };
  assert.deepEqual(priceFieldsFor(v, rule({ ...up, compareAt: "same" })).fields, { price: "12.00", compareAtPrice: "18.00" });
  assert.deepEqual(priceFieldsFor(v, rule({ ...up, compareAt: "copy" })).fields, { price: "12.00", compareAtPrice: "15.00" });
  assert.deepEqual(priceFieldsFor(v, rule({ ...up, compareAt: "clear" })).fields, { price: "12.00", compareAtPrice: null });
  const down = { adjust: "percent", direction: "down", amount: 30 };
  assert.deepEqual(priceFieldsFor({ price: "10.00", compareAtPrice: null }, rule({ ...down, compareAt: "sourcePrice" })).fields, {
    price: "7.00",
    compareAtPrice: "10.00",
  });
  // compare-at not above the new price is removed
  assert.equal(priceFieldsFor({ price: "10.00", compareAtPrice: "11.00" }, rule({ adjust: "percent", amount: 50, compareAt: "copy" })).fields.compareAtPrice, null);
  // sourcePrice with a markup would be lower than the price → removed
  assert.equal(priceFieldsFor({ price: "10.00" }, rule({ ...up, compareAt: "sourcePrice" })).fields.compareAtPrice, null);
});

test("keep target prices only applies to variants that already exist", () => {
  const r = rule({ adjust: "percent", amount: 20, keepTargetPrices: true });
  const v = { price: "10.00", compareAtPrice: null };
  assert.deepEqual(priceFieldsFor(v, r, { existing: true }).fields, {});
  assert.equal(priceFieldsFor(v, r, { existing: false }).fields.price, "12.00");
  // keep alone (no change) is still an active rule
  assert.equal(ruleIsActive(rule({ keepTargetPrices: true })), true);
  assert.deepEqual(priceFieldsFor(v, rule({ keepTargetPrices: true }), { existing: false }).fields, { price: "10.00", compareAtPrice: null });
});

test("zero-decimal currencies", () => {
  assert.equal(currencyDecimals("JPY"), 0);
  assert.equal(currencyDecimals("USD"), 2);
  assert.equal(currencyDecimals("not-a-currency"), 2);
  assert.equal(applyToAmount("1000", rule({ adjust: "percent", amount: 15 }), 0).value, "1150");
});

test("normalize validates input", () => {
  assert.ok(normalizePriceRule({ adjust: "percent", amount: "-1" }).error);
  assert.ok(normalizePriceRule({ adjust: "percent", direction: "down", amount: 95 }).error);
  assert.ok(normalizePriceRule({ adjust: "percent", amount: 1001 }).error);
  assert.ok(normalizePriceRule({ adjust: "fixed", amount: 2e6 }).error);
  assert.equal(normalizePriceRule({ adjust: "percent", amount: "12,5" }).rule.amount, 12.5);
  assert.equal(normalizePriceRule({ adjust: "bogus", rounding: "x", compareAt: "y" }).rule.adjust, "none");
  assert.equal(parsePriceRule("not json"), null);
  assert.equal(parsePriceRule(JSON.stringify({ enabled: true, adjust: "percent", amount: 10 })).amount, 10);
});

test("describe", () => {
  assert.equal(describePriceRule(null), "prices copied as they are");
  assert.match(describePriceRule(rule({ adjust: "percent", amount: 20, rounding: "99" })), /\+20%, rounded to \.99/);
});
