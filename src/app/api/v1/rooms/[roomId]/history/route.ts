import { requireStudent } from '@/server/auth/guard';
import { requireRoomEnrollment } from '@/server/auth/room-guard';
import { listActivity } from '@/server/services/activity';
import { listTokenTransactions } from '@/server/services/tokens';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * A student's own history, plus room-wide events.
 *
 * The enrolment filter is derived from the session, never from a query
 * parameter — a student cannot ask for someone else's history because there is
 * no input through which to name one.
 */
export const GET = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireStudent();
    const { roomId } = await context.params;
    const { enrollment } = await requireRoomEnrollment(user, roomId);

    const url = new URL(request.url);

    const [{ rows, nextCursor }, ledger] = await Promise.all([
      listActivity({
        roomId,
        subjectEnrollmentId: enrollment.id,
        includeRoomWide: true,
        ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
        limit: Number(url.searchParams.get('limit') ?? 50),
      }),
      listTokenTransactions(enrollment.id, 100),
    ]);

    return json({
      token_balance: enrollment.tokenBalance,
      activity: rows.map((row) => ({
        id: row.id,
        type: row.type,
        created_at: row.createdAt.toISOString(),
        actor_name: row.actorName,
        payload: row.payload,
      })),
      next_cursor: nextCursor,
      ledger: ledger.map((entry) => ({
        id: entry.id,
        delta: entry.delta,
        balance_after: entry.balanceAfter,
        reason: entry.reason,
        note: entry.note,
        awarded_by: entry.actor?.displayName ?? null,
        created_at: entry.createdAt.toISOString(),
        undone: Boolean(entry.reversedBy),
      })),
    });
  },
);
