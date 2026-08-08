import { findExpiredRooms, pruneExpiredSessions } from '@/server/services/retention';
import { pruneRateLimits } from '@/server/auth/rate-limit';
import { apiError } from '@/server/errors';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Nightly housekeeping.
 *
 * Sessions and rate-limit windows are swept automatically — they are debris.
 * Expired rooms are only *reported*: a scheduled job that silently erases a
 * term of student work is not something to run unattended, so a human confirms
 * each one.
 */
export const GET = handle(async (request: Request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw apiError('not_found', 'Not found.');

  const provided =
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    new URL(request.url).searchParams.get('secret');
  if (provided !== secret) throw apiError('unauthenticated', 'Not authorised.');

  const retentionDays = Number(process.env.RETENTION_DAYS ?? 548);

  const [sessions, rateLimits, expiredRooms] = await Promise.all([
    pruneExpiredSessions(),
    pruneRateLimits(),
    findExpiredRooms(retentionDays),
  ]);

  return json({
    swept: { sessions, rate_limits: rateLimits },
    retention_days: retentionDays,
    rooms_awaiting_review: expiredRooms,
  });
});
