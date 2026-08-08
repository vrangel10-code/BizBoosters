import { runReconciliation } from '@/server/services/reconciliation';
import { pruneRateLimits } from '@/server/auth/rate-limit';
import { handle, json } from '@/server/http';
import { apiError } from '@/server/errors';

export const dynamic = 'force-dynamic';

/**
 * Nightly integrity check. Point a scheduler at it (Vercel Cron, GitHub
 * Actions, cron + curl) and alert on a non-200 or on `healthy: false`.
 *
 * Guarded by a shared secret rather than a session, because a scheduler has no
 * user. With CRON_SECRET unset the route is disabled outright — an unauthorised
 * endpoint that enumerates every room's integrity state is not something to
 * leave open by accident.
 */
export const GET = handle(async (request: Request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw apiError('not_found', 'Not found.');

  const provided =
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    new URL(request.url).searchParams.get('secret');

  if (provided !== secret) throw apiError('unauthenticated', 'Not authorised.');

  const report = await runReconciliation();
  await pruneRateLimits();

  return json(report, { status: report.healthy ? 200 : 500 });
});
