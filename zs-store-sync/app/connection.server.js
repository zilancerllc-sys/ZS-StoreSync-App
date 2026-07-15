// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — Connection code (pairing) helpers
//  Save as: app/connection.server.js
// ═════════════════════════════════════════════════════════════════════════════
import db from "./db.server";

// Characters that are unambiguous (no 0/O, 1/I/L) for codes humans read & type.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomCode() {
  // Format: XXXX-XXXX (e.g. ZS7K-92QT)
  const pick = () =>
    Array.from(
      { length: 4 },
      () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
    ).join("");
  return `${pick()}-${pick()}`;
}

// pick a code that isn't already taken; throws only in the astronomically
// unlikely case that every retry collides
async function uniqueCode() {
  for (let i = 0; i < 6; i++) {
    const code = randomCode();
    const clash = await db.shopSecret.findUnique({
      where: { connectionCode: code },
    });
    if (!clash) return code;
  }
  throw new Error("Could not generate a unique connection code, try again.");
}

// ─── Get (or lazily create) the connection code for a shop ───────────────────
export async function getConnectionCode(shop) {
  const rec = await db.shopSecret.findUnique({ where: { shop } });
  if (rec) return rec.connectionCode;
  try {
    const created = await db.shopSecret.create({
      data: { shop, connectionCode: await uniqueCode() },
    });
    return created.connectionCode;
  } catch (err) {
    // concurrent first-load created it between our read and write — reuse it
    const existing = await db.shopSecret.findUnique({ where: { shop } });
    if (existing) return existing.connectionCode;
    throw err;
  }
}

// ─── Regenerate a shop's code (revokes the old one) ──────────────────────────
export async function regenerateConnectionCode(shop) {
  const code = await uniqueCode();
  await db.shopSecret.upsert({
    where: { shop },
    update: { connectionCode: code },
    create: { shop, connectionCode: code },
  });
  return code;
}

// ─── Verify a code belongs to a given source shop ────────────────────────────
// Returns true only if the code matches the connection code that the SOURCE
// shop owner can see in their own Settings. Normalizes case & spacing.
export async function verifyConnectionCode(sourceShop, code) {
  if (!sourceShop || !code) return false;
  const normalized = String(code).trim().toUpperCase().replace(/\s+/g, "");
  const rec = await db.shopSecret.findUnique({ where: { shop: sourceShop } });
  if (!rec) return false;
  return rec.connectionCode === normalized;
}

// ─── Require a code-verified connection between owner and source ─────────────
// SECURITY: every read of a source store's data must go through a connection
// the owner paired with that store's connection code. Returns the connection
// row, or null when the pair was never verified.
export async function getVerifiedConnection(ownerShop, sourceShop) {
  if (!ownerShop || !sourceShop) return null;
  const conn = await db.storeConnection.findUnique({
    where: { ownerShop_sourceShop: { ownerShop, sourceShop } },
  });
  return conn?.codeVerified ? conn : null;
}
