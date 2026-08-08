import { resetDeckSchema } from '@/lib/validation';
import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { getDeckOdds, resetDeck } from '@/server/services/decks';
import { handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Reset Deck. Educator-only, enforced here rather than by hiding a button, and
 * gated on typing the room name — it is irreversible and it wipes every
 * student's collection.
 */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    const { room } = await requireRoomEducator(user, roomId);
    const body = await parseBody(request, resetDeckSchema);

    const result = await resetDeck(user, room, body.confirm);
    const odds = await getDeckOdds(room);

    return json({
      cards_refilled: result.cardsRefilled,
      copies_returned: result.copiesReturned,
      odds,
    });
  },
);
