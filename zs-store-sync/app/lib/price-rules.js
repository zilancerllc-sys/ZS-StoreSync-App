// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — price rules on sync
//
//  Pure and client-safe: the Rules page previews prices with the same code the
//  engine uses to write them, so what the merchant sees is what gets copied.
//
//  A rule belongs to one pairing (this store ← a source store) and applies to
//  every run between them: migrations, scheduled syncs and instant syncs.
//
//    adjust      "none" | "percent" | "fixed"
//    direction   "up" | "down"           markup or markdown
//    amount      number                  percent (20 = 20%) or currency amount
//    rounding    "none" | "99" | "95" | "whole"
//    compareAt   "same"         apply the same rule to the compare-at price
//                "copy"         copy the source compare-at price unchanged
//                "sourcePrice"  compare-at = the source's selling price
//                               (a markdown store shows "was <source price>")
//                "clear"        no compare-at price
//    keepTargetPrices  true = never change price/compare-at of variants that
//                already exist on this store (new variants still get prices)
// ═════════════════════════════════════════════════════════════════════════════

export const ROUNDING = ["none", "99", "95", "whole"];
export const COMPARE_AT = ["same", "copy", "sourcePrice", "clear"];

export const DEFAULT_PRICE_RULE = {
  enabled: false,
  adjust: "none",
  direction: "up",
  amount: 0,
  rounding: "none",
  compareAt: "same",
  keepTargetPrices: false,
};

const MAX_PERCENT_UP = 1000;
const MAX_PERCENT_DOWN = 90;
const MAX_FIXED = 1000000;

// Form values / stored JSON → a clean rule, or { error }.
export function normalizePriceRule(input) {
  const r = { ...DEFAULT_PRICE_RULE };
  const src = input && typeof input === "object" ? input : {};
  r.enabled = src.enabled === true || src.enabled === "true" || src.enabled === "on";
  r.adjust = ["none", "percent", "fixed"].includes(src.adjust) ? src.adjust : "none";
  r.direction = src.direction === "down" ? "down" : "up";
  r.rounding = ROUNDING.includes(String(src.rounding)) ? String(src.rounding) : "none";
  r.compareAt = COMPARE_AT.includes(src.compareAt) ? src.compareAt : "same";
  r.keepTargetPrices =
    src.keepTargetPrices === true || src.keepTargetPrices === "true" || src.keepTargetPrices === "on";

  const amount = Number(String(src.amount ?? 0).replace(",", "."));
  if (r.adjust === "none") {
    r.amount = 0;
  } else {
    if (!Number.isFinite(amount) || amount < 0) {
      return { error: "Enter a price change of 0 or more." };
    }
    if (r.adjust === "percent") {
      const max = r.direction === "down" ? MAX_PERCENT_DOWN : MAX_PERCENT_UP;
      if (amount > max) {
        return {
          error:
            r.direction === "down"
              ? "A markdown can be at most 90%."
              : "A markup can be at most 1000%.",
        };
      }
    } else if (amount > MAX_FIXED) {
      return { error: "That fixed amount is too large." };
    }
    r.amount = Math.round(amount * 100) / 100;
  }
  return { rule: r };
}

export function parsePriceRule(json) {
  if (!json) return null;
  try {
    const { rule } = normalizePriceRule(JSON.parse(json));
    return rule || null;
  } catch {
    return null;
  }
}

// Does the rule change anything at all? A disabled or empty rule means the
// engine behaves exactly as it always did (prices copied as they are).
export function ruleIsActive(rule) {
  if (!rule?.enabled) return false;
  return (
    rule.keepTargetPrices ||
    (rule.adjust !== "none" && rule.amount > 0) ||
    rule.rounding !== "none" ||
    rule.compareAt !== "same"
  );
}

// Decimal places of a currency (JPY 0, USD 2, KWD 3).
export function currencyDecimals(currencyCode) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currencyCode || "USD" })
      .resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

function toFixedNum(x, decimals) {
  const f = 10 ** decimals;
  return Math.round((x + Number.EPSILON) * f) / f;
}

