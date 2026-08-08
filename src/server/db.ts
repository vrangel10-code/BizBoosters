import { PrismaClient } from '@prisma/client';

// Next.js dev server hot-reloads modules; without the global cache every reload
// would open a fresh connection pool until Postgres refuses new connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  return new PrismaClient({
    // Silent under test: several suites assert on expected constraint
    // violations, and Prisma logging them looks like failures in CI output.
    log: process.env.VITEST
      ? []
      : process.env.NODE_ENV === 'development'
        ? ['warn', 'error']
        : ['error'],
  });
}

function getClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createClient();
  }
  return globalForPrisma.prisma;
}

/**
 * The Prisma client, constructed on first use rather than at import.
 *
 * `next build` imports every route module to collect the route map, which used
 * to construct a client — and a build environment has no DATABASE_URL, because
 * building does not need a database. That failed the build on any host that
 * does not let you set a dummy connection string (Netlify among them), with an
 * error pointing at Prisma rather than at the real cause.
 *
 * Deferring construction means importing this module is free. Nothing connects
 * until a request actually needs data.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = getClient();
    const value = Reflect.get(client, property, receiver) as unknown;
    // Methods must keep their `this`, or `prisma.user.findMany()` loses the
    // client it was reached through.
    return typeof value === 'function' ? value.bind(client) : value;
  },
  has(_target, property) {
    return property in getClient();
  },
  getPrototypeOf() {
    return Object.getPrototypeOf(getClient()) as object | null;
  },
});

export type { Prisma } from '@prisma/client';
