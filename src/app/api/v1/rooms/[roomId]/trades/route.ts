import { tradeSchema } from '@/lib/validation';
import { requireStudent } from '@/server/auth/guard';
import { requireRoomEnrollment } from '@/server/auth/room-guard';
import { tradeUp } from '@/server/services/card-actions';
import { getDeckOdds } from '@/server/services/decks';
import { enforceRateLimit } from '@/server/auth/rate-limit';
import { apiError } from '@/server/errors';
import { handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireStudent();
    const { roomId } = await context.params;
    const { room, enrollment } = await requireRoomEnrollment(user, roomId);

    await enforceRateLimit({ key: `trade:${enrollment.id}`, limit: 20, windowMs: 60 * 1000 });

    const body = await parseBody(request, tradeSchema);
    const idempotencyKey =
      request.headers.get('idempotency-key') ?? body.idempotency_key ?? '';
    if (!idempotencyKey) {
      throw apiError('validation_failed', 'An Idempotency-Key header is required.');
    }

    const result = await tradeUp(user, room, enrollment.id, body.item_ids, idempotencyKey);

    return json({
      draw: { id: result.drawId, replayed: result.replayed },
      card: result.card,
      inventory_item_id: result.inventoryItemId,
      consumed: result.consumed,
      odds: await getDeckOdds(room),
    });
  },
);
