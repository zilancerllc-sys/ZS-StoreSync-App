// Created-item ids that need more than the gid itself to undo.

// A zone added to an existing shipping profile is recorded as
// "gid://shopify/DeliveryZone/1?profile=<encoded profile gid>", because a zone
// can only be removed through its profile.
export function zoneUndoVariables(gid) {
  const [zone, query = ""] = String(gid).split("?");
  const profile = decodeURIComponent(new URLSearchParams(query).get("profile") || "");
  return { id: profile, profile: { zonesToDelete: [zone] } };
}
