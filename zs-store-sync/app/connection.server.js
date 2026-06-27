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

// ─── Get (or lazily create) the connection code for a shop ───────────────────
export async function getConnectionCode(shop) {
  let rec = await db.shopSecret.findUnique({ where: { shop } });
  if (!rec) {
    // generate a unique code (retry on the rare collision)
    let code;
    for (let i = 0; i < 6; i++) {
      code = randomCode();
      const clash = await db.shopSecret.findUnique({
        where: { connectionCode: code },
      });
      if (!clash) break;
    }
    rec = await db.shopSecret.create({
      data: { shop, connectionCode: code },
    });
  }
  return rec.connectionCode;
}

// ─── Regenerate a shop's code (revokes the old one) ──────────────────────────
export async function regenerateConnectionCode(shop) {
  let code;
  for (let i = 0; i < 6; i++) {
    code = randomCode();
    const clash = await db.shopSecret.findUnique({
      where: { connectionCode: code },
    });
    if (!clash) break;
  }
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
