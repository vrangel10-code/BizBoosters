import { z } from 'zod';
import { requireStudent } from '@/server/auth/guard';
import { requireRoomEnrollment } from '@/server/auth/room-guard';
import { drawCard } from '@/server/services/draws';
import { getDeckOdds } from '@/server/services/decks';
import { enforceRateLimit } from '@/server/auth/rate-limit';
import { apiError } from '@/server/errors';
import { handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  idempotency_key: z.string().uuid().optional(),
});

/**
 * The draw. The acting enrolment comes from the session and the room in the
 * path — a student cannot name someone else's enrolment because there is no
 * input through which to do it.
 */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireStudent();
    const { roomId } = await context.params;
    const { room, enrollment } = await requireRoomEnrollment(user, roomId);

    // Cheap protection against a held-down button; the idempotency key handles
    // honest double-clicks, this handles scripted ones.
    await enforceRateLimit({
      key: `draw:${enrollment.id}`,
      limit: 20,
      windowMs: 60 * 1000,
    });

    const body = await parseBody(request, bodySchema);
    const idempotencyKey =
      request.headers.get('idempotency-key') ?? body.idempotency_key ?? '';

    if (!idempotencyKey) {
      throw apiError(
        'validation_failed',
        'An Idempotency-Key header is required so a retry cannot charge you twice.',
      );
    }

    const result = await drawCard({
      actor: user,
      room,
      enrollmentId: enrollment.id,
      idempotencyKey,
    });

    const odds = await getDeckOdds(room);

    return json({
      draw: { id: result.drawId, replayed: result.replayed },
      card: result.card,
      inventory_item_id: result.inventoryItemId,
      token_balance: result.tokenBalance,
      token_cost: result.tokenCost,
      odds,
    });
  },
);
