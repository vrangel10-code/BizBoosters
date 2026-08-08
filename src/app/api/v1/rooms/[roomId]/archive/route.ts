import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { archiveRoom } from '@/server/services/rooms';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = handle(
  async (_request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    const { room } = await requireRoomEducator(user, roomId);

    const archived = await archiveRoom(user, room);
    return json({ room: { id: archived.id, status: archived.status } });
  },
);
