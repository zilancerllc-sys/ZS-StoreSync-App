// Created-item ids that need more than the gid itself to undo.

// A zone added to an existing shipping profile is recorded as
// "gid://shopify/DeliveryZone/1?profile=<encoded profile gid>", because a zone
// can only be removed through its profile.
export function zoneUndoVariables(gid) {
  const [zone, query = ""] = String(gid).split("?");
  const profile = decodeURIComponent(new URLSearchParams(query).get("profile") || "");
  return { id: profile, profile: { zonesToDelete: [zone] } };
}

// A store metafield this run created: "gid://shopify/Metafield/1?owner=..&ns=..&key=.."
export function metafieldUndoGid(id, ownerId, namespace, key) {
  const q = new URLSearchParams({ owner: ownerId, ns: namespace, key });
  return `${id}?${q.toString()}`;
}

export function metafieldUndoVariables(gid) {
  const q = new URLSearchParams(String(gid).split("?")[1] || "");
  return { metafields: [{ ownerId: q.get("owner") || "", namespace: q.get("ns") || "", key: q.get("key") || "" }] };
}
