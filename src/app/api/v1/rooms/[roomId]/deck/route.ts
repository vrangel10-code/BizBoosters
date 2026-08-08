import { setDeckSchema } from '@/lib/validation';
import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { getDeck, getDeckOdds, setDeck } from '@/server/services/decks';
import { handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(
  async (_request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    const { room } = await requireRoomEducator(user, roomId, { allowArchived: true });

    const [deck, odds] = await Promise.all([getDeck(roomId), getDeckOdds(room)]);
    return json({ deck, odds });
  },
);

/**
 * Sets the deck by **total** copies. `copies_remaining` is derived — see
 * MECHANICS §3.1 for why an educator must never set it directly.
 */
export const PUT = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    const { room } = await requireRoomEducator(user, roomId);
    const body = await parseBody(request, setDeckSchema);

    const result = await setDeck(user, room, body.entries);
    const odds = await getDeckOdds(room);

    return json({
      applied: result.applied,
      // Non-empty when a requested total was below the copies students already
      // hold; the UI surfaces this rather than pretending the edit was clean.
      capped: result.capped,
      odds,
    });
  },
);
