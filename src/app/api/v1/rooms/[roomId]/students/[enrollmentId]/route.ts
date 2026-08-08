import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { removeStudent } from '@/server/services/roster';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Soft removal: history and ledger are retained. */
export const DELETE = handle(
  async (
    _request: Request,
    context: { params: Promise<{ roomId: string; enrollmentId: string }> },
  ) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId, enrollmentId } = await context.params;
    await requireRoomEducator(user, roomId);

    await removeStudent(user, roomId, enrollmentId);
    return json({ ok: true });
  },
);