// Nearest price with the wanted ending; never 0 or below for a positive input.
export function roundPrice(x, rounding, decimals = 2) {
  if (!(x > 0)) return 0;
  let mode = rounding;
  // .99 / .95 endings mean nothing in a currency without cents
  if ((mode === "99" || mode === "95") && decimals === 0) mode = "whole";
  if (mode === "whole") {
    return Math.max(1, Math.round(x));
  }
  if (mode === "99" || mode === "95") {
    const ending = mode === "99" ? 0.99 : 0.95;
    const base = Math.floor(x);
    const candidates = [base - 1 + ending, base + ending, base + 1 + ending].filter((c) => c > 0);
    let best = candidates[0];
    for (const c of candidates) {
      const d = Math.abs(c - x);
      const bd = Math.abs(best - x);
      // ties go to the higher price
      if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && c > best)) best = c;
    }
    return toFixedNum(best, 2);
  }
  return toFixedNum(x, decimals);
}

function adjustAmount(x, rule) {
  if (rule.adjust === "percent") {
    const f = rule.direction === "down" ? 1 - rule.amount / 100 : 1 + rule.amount / 100;
    return x * f;
  }
  if (rule.adjust === "fixed") {
    return rule.direction === "down" ? x - rule.amount : x + rule.amount;
  }
  return x;
}

const fmt = (n, decimals) => (n == null ? null : Number(n).toFixed(decimals));

// One price through the rule. → { value: string|null, warning?: string }
// A free item stays free, and a price the rule would push to 0 or below keeps
// the source price instead (with a warning), so a rule can never give stock away.
export function applyToAmount(raw, rule, decimals = 2) {
  if (raw == null || raw === "") return { value: null };
  const x = Number(raw);
  if (!Number.isFinite(x)) return { value: null };
  if (x <= 0) return { value: fmt(0, decimals) };
  const adjusted = adjustAmount(x, rule);
  if (!(adjusted > 0)) {
    return {
      value: fmt(x, decimals),
      warning: `the price rule would make ${fmt(x, decimals)} zero or less — kept the source price`,
    };
  }
  return { value: fmt(roundPrice(adjusted, rule.rounding, decimals), decimals) };
}

// Price and compare-at for one source variant.
//   existing: the variant already exists on the target (a sync update)
// → { fields: { price?, compareAtPrice? }, warnings: [] }
//   An empty `fields` means "don't send price fields at all".
// Without an active rule the result is exactly what the engine always sent:
// the source values, untouched.
export function priceFieldsFor(variant, rule, { existing = false, decimals = 2 } = {}) {
  const passthrough = {
    price: variant.price ?? undefined,
    compareAtPrice: variant.compareAtPrice ?? undefined,
  };
  if (!ruleIsActive(rule)) return { fields: passthrough, warnings: [] };
  if (existing && rule.keepTargetPrices) return { fields: {}, warnings: [] };

  const warnings = [];
  const p = applyToAmount(variant.price, rule, decimals);
  if (p.warning) warnings.push(p.warning);
  const fields = {};
  if (p.value != null) fields.price = p.value;

  let compare = null;
  if (rule.compareAt === "same") {
    const c = applyToAmount(variant.compareAtPrice, rule, decimals);
    compare = c.value;
  } else if (rule.compareAt === "copy") {
    compare = variant.compareAtPrice == null ? null : fmt(Number(variant.compareAtPrice), decimals);
  } else if (rule.compareAt === "sourcePrice") {
    compare = variant.price == null ? null : fmt(Number(variant.price), decimals);
  }
  // A compare-at that isn't above the selling price shows nothing useful on a
  // storefront (and "was $10, now $12" is wrong), so it is cleared.
  if (compare != null && fields.price != null && !(Number(compare) > Number(fields.price))) {
    compare = null;
  }
  fields.compareAtPrice = compare;
  return { fields, warnings };
}

// Short English description for logs: "+20%, rounded to .99, compare-at: same rule".
export function describePriceRule(rule) {
  if (!ruleIsActive(rule)) return "prices copied as they are";
  const parts = [];
  if (rule.adjust === "percent" && rule.amount > 0) {
    parts.push(`${rule.direction === "down" ? "-" : "+"}${rule.amount}%`);
  } else if (rule.adjust === "fixed" && rule.amount > 0) {
    parts.push(`${rule.direction === "down" ? "-" : "+"}${rule.amount} (fixed)`);
  } else {
    parts.push("no price change");
  }
  const roundText = { none: null, 99: "rounded to .99", 95: "rounded to .95", whole: "rounded to a whole number" };
  if (roundText[rule.rounding]) parts.push(roundText[rule.rounding]);
  const cmp = {
    same: "compare-at: same rule",
    copy: "compare-at: copied unchanged",
    sourcePrice: "compare-at: the source price",
    clear: "compare-at: removed",
  };
  parts.push(cmp[rule.compareAt]);
  if (rule.keepTargetPrices) parts.push("existing prices on this store kept");
  return parts.join(", ");
}
