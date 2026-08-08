import { useCardSchema } from '@/lib/validation';
import { requireStudent } from '@/server/auth/guard';
import { requireRoomEnrollment } from '@/server/auth/room-guard';
import { useCard } from '@/server/services/card-actions';
import { getDeckOdds } from '@/server/services/decks';
import { prisma } from '@/server/db';
import { apiError } from '@/server/errors';
import { handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Spend a card. No approval gate — it is spent the moment this returns, and the
 * copy is already back in the deck for everyone else.
 */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ itemId: string }> }) => {
    const { user } = await requireStudent();
    const { itemId } = await context.params;
    const body = await parseBody(request, useCardSchema);

    // The room comes from the item, then the enrolment is re-derived from the
    // session — so possessing an item id from another room grants nothing.
    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) throw apiError('item_not_owned', 'That card is not in your collection.');

    const { room, enrollment } = await requireRoomEnrollment(user, item.roomId);

    const result = await useCard(user, room, enrollment.id, itemId, body.note ?? null);
    const odds = await getDeckOdds(room);

    return json({ item: { id: result.itemId, state: 'used' }, card: result.card, odds });
  },
);
