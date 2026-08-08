import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator, requireRoomEnrollment } from '@/server/auth/room-guard';
import { getDeck, getDeckOdds } from '@/server/services/decks';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Live odds, shared by both roles — the same numbers, so a student and their
 * teacher never see different chances.
 *
 * The full deck list (the prototype's "View Full Deck List") is withheld from
 * students when the room turns `students_see_odds` off; the aggregate counts
 * stay, because an empty deck has to be explainable.
 */
export const GET = handle(
  async (_request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth();
    const { roomId } = await context.params;

    if (user.role === 'student') {
      const { room } = await requireRoomEnrollment(user, roomId);
      const odds = await getDeckOdds(room);
      return json({
        odds,
        deck: room.studentsSeeOdds ? await getDeck(roomId) : null,
      });
    }

    const { room } = await requireRoomEducator(user, roomId, { allowArchived: true });
    const [deck, odds] = await Promise.all([getDeck(roomId), getDeckOdds(room)]);
    return json({ odds, deck });
  },
);
