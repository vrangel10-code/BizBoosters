import { prisma } from '@/server/db';
import { diagnoseDatabaseError } from '@/server/db-diagnosis';
import { handle, json } from '@/server/http';
import { reportError } from '@/server/observability';

export const dynamic = 'force-dynamic';

/**
 * Liveness plus database reachability.
 *
 * The database check is the point: a process that is up but cannot reach
 * Postgres serves errors to a classroom, and a probe that only proves the
 * process is alive would keep it in the load balancer.
 *
 * Unlike every other route, a failure here answers with a reason rather than an
 * opaque id. This is the first URL anyone opens after a deploy, and its whole
 * job is to say what is wrong — sending someone to a hosting dashboard's log
 * viewer to find out they used the wrong port is a health check failing at the
 * one thing it exists for. The reasons are a closed set of hand-written
 * sentences (see db-diagnosis.ts); the underlying error still goes to the log
 * and never to the client.
 */
export const GET = handle(async (_request: Request) => {
  const startedAt = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    const { reason, hint } = diagnoseDatabaseError(error);
    const errorId = reportError(error, { route: '/api/v1/health', database_reason: reason });

    return json(
      {
        status: 'error',
        time: new Date().toISOString(),
        checks: { database: { ok: false, reason, hint } },
        error_id: errorId,
      },
      { status: 503 },
    );
  }

  return json({
    status: 'ok',
    time: new Date().toISOString(),
    checks: { database: { ok: true, latency_ms: Date.now() - startedAt } },
  });
});
