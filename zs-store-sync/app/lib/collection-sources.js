// app/lib/collection-sources.js
// Turns a smart collection's legacy `ruleSet` (still readable, deprecated) into
// the `sources` input that collectionCreate / collectionUpdate take from Admin
// API 2026-07 on. One rule becomes one inclusion condition; the rule set's
// any/all flag becomes the inclusion matchType.
//
// A rule with no equivalent can't just be dropped: on an "all" collection that
// widens it, on an "any" collection it narrows it. The whole collection is
// skipped instead, with the reason.

const TEXT_RELATIONS = {
  EQUALS: "EQUALS",
  NOT_EQUALS: "NOT_EQUALS",
  CONTAINS: "CONTAINS",
  NOT_CONTAINS: "DOES_NOT_CONTAIN",
  STARTS_WITH: "STARTS_WITH",
  ENDS_WITH: "ENDS_WITH",
};
const TAG_RELATIONS = { EQUALS: "TAGGED_WITH", NOT_EQUALS: "NOT_TAGGED_WITH" };
const NUMBER_RELATIONS = ["EQUALS", "NOT_EQUALS", "GREATER_THAN", "LESS_THAN"];
const INVENTORY_RELATIONS = ["EQUALS", "GREATER_THAN", "LESS_THAN"];

const TEXT_FIELDS = {
  TITLE: "productTitle",
  TYPE: "productType",
  VENDOR: "productVendor",
  VARIANT_TITLE: "variantTitle",
};

function categoryGid(value) {
  const v = String(value);
  return v.startsWith("gid://") ? v : `gid://shopify/TaxonomyCategory/${v}`;
}

// → { condition } or { error }
function ruleToCondition(rule, shop) {
  const { column, relation, condition } = rule;
  const values = [String(condition)];

  if (column === "TAG") {
    const r = TAG_RELATIONS[relation];
    return r
      ? { condition: { productTag: { relation: r, values, matchType: "ALL" } } }
      : null;
  }
  if (TEXT_FIELDS[column]) {
    const r = TEXT_RELATIONS[relation];
    if (!r) return null;
    return {
      condition: { [TEXT_FIELDS[column]]: { relation: r, values, matchType: "ALL" } },
    };
  }
  if (column === "PRODUCT_CATEGORY_ID" || column === "PRODUCT_CATEGORY_ID_WITH_DESCENDANTS") {
    if (relation !== "EQUALS" && relation !== "NOT_EQUALS") return null;
    return {
      condition: {
        productCategory: {
          relation,
          values: [
            {
              categoryId: categoryGid(condition),
              includeDescendants: column === "PRODUCT_CATEGORY_ID_WITH_DESCENDANTS",
            },
          ],
          matchType: "ALL",
        },
      },
    };
  }
  if (column === "VARIANT_PRICE" || column === "VARIANT_COMPARE_AT_PRICE") {
    const field = column === "VARIANT_PRICE" ? "variantPrice" : "variantCompareAtPrice";
    if (column === "VARIANT_COMPARE_AT_PRICE" && (relation === "IS_SET" || relation === "IS_NOT_SET")) {
      return { condition: { [field]: { relation } } };
    }
    if (!NUMBER_RELATIONS.includes(relation)) return null;
    return {
      condition: {
        [field]: {
          relation,
          value: { amount: String(condition), currencyCode: shop.currencyCode },
        },
      },
    };
  }
  if (column === "VARIANT_WEIGHT") {
    if (!NUMBER_RELATIONS.includes(relation)) return null;
    return {
      condition: {
        variantWeight: {
          relation,
          value: { value: Number(condition), unit: shop.weightUnit },
        },
      },
    };
  }
  if (column === "VARIANT_INVENTORY") {
    if (!INVENTORY_RELATIONS.includes(relation)) return null;
    return {
      condition: {
        variantInventory: { relation, value: Math.trunc(Number(condition)) },
      },
    };
  }
  return null;
}

// shop: { currencyCode, weightUnit } of the store the rules came from.
// → { sources: [CollectionCreateSourceTargetInput] } or { skip: reason }
export function sourcesFromRuleSet(ruleSet, title, shop) {
  const conditions = [];
  for (const rule of ruleSet.rules || []) {
    const out = ruleToCondition(rule, shop);
    if (!out) {
      return {
        skip: `its rule "${rule.column} ${rule.relation} ${rule.condition}" has no equivalent in the new collection API`,
      };
    }
    conditions.push(out.condition);
  }
  return {
    sources: [
      {
        source: {
          title,
          inclusion: {
            matchType: ruleSet.appliedDisjunctively ? "ANY" : "ALL",
            conditions,
            selections: [],
          },
        },
      },
    ],
  };
}
