// app/lib/product-filter.js
// "Only copy these products": turns the optional fields on the Migrate and Sync
// forms into a Shopify product search, run against the source store. Blank
// fields are left out; several fields narrow the result (AND).

const STATUSES = ["active", "draft", "archived"];

export function productFilterFromForm(form) {
  const clean = (name) => String(form.get(name) || "").trim().slice(0, 100);
  const status = clean("filterStatus").toLowerCase();
  return {
    tag: clean("filterTag"),
    vendor: clean("filterVendor"),
    productType: clean("filterType"),
    status: STATUSES.includes(status) ? status : "",
  };
}

const quoted = (value) => `"${value.replace(/[\\"]/g, "\\$&")}"`;

// → a products(query:) string, or null when nothing is filtered
export function productSearchQuery(filter) {
  if (!filter) return null;
  const parts = [];
  if (filter.tag) parts.push(`tag:${quoted(filter.tag)}`);
  if (filter.vendor) parts.push(`vendor:${quoted(filter.vendor)}`);
  if (filter.productType) parts.push(`product_type:${quoted(filter.productType)}`);
  if (filter.status) parts.push(`status:${filter.status}`);
  return parts.length ? parts.join(" AND ") : null;
}
