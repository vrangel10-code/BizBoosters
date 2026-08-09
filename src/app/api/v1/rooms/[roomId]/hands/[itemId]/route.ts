import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { revokeCard } from '@/server/services/card-actions';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Take a card back off a student; the copy returns to the deck. */
export const DELETE = handle(
  async (
    _request: Request,
    context: { params: Promise<{ roomId: string; itemId: string }> },
  ) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId, itemId } = await context.params;
    const { room } = await requireRoomEducator(user, roomId);

    const result = await revokeCard(user, room, itemId);
    return json({ item_id: result.itemId, card: result.card });
  },
);
