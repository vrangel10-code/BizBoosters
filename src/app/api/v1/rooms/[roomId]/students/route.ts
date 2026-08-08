import { addStudentsSchema, createStudentSchema } from '@/lib/validation';
import { requireAuth, requireSchoolScope } from '@/server/auth/guard';
import { requireRoomEducator } from '@/server/auth/room-guard';
import { addExistingStudents, createAndEnrollStudent, listRoster } from '@/server/services/roster';
import { clientIp, created, handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

export const GET = handle(
  async (_request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const { roomId } = await context.params;
    await requireRoomEducator(user, roomId, { allowArchived: true });

    return json({ data: await listRoster(roomId) });
  },
);

/**
 * Two shapes on one route: create a brand-new student and enrol them, or enrol
 * students who already exist elsewhere in the school. The second matters
 * because a student in two classes is one account with two enrolments, not two
 * accounts.
 */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ roomId: string }> }) => {
    const { user } = await requireAuth({ roles: ['educator', 'school_admin', 'super_admin'] });
    const schoolId = requireSchoolScope(user);
    const { roomId } = await context.params;
    await requireRoomEducator(user, roomId);

    const raw: unknown = await request.json().catch(() => ({}));
    const ip = clientIp(request);

    if (raw && typeof raw === 'object' && 'student_ids' in raw) {
      const body = addStudentsSchema.parse(raw);
      const roster = await addExistingStudents({
        actor: user,
        roomId,
        studentIds: body.student_ids,
        ip,
      });
      return json({ data: roster });
    }

    const body = createStudentSchema.parse(raw);
    const result = await createAndEnrollStudent({
      actor: user,
      schoolId,
      roomId,
      displayName: body.display_name,
      loginId: body.login_id ?? null,
      ip,
    });

    return created({
      student: {
        id: result.userId,
        enrollment_id: result.enrollmentId,
        display_name: result.displayName,
        login_id: result.loginId,
      },
      credentials: {
        login_id: result.loginId,
        default_password: result.defaultPassword,
        note: 'Shown once. The student must change this at first login.',
      },
    });
  },
);
