import { awardTokensSchema } from '@/lib/validation';
import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { awardTokens } from '@/server/services/tokens';
import { handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    await requireRoomEducator(user, roomId);

    const body = await parseBody(request, awardTokensSchema);

    const result = await awardTokens({
      actor: user,
      roomId,
      enrollmentIds: body.enrollment_ids,
      amount: body.amount,
      note: body.note ?? null,
    });

    return json({
      batch_id: result.batchId,
      awarded: result.awarded.map((row) => ({
        enrollment_id: row.enrollmentId,
        display_name: row.studentName,
        token_balance: row.balance,
      })),
    });
  },
);
