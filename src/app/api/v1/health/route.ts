import { prisma } from '@/server/db';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Liveness plus database reachability.
 *
 * The database check is the point: a process that is up but cannot reach
 * Postgres serves errors to a classroom, and a probe that only proves the
 * process is alive would keep it in the load balancer.
 */
export const GET = handle(async (_request: Request) => {
  const startedAt = Date.now();
  await prisma.$queryRaw`SELECT 1`;

  return json({
    status: 'ok',
    time: new Date().toISOString(),
    checks: { database: { ok: true, latency_ms: Date.now() - startedAt } },
  });
});
