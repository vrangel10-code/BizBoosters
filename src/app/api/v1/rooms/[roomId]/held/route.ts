import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { heldByStudent } from '@/server/services/card-actions';
import { getDeckOdds } from '@/server/services/decks';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Who is holding what. With a circulating deck an empty deck means hoarding,
 * so this is the screen that explains it.
 */
export const GET = handle(
  async (_request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    const { room } = await requireRoomEducator(user, roomId, { allowArchived: true });

    const [odds, byStudent] = await Promise.all([getDeckOdds(room), heldByStudent(roomId)]);

    return json({
      in_deck: odds.in_deck,
      held: odds.held,
      total: odds.total,
      by_student: byStudent,
    });
  },
);
