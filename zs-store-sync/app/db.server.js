import { PrismaClient } from "@prisma/client";

// Reuse the client across hot-reloads in dev to avoid exhausting Neon connections.
const globalForPrisma = global;

const prisma = globalForPrisma.prismaGlobal ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaGlobal = prisma;
}

export default prisma;
