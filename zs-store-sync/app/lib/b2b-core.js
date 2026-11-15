// Pure helpers for copying B2B: companies, company locations, contacts (linked
// to customers by email) and their role assignments.
const lc = (s) => String(s || "").trim().toLowerCase();

const ADDRESS_KEYS = ["address1", "address2", "city", "countryCode", "firstName", "lastName", "phone", "recipient", "zip", "zoneCode"];

export function addressInput(a) {
  if (!a || !a.countryCode) return null;
  const out = {};
  for (const k of ADDRESS_KEYS) if (a[k] != null && a[k] !== "") out[k] = a[k];
  return out;
}

const sameAddress = (a, b) =>
  !!a && !!b && ADDRESS_KEYS.every((k) => (a[k] || "") === (b[k] || ""));

// → CompanyLocationInput. Payment terms templates have store-specific ids,
// so they are matched by name in termsByName (name → target id).
export function companyLocationInput(loc, { termsByName = new Map() } = {}) {
  const input = { name: loc.name };
  for (const k of ["phone", "locale", "note", "externalId"]) if (loc[k]) input[k] = loc[k];
  const ship = addressInput(loc.shippingAddress);
  const bill = addressInput(loc.billingAddress);
  if (ship) input.shippingAddress = ship;
  if (bill && ship && sameAddress(bill, ship)) input.billingSameAsShipping = true;
  else if (bill) input.billingAddress = bill;
  const tax = loc.taxSettings;
  if (tax) {
    if (tax.taxExempt != null) input.taxExempt = !!tax.taxExempt;
    if (tax.taxExemptions?.length) input.taxExemptions = tax.taxExemptions;
    if (tax.taxRegistrationId) input.taxRegistrationId = tax.taxRegistrationId;
  }
  const bx = loc.buyerExperienceConfiguration;
  if (bx) {
    const cfg = { checkoutToDraft: !!bx.checkoutToDraft, editableShippingAddress: !!bx.editableShippingAddress };
    const termsId = bx.paymentTermsTemplate?.name ? termsByName.get(lc(bx.paymentTermsTemplate.name)) : null;
    if (termsId) cfg.paymentTermsTemplateId = termsId;
    input.buyerExperienceConfiguration = cfg;
  }
  return input;
}

export function companyInput(c) {
  const input = { name: c.name };
  if (c.note) input.note = c.note;
  if (c.externalId) input.externalId = c.externalId;
  if (c.customerSince) input.customerSince = c.customerSince;
  return input;
}

// Companies are matched across stores by external ID, then by name.
export function findExistingCompany(c, targetCompanies) {
  return (
    (c.externalId && (targetCompanies || []).find((t) => t.externalId && t.externalId === c.externalId)) ||
    (targetCompanies || []).find((t) => lc(t.name) === lc(c.name)) ||
    null
  );
}

// Role names ("Ordering only", "Location admin") are the same on every store;
// the ids are not.
export function roleIdByName(roles, name) {
  return (roles || []).find((r) => lc(r.name) === lc(name))?.id || null;
}

// What a source store must have to share its B2B data.
export function b2bAvailability(shop) {
  if (!shop) return { ok: false, reason: "unknown" };
  if (shop.plan?.shopifyPlus) return { ok: true, plus: true };
  // Development stores can test B2B without Plus.
  if (shop.plan?.partnerDevelopment) return { ok: true, plus: false };
  return { ok: false, reason: "not Plus" };
}
