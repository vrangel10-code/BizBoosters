import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { listRecentUses } from '@/server/services/card-actions';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/** The educator's "perks I still owe" list. */
export const GET = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    await requireRoomEducator(user, roomId, { allowArchived: true });

    const url = new URL(request.url);
    return json({
      data: await listRecentUses(roomId, {
        unacknowledgedOnly: url.searchParams.get('acknowledged') === 'false',
        limit: Number(url.searchParams.get('limit') ?? 50),
      }),
    });
  },
);
