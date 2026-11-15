// Matching translatable resources between two stores when there is no handle
// to look them up by (email templates, delivery methods, policies, theme
// content...). A digest is a hash of the original text, so a resource whose
// copied text is identical on both stores has the same (key, digest) pairs.

// Translation resource types copied by the Translations module.
//   mapped: looked up by handle / id rules in the migrator
//   digest: matched with bestDigestMatch below
export const TRANSLATION_TYPES = {
  PRODUCT: "mapped",
  COLLECTION: "mapped",
  PAGE: "mapped",
  ARTICLE: "mapped",
  BLOG: "digest",
  METAOBJECT: "mapped",
  MEDIA_IMAGE: "mapped",
  MENU: "menu",
  LINK: "menu",
  SHOP: "shop",
  SHOP_POLICY: "digest",
  METAFIELD: "metafield",
  PRODUCT_OPTION: "option",
  PRODUCT_OPTION_VALUE: "option",
  COLLECTION_IMAGE: "digest",
  ARTICLE_IMAGE: "digest",
  DELIVERY_METHOD_DEFINITION: "digest",
  SELLING_PLAN_GROUP: "digest",
  SELLING_PLAN: "digest",
  FILTER: "digest",
  PAYMENT_GATEWAY: "digest",
  EMAIL_TEMPLATE: "digest",
  PACKING_SLIP_TEMPLATE: "digest",
  ONLINE_STORE_THEME: "digest",
  ONLINE_STORE_THEME_JSON_TEMPLATE: "digest",
  ONLINE_STORE_THEME_SECTION_GROUP: "digest",
  ONLINE_STORE_THEME_SETTINGS_CATEGORY: "digest",
  ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS: "digest",
  ONLINE_STORE_THEME_LOCALE_CONTENT: "digest",
  ONLINE_STORE_THEME_APP_EMBED: "digest",
};

export const TRANSLATION_ORDER = Object.keys(TRANSLATION_TYPES);

const pairs = (content) =>
  new Set((content || []).filter((c) => c.digest).map((c) => `${c.key}\u0000${c.digest}`));

// → target resource, or null when nothing (or more than one equally) matches.
export function bestDigestMatch(sourceContent, targets) {
  const want = pairs(sourceContent);
  if (!want.size) return null;
  let best = null;
  let bestScore = 0;
  let tie = false;
  for (const t of targets || []) {
    let score = 0;
    for (const p of pairs(t.translatableContent)) if (want.has(p)) score++;
    if (score > bestScore) {
      best = t;
      bestScore = score;
      tie = false;
    } else if (score && score === bestScore) {
      tie = true;
    }
  }
  return bestScore && !tie ? best : null;
}

// Menu item paths ("main-menu|Shop>Shoes#0") so links can be matched by
// position in the tree rather than by id. Duplicate titles at one level get
// an occurrence number.
export function menuLinkPaths(menu) {
  const out = new Map();
  const walk = (items, prefix) => {
    const seen = new Map();
    for (const it of items || []) {
      const n = seen.get(it.title) || 0;
      seen.set(it.title, n + 1);
      const path = `${prefix}>${it.title}#${n}`;
      out.set(path, it.id);
      walk(it.items, path);
    }
  };
  walk(menu?.items, menu?.handle || "");
  return out;
}

// Only translations whose source key still exists on the target resource,
// and (in migrate mode) that the target hasn't translated yet.
export function translationsToRegister(sourceTranslations, targetContent, existingKeys, locale, replace) {
  const digests = new Map((targetContent || []).map((c) => [c.key, c.digest]));
  return (sourceTranslations || [])
    .filter((t) => t.value && digests.get(t.key))
    .filter((t) => replace || !existingKeys.has(t.key))
    .map((t) => ({ locale, key: t.key, value: t.value, translatableContentDigest: digests.get(t.key) }));
}
