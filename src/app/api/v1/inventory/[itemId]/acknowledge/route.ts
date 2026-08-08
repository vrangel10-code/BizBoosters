import { acknowledgeSchema } from '@/lib/validation';
import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { acknowledgeUse } from '@/server/services/card-actions';
import { handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Ticks off a use. Gates nothing; the card is already spent. */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ itemId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { itemId } = await context.params;
    const body = await parseBody(request, acknowledgeSchema);

    await requireRoomEducator(user, body.room_id, { allowArchived: true });
    await acknowledgeUse(user, body.room_id, itemId, body.note ?? null);

    return json({ ok: true });
  },
);
