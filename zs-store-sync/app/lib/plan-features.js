// Which plans include which extra features. Client-safe (the Plans and Rules
// pages render it). Plan keys match credits.server.js: free, starter, growth, pro.
export const FEATURE_PLANS = {
  // % / fixed markup or markdown, rounding, compare-at, keep target prices
  priceRules: ["starter", "growth", "pro"],
  // snapshot overwritten items before a sync, one-click restore for 30 days
  backups: ["starter", "growth", "pro"],
  // stock changes on the source copied to this store within about a minute
  liveInventory: ["growth", "pro"],
};

export function planHas(plan, feature) {
  return (FEATURE_PLANS[feature] || []).includes(plan);
}
