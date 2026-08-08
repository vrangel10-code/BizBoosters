import { z } from 'zod';
import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { deleteRoom } from '@/server/services/retention';
import { clientIp, handle, json, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ confirm: z.string().min(1) });

/** Archived rooms only — deleting a live class is never what someone meant. */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    const { room } = await requireRoomEducator(user, roomId, { allowArchived: true });
    const body = await parseBody(request, bodySchema);

    await deleteRoom(user, room, body.confirm, clientIp(request));
    return json({ ok: true });
  },
);
