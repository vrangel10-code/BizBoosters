import { z } from 'zod';
import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { cloneRoom } from '@/server/services/retention';
import { clientIp, created, handle, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ name: z.string().trim().min(1).max(120) });

/** Next term's room, with this term's deck already set up. */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    const { room } = await requireRoomEducator(user, roomId, { allowArchived: true });
    const body = await parseBody(request, bodySchema);

    const clone = await cloneRoom(user, room, body.name, clientIp(request));
    return created({ room: { id: clone.id, name: clone.name, status: clone.status } });
  },
);
