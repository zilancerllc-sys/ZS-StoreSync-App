// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — PII redaction for job logs
//
//  Migration logs are persisted (MigrationJob.logJson) and rendered on the
//  History page, so anything written to them is data we STORE — not just data
//  we pass through. Customer emails and phone numbers must therefore never
//  reach a log line verbatim.
//
//  Two layers, deliberately overlapping:
//    1. customerRef()  — call sites log a masked email plus a customer id, so a
//                        later customers/redact request can find the lines.
//    2. redactPII()    — a catch-all applied to EVERY log line in
//                        jobs.server.js, which also scrubs PII that Shopify
//                        echoes back inside userError / exception messages
//                        (e.g. "Email is invalid: john@example.com").
// ═════════════════════════════════════════════════════════════════════════════

// john.doe@gmail.com → j***@gmail.com
// The domain is kept because it makes a failed import diagnosable; the local
// part is what identifies the person.
export function maskEmail(email) {
  const s = String(email ?? "");
  const at = s.indexOf("@");
  if (at < 1) return "***";
  return `${s[0]}***@${s.slice(at + 1)}`;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Shopify normalizes phone numbers to E.164 ("+8801712345678"). Requiring the
// leading + keeps this from mangling order totals, ids or GIDs.
const PHONE_RE = /\+\d{8,15}\b/g;

// Catch-all scrub for a single log line.
export function redactPII(text) {
  return String(text ?? "")
    .replace(EMAIL_RE, (m) => maskEmail(m))
    .replace(PHONE_RE, "+***");
}

// Numeric id out of a GID: "gid://shopify/Customer/8821" → "8821"
export function gidId(gid) {
  const tail = String(gid ?? "").split("/").pop();
  return /^\d+$/.test(tail) ? tail : "";
}

// How a customer is referred to in logs: masked email + a stable id tag.
// The tag is what customers/redact matches on, so it must not change format
// without also updating customerLogTag() below.
export function customerRef(customer) {
  const id = gidId(customer?.id);
  const tag = id ? `c#${id}` : "unknown";
  // Never fall back to first/last name — that is PII the catch-all can't mask.
  return customer?.email ? `${maskEmail(customer.email)} (${tag})` : tag;
}

// The exact token customerRef() embeds for a given customer id.
export function customerLogTag(customerId) {
  const id = gidId(customerId) || String(customerId ?? "").trim();
  return id ? `c#${id}` : "";
}

const REDACTED_LINE = "… line removed (customer data deletion request) …";

// Rewrite a stored log array, dropping the content of any line that refers to
// this customer. Returns null when nothing matched, so callers can skip the
// write. Exported separately from the DB work so it is unit-testable.
export function redactCustomerFromLogs(logs, { tag, email }) {
  let hit = false;
  const out = logs.map((line) => {
    const s = String(line);
    const matches =
      (tag && s.includes(tag)) ||
      // Legacy rows written before logs were masked still hold raw addresses.
      (email && s.toLowerCase().includes(String(email).toLowerCase()));
    if (!matches) return s;
    hit = true;
    // Keep the leading [HH:MM:SS] stamp so the log still reads as a timeline.
    const stamp = s.match(/^\[\d{2}:\d{2}:\d{2}\]\s*/)?.[0] ?? "";
    return `${stamp}${REDACTED_LINE}`;
  });
  return hit ? out : null;
}
