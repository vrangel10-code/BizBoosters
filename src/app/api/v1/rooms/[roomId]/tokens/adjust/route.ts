import { adjustTokensSchema } from '@/lib/validation';
import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { adjustTokens } from '@/server/services/tokens';
import { handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * The "edit tokens achieved" action. It appends a compensating ledger row with
 * a mandatory reason rather than writing the balance, so the history still
 * answers "why do I have 40 when I earned 60".
 */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    await requireRoomEducator(user, roomId);

    const body = await parseBody(request, adjustTokensSchema);

    const result = await adjustTokens({
      actor: user,
      roomId,
      enrollmentId: body.enrollment_id,
      delta: body.delta,
      targetBalance: body.target_balance,
      note: body.note,
    });

    return json({ token_balance: result.balance, delta: result.delta });
  },
);
