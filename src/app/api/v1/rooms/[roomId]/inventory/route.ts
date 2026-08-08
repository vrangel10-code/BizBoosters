import { requireAuth } from '@/server/auth/guard';
import { requireEnrollmentInRoom, requireRoomEducator, requireRoomEnrollment } from '@/server/auth/room-guard';
import { listInventory } from '@/server/services/draws';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * A student sees their own inventory. An educator can drill into any student's
 * in a room they teach — the brief's "view the inventory of each student".
 */
export const GET = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth();
    const { roomId } = await context.params;

    if (user.role === 'student') {
      const { enrollment } = await requireRoomEnrollment(user, roomId);
      return json({ enrollment_id: enrollment.id, stacks: await listInventory(enrollment.id) });
    }

    await requireRoomEducator(user, roomId, { allowArchived: true });

    const enrollmentId = new URL(request.url).searchParams.get('enrollment_id');
    if (!enrollmentId) {
      return json({ error_hint: 'Pass ?enrollment_id= to view one student.' }, { status: 400 });
    }

    const enrollment = await requireEnrollmentInRoom(roomId, enrollmentId);
    return json({ enrollment_id: enrollment.id, stacks: await listInventory(enrollment.id) });
  },
);
