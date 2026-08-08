import { requireStudent } from '@/server/auth/guard';
import { requireRoomEnrollment } from '@/server/auth/room-guard';
import { returnCard } from '@/server/services/card-actions';
import { getDeckOdds } from '@/server/services/decks';
import { prisma } from '@/server/db';
import { apiError } from '@/server/errors';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Give an unused copy back to the deck for nothing. */
export const POST = handle(
  async (_request: Request, context: { params: Promise<{ itemId: string }> }) => {
    const { user } = await requireStudent();
    const { itemId } = await context.params;

    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) throw apiError('item_not_owned', 'That card is not in your collection.');

    const { room, enrollment } = await requireRoomEnrollment(user, item.roomId);
    const result = await returnCard(user, room, enrollment.id, itemId);

    return json({
      item: { id: result.itemId, state: 'returned' },
      card: result.card,
      odds: await getDeckOdds(room),
    });
  },
);
