import { requireAuth } from '@/server/auth/guard';
import { requireEnrollmentInRoom, requireRoomEducator } from '@/server/auth/room-guard';
import { resetStudentPassword } from '@/server/services/students';
import { clientIp, handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Scoped to the room the educator actually teaches, so a valid enrolment ID
 * from another room cannot be used to reset a stranger's password.
 */
export const POST = handle(
  async (
    request: Request,
    context: { params: Promise<{ roomId: string; enrollmentId: string }> },
  ) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId, enrollmentId } = await context.params;
    await requireRoomEducator(user, roomId);

    const enrollment = await requireEnrollmentInRoom(roomId, enrollmentId);
    const credentials = await resetStudentPassword(user, enrollment.studentId, clientIp(request));

    return json({
      credentials: {
        login_id: credentials.loginId,
        default_password: credentials.defaultPassword,
        note: 'Shown once. The student must change this at next login.',
      },
    });
  },
);
