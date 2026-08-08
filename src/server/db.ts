import { PrismaClient } from '@prisma/client';

// Next.js dev server hot-reloads modules; without the global cache every reload
// would open a fresh connection pool until Postgres refuses new connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Silent under test: several suites assert on expected constraint
    // violations, and Prisma logging them looks like failures in CI output.
    log: process.env.VITEST
      ? []
      : process.env.NODE_ENV === 'development'
        ? ['warn', 'error']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export type { Prisma } from '@prisma/client';
