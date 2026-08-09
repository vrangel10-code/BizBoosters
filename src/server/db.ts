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
/**
 * Prisma gives an interactive transaction 5 seconds to finish and 2 to find a
 * connection. Those defaults assume the database is next door.
 *
 * It is not always: on a serverless host the app can be a continent away from
 * Postgres, and then every statement inside a transaction costs a round trip.
 * A deck edit touching twenty cards spent 4.9 s of its 5 s budget on network
 * time alone and failed — as a 500 with no useful message, because a timed-out
 * transaction looks like any other driver error.
 *
 * The durable fix is fewer statements per transaction, and the ones that
 * mattered have been rewritten. This is the floor under that work, so a slow
 * link degrades into a slow save rather than a failed one. It is deliberately
 * not enormous: these transactions hold a per-room advisory lock, so a runaway
 * one delays every other draw in that room for exactly this long.
 */
export const TRANSACTION_DEFAULTS = { timeout: 15_000, maxWait: 10_000 } as const;

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = getClient();
    const value = Reflect.get(client, property, receiver) as unknown;

    // Apply the defaults in one place rather than at eighteen call sites, so a
    // transaction added later cannot quietly opt out of them. Only the
    // interactive form takes these options; the batch form is left alone.
    if (property === '$transaction') {
      return (...args: unknown[]) => {
        const [first, options] = args;
        if (typeof first === 'function' && options === undefined) {
          return (value as (...a: unknown[]) => unknown).call(
            client,
            first,
            TRANSACTION_DEFAULTS,
          );
        }
        return (value as (...a: unknown[]) => unknown).apply(client, args);
      };
    }

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
