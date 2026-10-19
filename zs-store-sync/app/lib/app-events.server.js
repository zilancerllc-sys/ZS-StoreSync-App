// app/lib/app-events.server.js
// Owner dashboard event log (see AppEvent in schema.prisma). Never throws and is
// never awaited where it could slow a merchant down: a lost event costs a point
// on a chart, a thrown one could cost an install.
import prisma from "../db.server";

export function logAppEvent(shop, type, detail = null) {
  if (!shop || !type) return;
  prisma.appEvent
    .create({ data: { shop, type, detail } })
    .catch((e) => console.error("[app events]", e?.message || e));
}
