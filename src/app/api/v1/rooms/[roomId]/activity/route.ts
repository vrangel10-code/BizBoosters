import { requireAuth } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { listActivity } from '@/server/services/activity';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/** The educator's room-wide log. Students use /history instead. */
export const GET = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    await requireRoomEducator(user, roomId, { allowArchived: true });

    const url = new URL(request.url);
    const enrollmentId = url.searchParams.get('enrollment_id');
    const type = url.searchParams.get('type');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    const { rows, nextCursor } = await listActivity({
      roomId,
      ...(enrollmentId ? { subjectEnrollmentId: enrollmentId } : {}),
      ...(type ? { type } : {}),
      ...(from ? { from: new Date(from) } : {}),
      ...(to ? { to: new Date(to) } : {}),
      ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
      limit: Number(url.searchParams.get('limit') ?? 50),
    });

    return json({
      data: rows.map((row) => ({
        id: row.id,
        type: row.type,
        created_at: row.createdAt.toISOString(),
        actor_name: row.actorName,
        student_name: row.subjectName,
        enrollment_id: row.subjectEnrollmentId,
        payload: row.payload,
      })),
      next_cursor: nextCursor,
    });
  },
);
