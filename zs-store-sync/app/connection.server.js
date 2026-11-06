// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — Connection code (pairing) helpers
//  Save as: app/connection.server.js
// ═════════════════════════════════════════════════════════════════════════════
import { randomInt, timingSafeEqual } from "node:crypto";
import db from "./db.server";

// ─── Guessing limits ─────────────────────────────────────────────────────────
// The code is the only thing standing between anyone who installs the app and
// another store's catalog, customers and orders, and nothing limited how many
// codes a store could try. Wrong guesses are now capped per trying store and
// per target store (the second stops many throwaway stores ganging up on one
// victim). Held in memory: each machine keeps its own count, which only makes
// the effective limit a small multiple — still hopeless for 31^8 codes.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_OWNER = 10;
const MAX_FAILS_PER_SOURCE = 30;
const fails = new Map(); // key → timestamps of recent wrong codes

function recent(key, now) {
  const list = (fails.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length) fails.set(key, list);
  else fails.delete(key);
  return list;
}

// Minutes until the caller may try again, or 0 when they may try now.
export function codeAttemptBlockedFor(ownerShop, sourceShop, now = Date.now()) {
  const owner = recent(`o:${ownerShop}`, now);
  const source = recent(`s:${sourceShop}`, now);
  const blocked =
    (owner.length >= MAX_FAILS_PER_OWNER && owner[0]) ||
    (source.length >= MAX_FAILS_PER_SOURCE && source[0]);
  return blocked ? Math.ceil((blocked + WINDOW_MS - now) / 60000) : 0;
}

export function recordCodeFailure(ownerShop, sourceShop, now = Date.now()) {
  for (const key of [`o:${ownerShop}`, `s:${sourceShop}`]) {
    fails.set(key, [...recent(key, now), now]);
  }
}

// A store domain we will look up, store, and send to /auth/login. Anything
// else was previously accepted as long as it contained a dot.
export function isShopDomain(value) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(String(value || ""));
}

// Characters that are unambiguous (no 0/O, 1/I/L) for codes humans read & type.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomCode() {
  // Format: XXXX-XXXX (e.g. ZS7K-92QT)
  //
  // SECURITY: this code is the only gate protecting a source store's catalog,
  // customers and orders, so it must come from a CSPRNG. Math.random() is a
  // seeded PRNG whose internal state can be recovered from observed output —
  // and anyone can farm output by hitting "Regenerate code" on their own store.
  const pick = () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
      "",
    );
  return `${pick()}-${pick()}`;
}

// Accept whatever the merchant pastes — "zs7k 92qt", "ZS7K92QT", "zs7k-92qt"
// all normalize to the stored "ZS7K-92QT". Only stripping whitespace (as this
// used to) rejected a code typed with a space instead of the dash.
function normalizeCode(input) {
  const bare = String(input)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : bare;
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

// ─── Cut off stores that pull from this shop ─────────────────────────────────
// SECURITY: getVerifiedConnection trusts the stored codeVerified flag, so
// changing the code alone left every store that had once entered it able to
// keep migrating, syncing and instant-syncing this shop's data. Revoking
// clears the flag and removes the pairs' schedules and queued instant syncs;
// running jobs are asked to stop through the same cancelRequested flag the
// History "Stop" button uses. `ownerShop` narrows it to one pairing.
// Returns the Prisma operations so callers can put them in a transaction.
function revokeSourcePairingsOps(sourceShop, ownerShop = null) {
  const pair = ownerShop
    ? { sourceShop, ownerShop }
    : { sourceShop, ownerShop: { not: sourceShop } };
  return [
    db.storeConnection.updateMany({
      where: pair,
      data: { codeVerified: false, instantSync: false },
    }),
    db.syncSchedule.deleteMany({ where: pair }),
    db.pendingProductSync.deleteMany({ where: pair }),
    db.migrationJob.updateMany({
      where: {
        sourceShop,
        status: "running",
        shop: ownerShop || { not: sourceShop },
      },
      data: { cancelRequested: true },
    }),
  ];
}

// Stores currently allowed to pull from this shop (for its Settings page).
export async function listPullingStores(sourceShop) {
  return db.storeConnection.findMany({
    where: { sourceShop, codeVerified: true, ownerShop: { not: sourceShop } },
    select: { id: true, ownerShop: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

// Revoke one pairing. Filtering on BOTH id and sourceShop means a store can
// only revoke pairings that read its own data, whatever id is posted.
export async function revokePullingStore(sourceShop, connectionId) {
  const conn = await db.storeConnection.findFirst({
    where: { id: String(connectionId || ""), sourceShop },
    select: { ownerShop: true },
  });
  if (!conn) return false;
  await db.$transaction(revokeSourcePairingsOps(sourceShop, conn.ownerShop));
  return true;
}

// Revoke every pairing and forget the code (used on app/uninstalled, so a
// reinstall starts with a fresh code instead of resurrecting old pairings).
export async function revokeAllPullingStores(sourceShop) {
  await db.$transaction([
    ...revokeSourcePairingsOps(sourceShop),
    db.shopSecret.deleteMany({ where: { shop: sourceShop } }),
  ]);
}

// ─── Regenerate a shop's code (revokes the old one) ──────────────────────────
export async function regenerateConnectionCode(shop) {
  const code = await uniqueCode();
  // The Settings page promises the old code is revoked immediately, so the
  // pairings made with it go in the same transaction as the new code.
  await db.$transaction([
    db.shopSecret.upsert({
      where: { shop },
      update: { connectionCode: code },
      create: { shop, connectionCode: code },
    }),
    ...revokeSourcePairingsOps(shop),
  ]);
  return code;
}

// ─── Verify a code belongs to a given source shop ────────────────────────────
// Returns true only if the code matches the connection code that the SOURCE
// shop owner can see in their own Settings. Normalizes case & spacing.
export async function verifyConnectionCode(sourceShop, code) {
  if (!sourceShop || !code) return false;
  const normalized = normalizeCode(code);
  const rec = await db.shopSecret.findUnique({ where: { shop: sourceShop } });
  if (!rec) return false;
  // constant-time, so response timing can't reveal how much of a guess matched
  const a = Buffer.from(rec.connectionCode);
  const b = Buffer.from(normalized);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── An owner's pairings, with `authorized` checked against reality ──────────
// `authorized` is a cached flag; the truth is whether the source store still
// has an offline session (it goes away when that store uninstalls). Only the
// Migrate page used to re-check, so the dashboard, Get Started, Sync and
// Preview kept offering sources that could no longer be read.
export async function listConnections(ownerShop) {
  const connections = await db.storeConnection.findMany({
    where: { ownerShop },
    orderBy: { createdAt: "desc" },
  });
  if (!connections.length) return connections;

  const sessions = await db.session.findMany({
    where: {
      shop: { in: connections.map((c) => c.sourceShop) },
      isOnline: false,
    },
    select: { shop: true, accessToken: true },
  });
  const live = new Set(sessions.filter((s) => s.accessToken).map((s) => s.shop));

  for (const c of connections) {
    const has = live.has(c.sourceShop);
    if (has !== c.authorized) {
      await db.storeConnection.update({
        where: { id: c.id },
        data: { authorized: has },
      });
      c.authorized = has;
    }
  }
  return connections;
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
