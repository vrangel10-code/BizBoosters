import { z } from 'zod';
import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { grantCard, handsByStudent } from '@/server/services/card-actions';
import { handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

const EDUCATOR_ROLES = ['educator', 'school_admin', 'super_admin'] as const;

/**
 * Every hand in the room. Educator-only, deliberately: students see aggregate
 * deck state but never who is holding what (see docs/MECHANICS.md §7).
 */
export const GET = handle(
  async (_request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: [...EDUCATOR_ROLES] });
    const { roomId } = await context.params;
    await requireRoomEducator(user, roomId, { allowArchived: true });

    return json({ data: await handsByStudent(roomId) });
  },
);

const grantSchema = z.object({
  enrollment_id: z.string().uuid(),
  card_id: z.string().uuid(),
});

/** Hand a card from the deck to one student. */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: [...EDUCATOR_ROLES] });
    const { roomId } = await context.params;
    const { room } = await requireRoomEducator(user, roomId);
    const body = await parseBody(request, grantSchema);

    const result = await grantCard(user, room, body.enrollment_id, body.card_id);
    return json({ item_id: result.itemId, card: result.card });
  },
);
